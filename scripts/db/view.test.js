// Смоук-тест view scores одним запросом: идеальный прогноз = 131/10. Транзакция -> откат при дисконнекте.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const UID='00000000-0000-0000-0000-0000000009e1', RID=900000001;
const SQL = `
begin;
set local statement_timeout='30s';
insert into drivers(id,code,name) select 'd'||g,'D'||g,'Drv'||g from generate_series(1,10) g;
insert into races(id,round,name,deadline_utc,status) overriding system value
  values(${RID},1,'ViewTest',now()-interval '1 day','resulted');
insert into auth.users(id,email) values('${UID}','viewtest@test.io');
insert into users(id,display_name) values('${UID}','View Tester');
insert into results(race_id,positions,status)
  values(${RID},(select jsonb_agg('d'||g order by g) from generate_series(1,10) g),'final');
insert into predictions(user_id,race_id,positions)
  values('${UID}',${RID},(select jsonb_agg('d'||g order by g) from generate_series(1,10) g));
select points, exact_hits from scores where race_id=${RID};
`;
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function pickRows(res){ if(Array.isArray(res)){const l=res.reverse().find(r=>r.rows&&r.rows.length);return l?l.rows:[];} return res.rows||[]; }
async function once(){
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true}); c.on('error',()=>{});
  await c.connect();
  try{ return pickRows(await c.query(SQL)); } finally{ try{await c.end();}catch(_){} }
}
async function run(){ for(let a=1;a<=5;a++){ try{ return await once(); } catch(e){ console.error(`attempt ${a}/5: ${e.message}`); if(a===5) throw e; await sleep(2500*a); } } }
(async()=>{
  const row=(await run())[0];
  const ok=row && Number(row.points)===131 && Number(row.exact_hits)===10;
  console.log(`${ok?'PASS':'FAIL'}  идеальный прогноз -> ${row?`points=${row.points} exact=${row.exact_hits}`:'нет строки'} (ждали 131/10)`);
  process.exit(ok?0:1);
})().catch(e=>{console.error('ERR',e.code||'',e.message);process.exit(1);});
