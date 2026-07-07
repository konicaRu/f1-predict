// open_race.test.js — снимок пула только активных, идемпотентность, гейт прав, защита resulted.
// Транзакция -> rollback (облако чистое). Стиль как membership.test.js.
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const ADMIN='55555555-5555-5555-5555-555555555555';
const USER ='66666666-6666-6666-6666-666666666666';
const SQL=`
begin;
set local statement_timeout='25s';
do $$
declare
  v_race bigint; v_resulted bigint;
  v_active int; v_pool int; v_idem int; v_hasinactive int;
  v_reopen_blocked boolean := false; v_nonadmin_blocked boolean := false;
begin
  insert into auth.users(id,email) values ('${ADMIN}','admin-or@t.io'),('${USER}','user-or@t.io');
  insert into public.users(id,display_name,is_admin) values ('${ADMIN}','Admin',true),('${USER}','User',false);
  insert into public.drivers(id,code,name,active) values ('_or_inactive','ZZZ','Inactive',false)
    on conflict (id) do update set active=false;
  select count(*) into v_active from drivers where active;

  insert into races(season,round,name,deadline_utc,status)
    values (2026,9901,'OR Demo', now()+interval '10 days','demo') returning id into v_race;
  insert into races(season,round,name,deadline_utc,status)
    values (2026,9902,'OR Resulted', now()-interval '1 day','resulted') returning id into v_resulted;

  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  select public.open_race(v_race) into v_pool;
  select public.open_race(v_race) into v_idem;
  execute 'reset role';

  select count(*) into v_hasinactive from race_driver_pool where race_id=v_race and driver_id='_or_inactive';

  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  begin perform public.open_race(v_resulted); exception when others then v_reopen_blocked := true; end;
  execute 'reset role';

  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${USER}'), true);
  execute 'set local role authenticated';
  begin perform public.open_race(v_race); exception when others then v_nonadmin_blocked := true; end;
  execute 'reset role';

  create temp table _or(active int, pool int, idem int, hasinactive int,
    reopen_blocked boolean, nonadmin_blocked boolean, status text) on commit drop;
  insert into _or select v_active, v_pool, v_idem, v_hasinactive, v_reopen_blocked, v_nonadmin_blocked,
    (select status from races where id=v_race);
end $$;
select * from _or;
rollback;`;
function pick(r){const a=Array.isArray(r)?r:[r];const x=a.reverse().find(y=>y.rows&&y.rows.length);return x?x.rows:[];}
async function killOrphans(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false}});c.on('error',()=>{});try{await c.connect();await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}finally{try{await c.end();}catch(_){}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function once(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});c.on('error',()=>{});await c.connect();try{return pick(await c.query(SQL));}finally{try{await c.end();}catch(_){}}}
(async()=>{let rows;for(let a=1;a<=5;a++){try{rows=await once();break;}catch(e){console.error(`attempt ${a}/5: ${e.message}`);if(a===5)process.exit(1);await killOrphans();await sleep(2000*a);}}
  const r=rows[0];
  const checks=[
    ['снимок = все активные', Number(r.pool)===Number(r.active)],
    ['идемпотентность', Number(r.idem)===Number(r.pool)],
    ['неактивный не в пуле', Number(r.hasinactive)===0],
    ['статус стал open', r.status==='open'],
    ['resulted не переоткрыть', r.reopen_blocked===true],
    ['не-админ заблокирован', r.nonadmin_blocked===true],
  ];
  const ok=checks.every(c=>c[1]);
  for(const [name,pass] of checks) console.log(`  ${pass?'ok':'XX'}  ${name}`);
  console.log(`${ok?'PASS':'FAIL'}  open_race (pool=${r.pool}, active=${r.active})`);
  process.exit(ok?0:1);
})();
