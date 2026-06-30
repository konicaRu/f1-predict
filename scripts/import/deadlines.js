// deadlines.js — deadlineUtc('YYYY-MM-DD') -> ISO ближайшего четверга перед датой, 20:00:00Z.
function deadlineUtc(raceDate){
  const d = new Date(raceDate + 'T00:00:00Z');
  const t = new Date(d);
  do { t.setUTCDate(t.getUTCDate() - 1); } while (t.getUTCDay() !== 4); // 4 = четверг
  t.setUTCHours(20,0,0,0);
  return t.toISOString();
}
module.exports = { deadlineUtc };
