// Регресс-тест на 0013_revoke_public_execute: анон не должен иметь EXECUTE на
// admin-only/security-definer функциях (open_race, set_race_result,
// predicted_user_ids), а обычный залогиненный пользователь и админ — работать
// как раньше. Всё внутри begin...rollback, продакшн не меняется.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const ADMIN = '66666666-6666-6666-6666-666666666666';
const USER = '77777777-7777-7777-7777-777777777777';
const R = 900000202;

const SQL = `
begin;
set local statement_timeout='25s';
do $$
declare
  names text[]:='{}'; passed boolean[]:='{}'; infos text[]:='{}';
begin
  create temp table _t3(name text, passed boolean, info text) on commit drop;

  insert into auth.users(id,email) values('${ADMIN}','sec-admin2@t.io'),('${USER}','sec-user2@t.io');
  insert into users(id,display_name,is_admin) values('${ADMIN}','SecAdmin2',true),('${USER}','SecUser2',false);
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R}, 9202, 'SecTest2', now()+interval '2 days', 'demo');

  perform set_config('request.jwt.claims', null, true);
  execute 'set local role anon';

  begin
    perform public.open_race(${R});
    names:=array_append(names,'anon open_race blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ заблокировано!');
  exception when insufficient_privilege then
    names:=array_append(names,'anon open_race blocked'); passed:=array_append(passed,true); infos:=array_append(infos,'insufficient_privilege');
  when others then
    names:=array_append(names,'anon open_race blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'неожиданно: '||sqlerrm);
  end;

  begin
    perform public.set_race_result(${R}, '[]'::jsonb, 'test');
    names:=array_append(names,'anon set_race_result blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ заблокировано!');
  exception when insufficient_privilege then
    names:=array_append(names,'anon set_race_result blocked'); passed:=array_append(passed,true); infos:=array_append(infos,'insufficient_privilege');
  when others then
    names:=array_append(names,'anon set_race_result blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'неожиданно: '||sqlerrm);
  end;

  begin
    perform (select array_agg(x) from public.predicted_user_ids(${R}) as x);
    names:=array_append(names,'anon predicted_user_ids blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ заблокировано!');
  exception when insufficient_privilege then
    names:=array_append(names,'anon predicted_user_ids blocked'); passed:=array_append(passed,true); infos:=array_append(infos,'insufficient_privilege');
  when others then
    names:=array_append(names,'anon predicted_user_ids blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'неожиданно: '||sqlerrm);
  end;

  reset role;

  perform set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.open_race(${R});
    names:=array_append(names,'authenticated non-admin still app-level rejected'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ отклонено — выполнилось!');
  exception when others then
    names:=array_append(names,'authenticated non-admin still app-level rejected');
    passed:=array_append(passed, sqlerrm like '%admin only%');
    infos:=array_append(infos, sqlerrm);
  end;
  reset role;

  perform set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
  execute 'set local role authenticated';
  begin
    perform public.open_race(${R});
    names:=array_append(names,'authenticated admin open_race succeeds'); passed:=array_append(passed,true); infos:=array_append(infos,'ok');
  exception when others then
    names:=array_append(names,'authenticated admin open_race succeeds'); passed:=array_append(passed,false); infos:=array_append(infos,sqlerrm);
  end;

  begin
    perform (select array_agg(x) from public.predicted_user_ids(${R}) as x);
    names:=array_append(names,'authenticated predicted_user_ids still works'); passed:=array_append(passed,true); infos:=array_append(infos,'ok');
  exception when others then
    names:=array_append(names,'authenticated predicted_user_ids still works'); passed:=array_append(passed,false); infos:=array_append(infos,sqlerrm);
  end;
  reset role;

  insert into _t3 select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _t3 order by name;
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
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/6) ===`);
  process.exit(fail===0&&rows.length===6?0:1);
})();
