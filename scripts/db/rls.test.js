// RLS-тесты Фазы 0 (критерий готовности, spec §7) — ВЕСЬ тест одним запросом (DO-блок).
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const A='11111111-1111-1111-1111-111111111111';
const B='22222222-2222-2222-2222-222222222222';
const AD='33333333-3333-3333-3333-333333333333';
const perfect = JSON.stringify(Array.from({length:10},(_,i)=>`d${i+1}`));
const dup     = JSON.stringify(['d1','d1','d2','d3','d4','d5','d6','d7','d8','d9']);
const notPool = JSON.stringify(['d1','d2','d3','d4','d5','d6','d7','d8','d9','d11']);
// высокие id/round, чтобы не конфликтовать с реальными гонками из импорта (Фаза 1)
const R1=900000001, R2=900000002;

function tryThrow(name, stmt){ return `
  begin ${stmt};
    names:=array_append(names,'${name}'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ упало');
  exception when others then
    names:=array_append(names,'${name}'); passed:=array_append(passed,true); infos:=array_append(infos,'отказ '||sqlstate);
  end;`;
}
const SQL = `
begin;
set local statement_timeout='25s';
do $$
declare n int; names text[]:='{}'; passed boolean[]:='{}'; infos text[]:='{}';
begin
  create temp table _rls(name text, passed boolean, info text) on commit drop;
  insert into drivers(id,code,name) select 'd'||g,'D'||g,'Drv'||g from generate_series(1,11) g;
  insert into auth.users(id,email) values('${A}','a@t.io'),('${B}','b@t.io'),('${AD}','ad@t.io');
  insert into users(id,display_name,is_admin) values('${A}','A',false),('${B}','B',false),('${AD}','Adm',true);
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R1},9001,'Open',now()+interval '2 days','open'),(${R2},9002,'Closed',now()-interval '1 day','resulted');
  insert into race_driver_pool(race_id,driver_id)
    select r,'d'||g from (values(${R1}),(${R2})) v(r) cross join generate_series(1,10) g;
  insert into results(race_id,positions,status) values(${R2},'${perfect}'::jsonb,'final');
  insert into predictions(user_id,race_id,positions) values('${B}',${R1},'${perfect}'::jsonb),('${B}',${R2},'${perfect}'::jsonb);

  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';

  select count(*) into n from predictions where race_id=${R1} and user_id<>'${A}';
  names:=array_append(names,'1'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно чужих='||n);
  select count(*) into n from predictions where race_id=${R2} and user_id='${B}';
  names:=array_append(names,'1b'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно чужих='||n);
  ${tryThrow('2',  `insert into predictions(user_id,race_id,positions) values('${A}',${R2},'${perfect}'::jsonb)`)}
  ${tryThrow('3a', `insert into predictions(user_id,race_id,positions) values('${A}',${R1},'${dup}'::jsonb)`)}
  ${tryThrow('3b', `insert into predictions(user_id,race_id,positions) values('${A}',${R1},'${notPool}'::jsonb)`)}
  ${tryThrow('4',  `insert into results(race_id,positions) values(${R1},'${perfect}'::jsonb)`)}
  ${tryThrow('5',  `update users set is_admin=true where id='${A}'`)}

  reset role;
  insert into _rls select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _rls order by name;
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
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/7) ===`);
  process.exit(fail===0&&rows.length===7?0:1);
})();
