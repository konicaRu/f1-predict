const { q, close } = require('./lib');
let fail=0;
function check(name, ok, info){ console.log(`${ok?'PASS':'FAIL'}  ${name}  — ${info}`); if(!ok) fail++; }
(async()=>{
  const races = (await q('select count(*)::int c from races')).rows[0].c;
  check('races=22', races===22, `races=${races}`);

  const dl = (await q("select to_char(deadline_utc at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') d from races where round=9")).rows[0];
  check('Британия дедлайн', dl && dl.d==='2026-07-02T20:00:00', `${dl&&dl.d}`);

  const res = (await q('select count(*)::int c from results')).rows[0].c;
  check('results=8', res===8, `results=${res}`);

  const lens = (await q('select count(*)::int c from results where jsonb_array_length(positions)<>10')).rows[0].c;
  check('все результаты по 10', lens===0, `кривых=${lens}`);

  const w = (await q("select positions->>0 w from results r join races ra on ra.id=r.race_id where ra.round=1")).rows[0];
  check('round1 winner=russell', w && w.w==='russell', `${w&&w.w}`);

  const noColor = (await q(`select count(*)::int c from drivers where id in
    (select distinct jsonb_array_elements_text(positions) from results) and (team_color is null or team_color='#888')`)).rows[0].c;
  check('боевые пилоты с цветом', noColor===0, `без цвета=${noColor}`);

  const sprint = (await q('select count(*)::int c from races where is_sprint')).rows[0].c;
  check('спринты помечены', sprint>=1, `спринтов=${sprint}`);

  await close();
  console.log(`\n=== ИТОГ: ${fail===0?'ВСЁ PASS':fail+' FAIL'} ===`);
  process.exit(fail===0?0:1);
})().catch(async e=>{ console.error('ERR',e.message); await close(); process.exit(1); });
