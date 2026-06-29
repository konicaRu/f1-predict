// Проверка score_prediction против 7 примеров из docs/plan.md §3 — одним запросом.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const cases = [
  ['1 P1 точно',       ['NOR','x2','x3','x4','x5','x6','x7','x8','x9','x10'], ['NOR','a2','a3','a4','a5','a6','a7','a8','a9','a10'], 28, 1],
  ['2 P2 ошибка 1',    ['z1','LEC','z3','z4','z5','z6','z7','z8','z9','z10'], ['a1','a2','LEC','a4','a5','a6','a7','a8','a9','a10'], 16, 0],
  ['3 P5 приехал P2',  ['z1','z2','z3','z4','RUS','z6','z7','z8','z9','z10'], ['a1','RUS','a3','a4','a5','a6','a7','a8','a9','a10'], 4, 0],
  ['4 P1 скатился P4', ['VER','z2','z3','z4','z5','z6','z7','z8','z9','z10'], ['a1','a2','a3','VER','a5','a6','a7','a8','a9','a10'], 19, 0],
  ['5 P3 финиш P9',    ['z1','z2','GAS','z4','z5','z6','z7','z8','z9','z10'], ['a1','a2','a3','a4','a5','a6','a7','a8','GAS','a10'], 3, 0],
  ['6 вне топ-10',     ['z1','z2','z3','z4','z5','z6','z7','BOT','z9','z10'], ['a1','a2','a3','a4','a5','a6','a7','a8','a9','a10'], 0, 0],
  ['7 ниже нуля -> 0', ['z1','z2','z3','z4','z5','z6','z7','z8','z9','ALO'], ['a1','a2','ALO','a4','a5','a6','a7','a8','a9','a10'], 0, 0],
];
const j = a => `'${JSON.stringify(a)}'::jsonb`;
const rows = cases.map((c,i)=>`(${i}, ${j(c[1])}, ${j(c[2])}, ${c[3]}, ${c[4]})`).join(',\n  ');
const sql = `with cases(idx,pred,act,exp_pts,exp_exact) as (values\n  ${rows}\n)
select idx, exp_pts, exp_exact, s.points, s.exact_hits
from cases cross join lateral public.score_prediction(pred,act) s order by idx`;

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function run(){
  for(let a=1;a<=4;a++){
    const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true}); c.on('error',()=>{});
    try{ await c.connect(); const r=await c.query(sql); await c.end(); return r.rows; }
    catch(e){ try{await c.end();}catch(_){} console.error(`attempt ${a}/4: ${e.message}`); if(a===4) throw e; await sleep(1500*a); }
  }
}
(async()=>{
  const rows=await run(); let fail=0;
  for(const r of rows){ const c=cases[r.idx]; const ok=r.points===c[3]&&r.exact_hits===c[4]; if(!ok)fail++;
    console.log(`${ok?'PASS':'FAIL'}  ${c[0]}  -> points=${r.points} exact=${r.exact_hits}`+(ok?'':`  (ждали ${c[3]}/${c[4]})`)); }
  console.log(fail===0?'ВСЕ 7 PASS':`ПРОВАЛЕНО: ${fail}`); process.exit(fail===0?0:1);
})().catch(e=>{console.error('ERR',e.code||'',e.message);process.exit(1);});
