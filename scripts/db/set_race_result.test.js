// set_race_result.test.js — гейт админа, валидация состава, журнал, scored/status, override, сквозной скоринг.
// Транзакция -> rollback. Стиль как open_race.test.js.
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const ADMIN='77777777-7777-7777-7777-777777777777';
const USER ='88888888-8888-8888-8888-888888888888';
const SQL=`
begin;
set local statement_timeout='25s';
do $$
declare
  v_race bigint;
  actual jsonb; actual2 jsonb; actual9 jsonb; actualdup jsonb; actualpool jsonb;
  rc1 int; rc2 int; v_points int;
  v_res_status text; v_race_status text; v_scored boolean; v_res_match boolean;
  not10 boolean:=false; dup boolean:=false; pool boolean:=false; nonadmin boolean:=false;
begin
  -- fixtures
  insert into auth.users(id,email) values ('${ADMIN}','a-sr@t.io'),('${USER}','u-sr@t.io');
  insert into public.users(id,display_name,is_admin) values ('${ADMIN}','A',true),('${USER}','U',false);
  insert into public.drivers(id,code,name,active)
    select '_tr'||lpad(g::text,2,'0'), 'T'||g, 'Test '||g, true from generate_series(1,12) g;
  insert into races(season,round,name,deadline_utc,status,scored)
    values (2026,9911,'SR Test', now()-interval '1 day','open',false) returning id into v_race;
  insert into race_driver_pool(race_id,driver_id)
    select v_race, '_tr'||lpad(g::text,2,'0') from generate_series(1,12) g;

  actual     := (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,10) g);
  actual2    := jsonb_build_array('_tr02','_tr01') || (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(3,10) g);
  actual9    := (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,9) g);
  actualdup  := jsonb_build_array('_tr01') || (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,9) g);
  actualpool := (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,9) g) || jsonb_build_array('_zzz_notpool');

  -- прогноз игрока = actual (перфект -> 131 очко)
  insert into predictions(user_id,race_id,positions) values ('${USER}',v_race,actual);

  -- ПЕРВЫЙ ЗАНОС (как админ)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  perform public.set_race_result(v_race, actual, null);
  execute 'reset role';

  select count(*) into rc1 from result_changes where race_id=v_race;
  select status into v_res_status from results where race_id=v_race;
  select scored, status into v_scored, v_race_status from races where id=v_race;
  select points into v_points from scores where user_id='${USER}' and race_id=v_race;

  -- OVERRIDE (как админ)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  perform public.set_race_result(v_race, actual2, 'fix');
  execute 'reset role';

  select count(*) into rc2 from result_changes where race_id=v_race;
  select (positions = actual2) into v_res_match from results where race_id=v_race;

  -- ВАЛИДАЦИЯ (как админ, каждая должна упасть)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  begin perform public.set_race_result(v_race, actual9,   null); exception when others then not10:=true; end;
  begin perform public.set_race_result(v_race, actualdup, null); exception when others then dup:=true;   end;
  begin perform public.set_race_result(v_race, actualpool,null); exception when others then pool:=true;  end;
  execute 'reset role';

  -- НЕ-АДМИН (должно упасть)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${USER}'), true);
  execute 'set local role authenticated';
  begin perform public.set_race_result(v_race, actual, null); exception when others then nonadmin:=true; end;
  execute 'reset role';

  create temp table _tr(res_status text, race_status text, scored boolean, points int,
    rc1 int, rc2 int, res_match boolean, not10 boolean, dup boolean, pool boolean, nonadmin boolean) on commit drop;
  insert into _tr values (v_res_status, v_race_status, v_scored, v_points, rc1, rc2, v_res_match, not10, dup, pool, nonadmin);
end $$;
select * from _tr;
rollback;`;
function pick(r){const a=Array.isArray(r)?r:[r];const x=a.reverse().find(y=>y.rows&&y.rows.length);return x?x.rows:[];}
async function killOrphans(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false}});c.on('error',()=>{});try{await c.connect();await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}finally{try{await c.end();}catch(_){}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function once(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});c.on('error',()=>{});await c.connect();try{return pick(await c.query(SQL));}finally{try{await c.end();}catch(_){}}}
(async()=>{let rows;for(let a=1;a<=5;a++){try{rows=await once();break;}catch(e){console.error(`attempt ${a}/5: ${e.message}`);if(a===5)process.exit(1);await killOrphans();await sleep(2000*a);}}
  const r=rows[0];
  const checks=[
    ['результат final', r.res_status==='final'],
    ['гонка resulted', r.race_status==='resulted'],
    ['scored=true', r.scored===true],
    ['очки=131 (сквозной скоринг)', Number(r.points)===131],
    ['журнал после заноса=1', Number(r.rc1)===1],
    ['журнал после override=2', Number(r.rc2)===2],
    ['override перезаписал результат', r.res_match===true],
    ['не 10 -> отказ', r.not10===true],
    ['дубли -> отказ', r.dup===true],
    ['вне пула -> отказ', r.pool===true],
    ['не-админ -> отказ', r.nonadmin===true],
  ];
  const ok=checks.every(c=>c[1]);
  for(const [n,p] of checks) console.log(`  ${p?'ok':'XX'}  ${n}`);
  console.log(`${ok?'PASS':'FAIL'}  set_race_result (points=${r.points})`);
  process.exit(ok?0:1);
})();
