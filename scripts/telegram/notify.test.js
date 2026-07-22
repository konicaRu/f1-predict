const { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings } = require('./notify');

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

const codeOf = new Map([
  ['ant', 'ANT'],
  ['ham', 'HAM'],
  ['pia', 'PIA'],
  ['lec', 'LEC'],
]);
if (!check('podiumText: первые 3 позиции через дефис', podiumText(['ant', 'ham', 'pia', 'lec'], codeOf), 'ANT-HAM-PIA')) fail++;

if (
  !check(
    'roundWinnerLine: один лидер',
    roundWinnerLine([
      { user: 'Dim', points: 69 },
      { user: 'Iceman', points: 43 },
    ]),
    '🏆 Лучший прогноз тура — Dim (69 очков)!',
  )
)
  fail++;
if (
  !check(
    'roundWinnerLine: ничья — через запятую',
    roundWinnerLine([
      { user: 'Dim', points: 50 },
      { user: 'Iceman', points: 50 },
      { user: 'Павел', points: 10 },
    ]),
    '🏆 Лучший прогноз тура — Dim, Iceman (50 очков)!',
  )
)
  fail++;
if (!check('roundWinnerLine: пусто -> null', roundWinnerLine([]), null)) fail++;

const standingsInput = [
  { id: '1', display_name: 'Dim', points: 69, exact: 1, best_race: 69 },
  { id: '2', display_name: 'Iceman', points: 43, exact: 0, best_race: 43 },
  { id: '3', display_name: 'Павел', points: 0, exact: 0, best_race: 0 },
];
if (
  !check(
    'rankStandings: сортировка по очкам, ранг 1,2,3',
    rankStandings(standingsInput).map((r) => [r.rank, r.display_name, r.points]),
    [
      [1, 'Dim', 69],
      [2, 'Iceman', 43],
      [3, 'Павел', 0],
    ],
  )
)
  fail++;

const tieInput = [
  { id: '1', display_name: 'Иван', points: 50, exact: 1, best_race: 50 },
  { id: '2', display_name: 'Аня', points: 50, exact: 1, best_race: 50 },
  { id: '3', display_name: 'Павел', points: 10, exact: 0, best_race: 10 },
];
if (
  !check(
    'rankStandings: ничья -> соревновательный ранг (1,1,3), тайбрейк по имени',
    rankStandings(tieInput).map((r) => [r.rank, r.display_name]),
    [
      [1, 'Аня'],
      [1, 'Иван'],
      [3, 'Павел'],
    ],
  )
)
  fail++;

console.log(fail === 0 ? 'ВСЕ 15 PASS' : `ПРОВАЛЕНО: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
