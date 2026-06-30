// membership.test.js — auth-юзер БЕЗ профиля видит 0 строк drivers; С профилем — >0. Транзакция -> rollback.
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const U='44444444-4444-4444-4444-444444444444';
const SQL=`
begin;
set local statement_timeout='25s';
do $$
declare non_member int; member int;
begin
  insert into auth.users(id,email) values('${U}','member-test@t.io');
  perform set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into non_member from drivers;
  execute 'reset role';
  insert into public.users(id,display_name) values('${U}','Member');
  perform set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into member from drivers;
  execute 'reset role';
  create temp table _m(non_member int, member int) on commit drop;
  insert into _m values(non_member, member);
end $$;
select non_member, member from _m;
rollback;`;
function pick(r){const a=Array.isArray(r)?r:[r];const x=a.reverse().find(y=>y.rows&&y.rows.length);return x?x.rows:[];}
async function killOrphans(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false}});c.on('error',()=>{});try{await c.connect();await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}finally{try{await c.end();}catch(_){}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function once(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});c.on('error',()=>{});await c.connect();try{return pick(await c.query(SQL));}finally{try{await c.end();}catch(_){}}}
(async()=>{let rows;for(let a=1;a<=5;a++){try{rows=await once();break;}catch(e){console.error(`attempt ${a}/5: ${e.message}`);if(a===5){process.exit(1);}await killOrphans();await sleep(2000*a);}}
  const r=rows[0];const ok=Number(r.non_member)===0 && Number(r.member)>0;
  console.log(`${ok?'PASS':'FAIL'}  не-член видит ${r.non_member} (ждали 0), член видит ${r.member} (>0)`);
  process.exit(ok?0:1);
})();
