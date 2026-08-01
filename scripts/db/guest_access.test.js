// Регресс-тест на 0016_guest_access: при выключенном свитче anon не видит ничего нового; при
// включённом — видит races/drivers/results/scores/users(id,display_name)/predictions только
// после дедлайна гонки, но НЕ до дедлайна и НЕ полные колонки users; anon нигде не может писать.
// Всё внутри begin...rollback, продакшн не меняется.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const A = '88888888-8888-8888-8888-888888880001';
const ADMIN = '99999999-9999-9999-9999-999999999999';
const R1 = 900000401; // open, дедлайн в будущем -> прогноз должен остаться скрыт даже при свитче ON
const R2 = 900000402; // resulted, дедлайн в прошлом -> прогноз виден при свитче ON
const perfect = JSON.stringify(Array.from({length:10},(_,i)=>`d${i+1}`));

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
  create temp table _guest(name text, passed boolean, info text) on commit drop;

  insert into drivers(id,code,name) select 'd'||g,'D'||g,'Drv'||g from generate_series(1,10) g;
  insert into auth.users(id,email) values('${A}','guest-a@t.io'),('${ADMIN}','guest-admin@t.io');
  insert into users(id,display_name,telegram_username,is_admin) values
    ('${A}','GuestTestUser','secret_tg_handle',false),
    ('${ADMIN}','GuestTestAdmin',null,true);
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R1},9401,'GuestOpen', now()+interval '2 days','open'),
    (${R2},9402,'GuestClosed', now()-interval '1 day','resulted');
  insert into race_driver_pool(race_id,driver_id)
    select r,'d'||g from (values(${R1}),(${R2})) v(r) cross join generate_series(1,10) g;
  insert into results(race_id,positions,status) values(${R2},'${perfect}'::jsonb,'final');
  insert into predictions(user_id,race_id,positions) values
    ('${A}',${R1},'${perfect}'::jsonb),('${A}',${R2},'${perfect}'::jsonb);

  -- ===== Свитч OFF =====
  update app_settings set value=false where key='guest_access_enabled';
  perform set_config('request.jwt.claims', null, true);
  execute 'set local role anon';

  select count(*) into n from races where id in (${R1},${R2});
  names:=array_append(names,'off: races hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from drivers where id in ('d1','d2','d3','d4','d5','d6','d7','d8','d9','d10');
  names:=array_append(names,'off: drivers hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from results where race_id=${R2};
  names:=array_append(names,'off: results hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from predictions where race_id=${R2};
  names:=array_append(names,'off: predictions hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from users where id='${A}';
  names:=array_append(names,'off: users hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from scores where race_id=${R2};
  names:=array_append(names,'off: scores hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);

  reset role;

  -- ===== Свитч ON =====
  update app_settings set value=true where key='guest_access_enabled';
  perform set_config('request.jwt.claims', null, true);
  execute 'set local role anon';

  select count(*) into n from races where id in (${R1},${R2});
  names:=array_append(names,'on: races visible'); passed:=array_append(passed,(n=2)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from drivers where id in ('d1','d2','d3','d4','d5','d6','d7','d8','d9','d10');
  names:=array_append(names,'on: drivers visible'); passed:=array_append(passed,(n=10)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from results where race_id=${R2};
  names:=array_append(names,'on: results visible'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from predictions where race_id=${R2} and user_id='${A}';
  names:=array_append(names,'on: predictions after deadline visible'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from predictions where race_id=${R1} and user_id='${A}';
  names:=array_append(names,'on: predictions before deadline still hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from users where id='${A}';
  names:=array_append(names,'on: users id+display_name visible'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from scores where race_id=${R2} and user_id='${A}';
  names:=array_append(names,'on: scores after-deadline visible via view'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from scores where race_id=${R1} and user_id='${A}';
  names:=array_append(names,'on: scores before-deadline hidden via view'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);

  ${tryThrow('on: users telegram_username column blocked', `select telegram_username from users where id='${A}'`)}
  ${tryThrow('on: anon insert races blocked', `insert into races(round,name,deadline_utc) values(9999,'x',now())`)}
  ${tryThrow('on: anon insert predictions blocked', `insert into predictions(user_id,race_id,positions) values('${A}',${R2},'${perfect}'::jsonb)`)}
  ${tryThrow('on: anon update users blocked', `update users set display_name='hack' where id='${A}'`)}
  ${tryThrow('on: anon select race_driver_pool blocked', `select 1 from race_driver_pool where race_id=${R2} limit 1`)}
  ${tryThrow('on: anon set_guest_access blocked', `select public.set_guest_access(false)`)}

  reset role;

  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin
    perform public.set_guest_access(false);
    names:=array_append(names,'set_guest_access: non-admin blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ отклонено — выполнилось!');
  exception when others then
    names:=array_append(names,'set_guest_access: non-admin blocked');
    passed:=array_append(passed, sqlerrm like '%admin only%');
    infos:=array_append(infos, sqlerrm);
  end;
  reset role;

  perform set_config('request.jwt.claims','{"sub":"${ADMIN}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin
    perform public.set_guest_access(false);
    names:=array_append(names,'set_guest_access: admin succeeds'); passed:=array_append(passed,true); infos:=array_append(infos,'ok');
  exception when others then
    names:=array_append(names,'set_guest_access: admin succeeds'); passed:=array_append(passed,false); infos:=array_append(infos,sqlerrm);
  end;
  reset role;

  -- ===== Регрессия: участник по-прежнему видит свой прогноз до дедлайна =====
  update app_settings set value=true where key='guest_access_enabled';
  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into n from predictions where race_id=${R1} and user_id='${A}';
  names:=array_append(names,'regression: member still sees own pre-deadline prediction'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  reset role;

  insert into _guest select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _guest order by name;
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
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/23) ===`);
  process.exit(fail===0&&rows.length===23?0:1);
})();
