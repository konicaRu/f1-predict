const fs = require('fs'); const path = require('path');
const { Client } = require('pg');

function connStr(){
  const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
  const m = env.match(/^SUPABASE_DB_URL=(.+)$/m);
  if(!m) throw new Error('SUPABASE_DB_URL не найден в .env');
  return m[1].trim();
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const transient = e => e.code===undefined || e.code==='57014' ||
  /terminated|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|network/i.test(e.message||'');

// Jolpica REST с ретраем. path пример: '2026/drivers'
async function fetchJolpica(p){
  const url = `https://api.jolpi.ca/ergast/f1/${p}.json?limit=100`;
  for(let a=1;a<=5;a++){
    try{
      const res = await fetch(url, { headers:{'accept':'application/json'} });
      if(!res.ok) throw new Error('HTTP '+res.status);
      return await res.json();
    }catch(e){ if(a===5) throw e; await sleep(800*a); }
  }
}

// Персистентный pg-клиент с переподключением; q() ретраит транзиентные обрывы.
let client=null;
async function ensure(){
  if(client) return client;
  client = new Client({ connectionString:connStr(), ssl:{rejectUnauthorized:false}, connectionTimeoutMillis:20000, keepAlive:true });
  client.on('error',()=>{ client=null; });
  await client.connect();
  return client;
}
async function q(text, params){
  for(let a=1;a<=6;a++){
    try{ const c=await ensure(); return await c.query(text, params); }
    catch(e){ try{ if(client) await client.end(); }catch(_){}; client=null;
      if(!transient(e)||a===6) throw e; await sleep(1200*a); }
  }
}
async function close(){ if(client){ try{await client.end();}catch(_){}; client=null; } }

module.exports = { fetchJolpica, q, close };
