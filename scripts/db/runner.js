// Cloud-direct раннер: применяет миграции к облаку Supabase ПОСТЕЙТМЕНТНО (устойчиво к флапу сети).
//   node runner.js sql "select 1"
//   node runner.js applyfile <abs.sql>
//   node runner.js rebuild
// Читает SUPABASE_DB_URL из <project-root>/.env (session pooler). См. scripts/db/README.md.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROJECT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(PROJECT, 'supabase', 'migrations');

function connStr() {
  const env = fs.readFileSync(path.join(PROJECT, '.env'), 'utf8');
  const m = env.match(/^SUPABASE_DB_URL=(.+)$/m);
  if (!m) throw new Error('SUPABASE_DB_URL не найден в .env');
  return m[1].trim();
}

const DROP_SQL = `
drop view if exists public.scores cascade;
drop table if exists public.result_changes cascade;
drop table if exists public.results cascade;
drop table if exists public.predictions cascade;
drop table if exists public.race_driver_pool cascade;
drop table if exists public.races cascade;
drop table if exists public.drivers cascade;
drop table if exists public.users cascade;
drop function if exists public.score_prediction(jsonb, jsonb) cascade;
drop function if exists public.is_admin() cascade;
drop function if exists public.validate_prediction() cascade;
`;

// Разбивка на стейтменты с учётом $$-долларных кавычек (тело функций) и --комментариев.
function splitStatements(sql) {
  const out = []; let buf = ''; let i = 0; let dollarTag = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (!dollarTag && ch === '-' && sql[i+1] === '-') {
      const nl = sql.indexOf('\n', i); buf += sql.slice(i, nl === -1 ? sql.length : nl); i = nl === -1 ? sql.length : nl; continue;
    }
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (m) { const tag = m[0]; if (!dollarTag) dollarTag = tag; else if (dollarTag === tag) dollarTag = null; buf += tag; i += tag.length; continue; }
    }
    if (ch === ';' && !dollarTag) { const s = buf.trim(); if (s) out.push(s); buf = ''; i++; continue; }
    buf += ch; i++;
  }
  const tail = buf.trim(); if (tail) out.push(tail);
  return out;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function isTransient(e){ return e.code === undefined || e.code === '57014'; }
const DUP = new Set(['42P07','42710','42723','42P06','42701','42P16','42P04']);

let client = null;
async function ensure(){
  if (client) return client;
  client = new Client({ connectionString: connStr(), ssl:{rejectUnauthorized:false}, connectionTimeoutMillis:20000, keepAlive:true });
  client.on('error', ()=>{ client = null; });
  await client.connect();
  return client;
}
async function exec(text){
  for (let a=1;a<=6;a++){
    try { const c = await ensure(); return await c.query(text); }
    catch(e){
      try{ if(client) await client.end(); }catch(_){}
      client = null;
      if (a>1 && DUP.has(e.code)) return { _dup:true };
      if (isTransient(e) && a<6){ await sleep(1200*a); continue; }
      throw e;
    }
  }
}
async function runStatements(stmts, label){
  let dup=0; for (const s of stmts){ const r = await exec(s); if (r && r._dup) dup++; }
  console.log(`applied: ${label} (${stmts.length} stmts${dup?`, ${dup} уже были`:''})`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'sql') {
    const r = await exec(arg);
    const rows = Array.isArray(r) ? (r.reverse().find(x=>x.rows&&x.rows.length)||{rows:[]}).rows : (r.rows||[]);
    console.log(JSON.stringify(rows, null, 2));
  } else if (cmd === 'applyfile') {
    await runStatements(splitStatements(fs.readFileSync(arg,'utf8')), path.basename(arg));
  } else if (cmd === 'rebuild') {
    const files = fs.readdirSync(MIGRATIONS).filter(f=>f.endsWith('.sql')).sort();
    await runStatements(splitStatements(DROP_SQL), 'drop my objects');
    for (const f of files) await runStatements(splitStatements(fs.readFileSync(path.join(MIGRATIONS,f),'utf8')), f);
    console.log('rebuild OK ('+files.length+' migrations)');
  } else { console.error('usage: sql|applyfile|rebuild'); process.exit(2); }
  if (client) await client.end();
}
main().catch(async e => { console.error('ERR', e.code||'', e.message); try{if(client)await client.end();}catch(_){} process.exit(1); });
