// deadlines.test.js — дедлайн = ближайший четверг ПЕРЕД гонкой, 20:00:00 UTC.
const { deadlineUtc } = require('./deadlines');

let fail = 0;
function check(raceDate, expected){
  const got = deadlineUtc(raceDate);
  const ok = got === expected;
  console.log(`${ok?'PASS':'FAIL'}  ${raceDate} -> ${got}` + (ok?'':`  (ждали ${expected})`));
  if(!ok) fail++;
}
// Британия (вс 2026-07-05) -> чт 2026-07-02 20:00Z
check('2026-07-05', '2026-07-02T20:00:00.000Z');
// Австралия (вс 2026-03-08) -> чт 2026-03-05
check('2026-03-08', '2026-03-05T20:00:00.000Z');
// гонка в субботу (2026-07-04, dow6) -> чт 2026-07-02
check('2026-07-04', '2026-07-02T20:00:00.000Z');
console.log(fail===0?'ВСЕ PASS':`ПРОВАЛЕНО: ${fail}`);
process.exit(fail===0?0:1);
