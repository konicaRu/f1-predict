// Тест safety-критичной функции predicted_user_ids: должна обходить RLS-скрытие
// чужих прогнозов узко (отдаёт user_id, НЕ positions). Проверяем и обход, и то, что
// сама таблица predictions по-прежнему скрыта напрямую для того же пользователя.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const A='44444444-4444-4444-4444-444444444444';
const B='55555555-5555-5555-5555-555555555555';
const perfect = JSON.stringify(Array.from({length:10},(_,i)=>`e${i+1}`));
const R = 900000101; // высокий id, чтобы не конфликтовать с реальными гонками

const SQL = `
begin;
set local statement_timeout='25s';
do $$
declare n int; secdef boolean; voted uuid[]; names text[]:='{}'; passed boolean[]:='{}'; infos text[]:='{}';
begin
  create temp table _t(name text, passed boolean, info text) on commit drop;
  insert into drivers(id,code,name) select 'e'||g,'E'||g,'Drv'||g from generate_series(1,10) g;
  insert into auth.users(id,email) values('${A}','pu-a@t.io'),('${B}','pu-b@t.io');
  insert into users(id,display_name,is_admin) values('${A}','A',false),('${B}','B',false);
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R},9101,'Open',now()+interval '2 days','open');
  insert into race_driver_pool(race_id,driver_id) select ${R},'e'||g from generate_series(1,10) g;
  insert into predictions(user_id,race_id,positions) values('${B}',${R},'${perfect}'::jsonb);

  select prosecdef into secdef from pg_proc where proname='predicted_user_ids';
  names:=array_append(names,'is security definer'); passed:=array_append(passed,secdef is true); infos:=array_append(infos,'prosecdef='||secdef);

  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';

  select count(*) into n from predictions where race_id=${R} and user_id<>'${A}';
  names:=array_append(names,'raw table still hides others'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно чужих напрямую='||n);

  select array_agg(user_id) into voted from public.predicted_user_ids(${R}) as user_id;
  names:=array_append(names,'function surfaces voter despite RLS'); passed:=array_append(passed,(voted=array['${B}']::uuid[])); infos:=array_append(infos,'voted='||voted::text);

  reset role;
  insert into _t select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _t order by name;
rollback;
`;
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function pickRows(res){ const arr=Array.isArray(res)?res:[res]; const r=arr.reverse().find(x=>x.rows&&x.rows.length); return r?r.rows:[]; }
async function killOrphans(){
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000}); c.on('error',()=>{});
  try{await c.connect(); await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}
  finally{try{await c.end();}catch(_){}}
}
async function once(){
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true}); c.on('error',()=>{});
  await c.connect();
  try{ return pickRows(await c.query(SQL)); } finally{ try{await c.end();}catch(_){} }
}
(async()=>{
  let rows;
  for(let a=1;a<=6;a++){
    try{ rows=await once(); break; }
    catch(e){ console.error(`attempt ${a}/6: ${e.code||''} ${e.message}`); if(a===6){console.error('сдаюсь');process.exit(1);} await killOrphans(); await sleep(2000*a); }
  }
  let pass=0,fail=0;
  for(const r of rows){ const ok=r.passed===true; ok?pass++:fail++; console.log(`${ok?'PASS':'FAIL'}  ${r.name}  — ${r.info}`); }
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/3) ===`);
  process.exit(fail===0&&rows.length===3?0:1);
})();
