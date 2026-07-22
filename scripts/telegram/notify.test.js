const { isMskThursday, notVotedNames } = require('./notify');

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`));
  return ok;
}

let fail = 0;

if (!check('isMskThursday: среда 12:00 UTC -> false', isMskThursday(new Date('2026-07-22T12:00:00Z')), false)) fail++;
if (!check('isMskThursday: четверг 09:00 UTC -> true', isMskThursday(new Date('2026-07-23T09:00:00Z')), true)) fail++;
if (!check('isMskThursday: четверг 16:00 UTC -> true', isMskThursday(new Date('2026-07-23T16:00:00Z')), true)) fail++;
if (!check('isMskThursday: пятница 09:00 UTC -> false', isMskThursday(new Date('2026-07-24T09:00:00Z')), false)) fail++;
if (!check('isMskThursday: граница 23:59 МСК четверга -> true', isMskThursday(new Date('2026-07-23T20:59:00Z')), true)) fail++;
if (!check('isMskThursday: граница 00:01 МСК пятницы -> false', isMskThursday(new Date('2026-07-23T21:01:00Z')), false)) fail++;

const users = [
  { id: '1', display_name: 'Павел' },
  { id: '2', display_name: 'Иван' },
  { id: '3', display_name: 'Аня' },
];
if (!check('notVotedNames: сортировка и исключение проголосовавших', notVotedNames(users, ['2']), ['Аня', 'Павел'])) fail++;
if (!check('notVotedNames: все проголосовали -> []', notVotedNames(users, ['1', '2', '3']), [])) fail++;
if (!check('notVotedNames: никто не проголосовал -> все, по алфавиту', notVotedNames(users, []), ['Аня', 'Иван', 'Павел'])) fail++;

console.log(fail === 0 ? 'ВСЕ 9 PASS' : `ПРОВАЛЕНО: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
