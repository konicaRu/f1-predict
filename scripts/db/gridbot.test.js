// Тест миграции 0014: аккаунт GridBot существует, его прогноз проходит те же серверные проверки
// (validate_prediction), что и прогноз обычного игрока — без реального обращения к Gemini/Jolpica.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const GRIDBOT_ID = '8093e42f-cc5e-4c18-8aa8-2dfa50e972c1';
const R = 900000301; // высокий id, чтобы не конфликтовать с реальными гонками

const SQL = `
begin;
set local statement_timeout='25s';
do $$
declare
  n int; names text[]:='{}'; passed boolean[]:='{}'; infos text[]:='{}';
begin
  create temp table _t4(name text, passed boolean, info text) on commit drop;

  select count(*) into n from public.users where id='${GRIDBOT_ID}' and display_name='GridBot' and is_admin=false;
  names:=array_append(names,'GridBot существует в users'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'найдено='||n);

  insert into drivers(id,code,name) select 'gb'||g,'GB'||g,'Drv'||g from generate_series(1,10) g
    on conflict (id) do nothing;
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R},9301,'GridBotTest',now()+interval '2 days','open');
  insert into race_driver_pool(race_id,driver_id) select ${R},'gb'||g from generate_series(1,10) g;

  begin
    insert into predictions(user_id,race_id,positions) values
      ('${GRIDBOT_ID}',${R}, (select jsonb_agg('gb'||g order by g) from generate_series(1,10) g));
    names:=array_append(names,'прогноз GridBot проходит validate_prediction'); passed:=array_append(passed,true); infos:=array_append(infos,'ok');
  exception when others then
    names:=array_append(names,'прогноз GridBot проходит validate_prediction'); passed:=array_append(passed,false); infos:=array_append(infos,sqlerrm);
  end;

  insert into _t4 select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _t4 order by name;
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
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/2) ===`);
  process.exit(fail===0&&rows.length===2?0:1);
})();
