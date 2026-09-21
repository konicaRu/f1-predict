const { mskWeekday, isDeadlineDayMsk, notVotedNames, podiumText, roundWinnerLine, rankStandings, predictButton, diffPoolAdditions } = require('./notify');

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`));
  return ok;
}

let fail = 0;

const DEADLINE_THU = '2026-07-23T20:00:00Z'; // обычная гонка — дедлайн в четверг
const DEADLINE_WED = '2026-09-23T20:00:00Z'; // Azerbaijan GP round 15 — дедлайн сдвинут на среду

if (!check('isDeadlineDayMsk: день до дедлайна -> false', isDeadlineDayMsk(DEADLINE_THU, new Date('2026-07-22T12:00:00Z')), false)) fail++;
if (!check('isDeadlineDayMsk: день дедлайна утром -> true', isDeadlineDayMsk(DEADLINE_THU, new Date('2026-07-23T09:00:00Z')), true)) fail++;
if (!check('isDeadlineDayMsk: день дедлайна вечером -> true', isDeadlineDayMsk(DEADLINE_THU, new Date('2026-07-23T16:00:00Z')), true)) fail++;
if (!check('isDeadlineDayMsk: день после дедлайна -> false', isDeadlineDayMsk(DEADLINE_THU, new Date('2026-07-24T09:00:00Z')), false)) fail++;
if (!check('isDeadlineDayMsk: граница 23:59 МСК дня дедлайна -> true', isDeadlineDayMsk(DEADLINE_THU, new Date('2026-07-23T20:59:00Z')), true)) fail++;
if (!check('isDeadlineDayMsk: граница 00:01 МСК следующего дня -> false', isDeadlineDayMsk(DEADLINE_THU, new Date('2026-07-23T21:01:00Z')), false)) fail++;
if (!check('isDeadlineDayMsk: сдвинутый дедлайн (среда) -> true в среду', isDeadlineDayMsk(DEADLINE_WED, new Date('2026-09-23T10:00:00Z')), true)) fail++;
if (!check('isDeadlineDayMsk: сдвинутый дедлайн (среда) -> false в четверг', isDeadlineDayMsk(DEADLINE_WED, new Date('2026-09-24T10:00:00Z')), false)) fail++;

if (!check('mskWeekday: четверг', mskWeekday(DEADLINE_THU), 'четверг')) fail++;
if (!check('mskWeekday: среда (сдвинутый дедлайн Баку)', mskWeekday(DEADLINE_WED), 'среда')) fail++;

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

if (!check(
  'predictButton: корректная структура inline-кнопки',
  predictButton(42),
  { inline_keyboard: [[{ text: 'Сделать прогноз', url: 'https://t.me/che_f1_predict_bot/predict?startapp=predict_42' }]] },
)) fail++;

const currentPoolIds = new Set(['hamilton', 'norris']);
const activeDriverIds = new Set(['hamilton', 'norris', 'tsunoda']);
const codeToId = new Map([['TSU', 'tsunoda'], ['HAD', 'hadjar']]);

if (!check(
  'diffPoolAdditions: новый активный пилот вне пула -> добавление, источник jolpica',
  diffPoolAdditions(currentPoolIds, activeDriverIds, null, codeToId),
  [{ driverId: 'tsunoda', sources: ['jolpica'] }],
)) fail++;

if (!check(
  'diffPoolAdditions: OpenF1 подтверждает того же пилота -> оба источника',
  diffPoolAdditions(currentPoolIds, activeDriverIds, new Set(['TSU']), codeToId),
  [{ driverId: 'tsunoda', sources: ['jolpica', 'openf1'] }],
)) fail++;

if (!check(
  'diffPoolAdditions: OpenF1 видит пилота, которого ещё нет среди active -> тоже добавляется, источник openf1',
  diffPoolAdditions(currentPoolIds, new Set(['hamilton', 'norris']), new Set(['HAD']), codeToId),
  [{ driverId: 'hadjar', sources: ['openf1'] }],
)) fail++;

if (!check(
  'diffPoolAdditions: всё уже в пуле -> пусто',
  diffPoolAdditions(new Set(['hamilton', 'norris', 'tsunoda']), activeDriverIds, null, codeToId),
  [],
)) fail++;

if (!check(
  'diffPoolAdditions: OpenF1-код без соответствия в drivers -> игнорируется',
  diffPoolAdditions(currentPoolIds, new Set(['hamilton', 'norris']), new Set(['XXX']), codeToId),
  [],
)) fail++;

console.log(fail === 0 ? 'ВСЕ 25 PASS' : `ПРОВАЛЕНО: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
