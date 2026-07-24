# Расширенное сообщение об итогах гонки в Telegram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Функция `results()` в `scripts/telegram/notify.js` шлёт сообщение об итогах гонки с подиумом-прогнозом каждого игрока рядом с очками, фразой про лучший прогноз тура и общим зачётом сезона — всё в одном сообщении.

**Architecture:** Три чистых хелпера (`podiumText`, `roundWinnerLine`, `rankStandings`) в `scripts/telegram/notify.js`, покрытые юнит-тестами без обращения к БД (по образцу `isMskThursday`/`notVotedNames` из предыдущей фичи). `results()` делает два дополнительных SQL-запроса (`predictions` по гонке, агрегат сезона по `scores`+`races`) и собирает текст из готовых кусков. Cron/workflow не меняются.

**Tech Stack:** Node.js (CommonJS), `pg`, Telegram Bot API (`sendMessage`, `parse_mode: HTML`).

---

### Task 1: Чистые хелперы `podiumText`, `roundWinnerLine`, `rankStandings` + тесты

**Files:**
- Modify: `scripts/telegram/notify.js`
- Modify: `scripts/telegram/notify.test.js`

- [ ] **Step 1: Написать падающие тесты**

В `scripts/telegram/notify.test.js` заменить строку 1:

```js
const { isMskThursday, notVotedNames } = require('./notify');
```

на:

```js
const { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings } = require('./notify');
```

Перед строкой `console.log(fail === 0 ? 'ВСЕ 9 PASS' : ...)` (сейчас строка 27) вставить:

```js
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
```

И заменить строку `console.log(fail === 0 ? 'ВСЕ 9 PASS' : \`ПРОВАЛЕНО: ${fail}\`);` на:

```js
console.log(fail === 0 ? 'ВСЕ 15 PASS' : `ПРОВАЛЕНО: ${fail}`);
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node scripts/telegram/notify.test.js`
Expected: ошибка — `podiumText`/`roundWinnerLine`/`rankStandings` ещё не экспортированы из `./notify`.

- [ ] **Step 3: Добавить три хелпера в `notify.js`**

В `scripts/telegram/notify.js` добавить сразу после функции `codeFor` (сейчас заканчивается на строке 92, перед `async function results()`):

```js
function podiumText(positions, codeOf) {
  return positions
    .slice(0, 3)
    .map((id) => codeFor(id, codeOf))
    .join('-');
}

function roundWinnerLine(scoreRows) {
  if (scoreRows.length === 0) return null;
  const top = scoreRows[0].points;
  const winners = scoreRows.filter((s) => s.points === top).map((s) => escapeHtml(s.user));
  return `🏆 Лучший прогноз тура — ${winners.join(', ')} (${top} очков)!`;
}

function rankStandings(rows) {
  const sorted = [...rows].sort(
    (a, b) =>
      b.points - a.points ||
      b.exact - a.exact ||
      b.best_race - a.best_race ||
      a.display_name.localeCompare(b.display_name),
  );
  let rank = 0;
  let prev = null;
  return sorted.map((r, i) => {
    if (!prev || r.points !== prev.points || r.exact !== prev.exact || r.best_race !== prev.best_race) {
      rank = i + 1;
    }
    prev = r;
    return { ...r, rank };
  });
}
```

`podiumText` берёт первые 3 позиции прогноза и переводит id пилотов в коды через уже существующий `codeFor`/`codeOf` (тот же паттерн, что уже использует `top10` в `results()`). `roundWinnerLine` ожидает `scoreRows`, уже отсортированные по `points desc` (как и возвращает существующий SQL-запрос очков) — верхний элемент задаёт максимум, дальше собираются все, кто набрал столько же. `rankStandings` — прямой порт тайбрейкера и соревновательного ранжирования из `aggregateStandings` (`src/lib/standings.ts`), но без опоры на фронтовые типы — работает с обычными объектами `{ id, display_name, points, exact, best_race }` из SQL.

Заменить строку экспорта в самом низу файла:

```js
module.exports = { isMskThursday, notVotedNames };
```

на:

```js
module.exports = { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings };
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node scripts/telegram/notify.test.js`
Expected: `ВСЕ 15 PASS`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram/notify.js scripts/telegram/notify.test.js
git commit -m "feat(telegram): хелперы podiumText, roundWinnerLine, rankStandings"
```

---

### Task 2: Собрать расширенное сообщение в `results()`

**Files:**
- Modify: `scripts/telegram/notify.js`

- [ ] **Step 1: Изменить `results()`**

Заменить текущую функцию `results()`:

```js
async function results() {
  const { rows } = await q(`
    select id, round, name
    from races
    where status = 'resulted' and scored = true and telegram_announced_at is null
    order by round
  `);
  if (rows.length === 0) {
    console.log('results: новых финальных результатов нет');
    return;
  }
  const codeOf = await driverCodeMap();
  for (const r of rows) {
    const { rows: resRows } = await q('select positions from results where race_id = $1', [r.id]);
    const positions = resRows[0].positions;
    const top10 = positions.map((id, i) => `${i + 1}. ${codeFor(id, codeOf)}`).join('  ');

    const { rows: scoreRows } = await q(
      `
      select u.display_name as "user", s.points, s.exact_hits
      from scores s
      join users u on u.id = s.user_id
      where s.race_id = $1
      order by s.points desc
    `,
      [r.id],
    );
    const scoresText = scoreRows
      .map((s, i) => `${i + 1}. ${escapeHtml(s.user)} — ${s.points} (${s.exact_hits} точных)`)
      .join('\n');

    const text = `🏁 Финиш <b>${escapeHtml(r.name)}</b>!\n\nТоп-10:\n${top10}\n\nОчки за гонку:\n${scoresText}`;
    await sendTelegram(text);
    await q('update races set telegram_announced_at = now() where id = $1', [r.id]);
    console.log(`results: отправлено для ${r.name}`);
  }
}
```

на:

```js
async function results() {
  const { rows } = await q(`
    select id, round, name
    from races
    where status = 'resulted' and scored = true and telegram_announced_at is null
    order by round
  `);
  if (rows.length === 0) {
    console.log('results: новых финальных результатов нет');
    return;
  }
  const codeOf = await driverCodeMap();
  for (const r of rows) {
    const { rows: resRows } = await q('select positions from results where race_id = $1', [r.id]);
    const resultPositions = resRows[0].positions;
    const top10 = resultPositions.map((id, i) => `${i + 1}. ${codeFor(id, codeOf)}`).join('  ');

    const { rows: scoreRows } = await q(
      `
      select s.user_id, u.display_name as "user", s.points, s.exact_hits
      from scores s
      join users u on u.id = s.user_id
      where s.race_id = $1
      order by s.points desc
    `,
      [r.id],
    );
    const { rows: predRows } = await q('select user_id, positions from predictions where race_id = $1', [r.id]);
    const predOf = new Map(predRows.map((p) => [p.user_id, p.positions]));

    const scoresText = scoreRows
      .map((s, i) => {
        const podium = podiumText(predOf.get(s.user_id), codeOf);
        return `${i + 1}. ${escapeHtml(s.user)} — подиум ${podium} → ${s.points} (${s.exact_hits} точных)`;
      })
      .join('\n');

    const winnerLine = roundWinnerLine(scoreRows);

    const { rows: standingRows } = await q(`
      select u.id, u.display_name,
             coalesce(sum(cs.points), 0) as points,
             coalesce(sum(cs.exact_hits), 0) as exact,
             coalesce(max(cs.points), 0) as best_race
      from users u
      left join (
        select s.user_id, s.race_id, s.points, s.exact_hits
        from scores s
        join races r on r.id = s.race_id
        where r.scored = true
      ) cs on cs.user_id = u.id
      group by u.id, u.display_name
    `);
    const standingsText = rankStandings(standingRows)
      .map((sr) => `${sr.rank}. ${escapeHtml(sr.display_name)} — ${sr.points}`)
      .join('\n');

    const text =
      `🏁 Финиш <b>${escapeHtml(r.name)}</b>!\n\n` +
      `Топ-10:\n${top10}\n\n` +
      `Прогнозы и очки:\n${scoresText}\n\n` +
      (winnerLine ? `${winnerLine}\n\n` : '') +
      `Общий зачёт сезона:\n${standingsText}`;
    await sendTelegram(text);
    await q('update races set telegram_announced_at = now() where id = $1', [r.id]);
    console.log(`results: отправлено для ${r.name}`);
  }
}
```

Каждая строка `scores` гарантированно имеет соответствующую строку `predictions` (view `scores` определена как `select ... from predictions p join results r on r.race_id = p.race_id ...` в `supabase/migrations/0002_scoring.sql` — то есть `scores` физически произведена из `predictions`), поэтому `predOf.get(s.user_id)` не может быть `undefined` для строки из `scoreRows` той же гонки — без запасного варианта.

- [ ] **Step 2: Прогнать юнит-тесты — регрессии быть не должно**

Run: `node scripts/telegram/notify.test.js`
Expected: `ВСЕ 15 PASS` (Task 1 не тронут).

- [ ] **Step 3: Ручная проверка текста сообщения на реальных данных (без записи в БД, без реальной отправки)**

Создать временный файл `scripts/telegram/_dry-run-results.js` (не коммитить, только для проверки):

```js
const { q, close } = require('./lib');
const { podiumText, roundWinnerLine, rankStandings } = require('./notify');

async function main() {
  const race = (await q("select id, name from races where round = 10")).rows[0];
  const codeOf = new Map((await q('select id, code from drivers')).rows.map((d) => [d.id, d.code]));
  const resultPositions = (await q('select positions from results where race_id = $1', [race.id])).rows[0]
    .positions;
  const top10 = resultPositions.map((id, i) => `${i + 1}. ${codeOf.get(id) || id}`).join('  ');

  const scoreRows = (
    await q(
      'select s.user_id, u.display_name as "user", s.points, s.exact_hits from scores s join users u on u.id = s.user_id where s.race_id = $1 order by s.points desc',
      [race.id],
    )
  ).rows;
  const predRows = (await q('select user_id, positions from predictions where race_id = $1', [race.id])).rows;
  const predOf = new Map(predRows.map((p) => [p.user_id, p.positions]));

  const scoresText = scoreRows
    .map(
      (s, i) =>
        `${i + 1}. ${s.user} — подиум ${podiumText(predOf.get(s.user_id), codeOf)} → ${s.points} (${s.exact_hits} точных)`,
    )
    .join('\n');
  const winnerLine = roundWinnerLine(scoreRows);

  const standingRows = (
    await q(`
      select u.id, u.display_name,
             coalesce(sum(cs.points), 0) as points,
             coalesce(sum(cs.exact_hits), 0) as exact,
             coalesce(max(cs.points), 0) as best_race
      from users u
      left join (
        select s.user_id, s.race_id, s.points, s.exact_hits
        from scores s
        join races r on r.id = s.race_id
        where r.scored = true
      ) cs on cs.user_id = u.id
      group by u.id, u.display_name
    `)
  ).rows;
  const standingsText = rankStandings(standingRows)
    .map((r) => `${r.rank}. ${r.display_name} — ${r.points}`)
    .join('\n');

  console.log(
    `🏁 Финиш ${race.name}!\n\nТоп-10:\n${top10}\n\nПрогнозы и очки:\n${scoresText}\n\n${winnerLine}\n\nОбщий зачёт сезона:\n${standingsText}`,
  );
  await close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
```

Run: `node scripts/telegram/_dry-run-results.js`
Expected: связный текст сообщения по гонке round 10 (Belgian Grand Prix) — топ-10, построчно игроки с подиумом прогноза и очками, фраза про лучший прогноз тура, общий зачёт сезона. Сверить:
- Подиумы прогнозов и очки — совпадают с тем, что видно на экране «Результаты» сайта для этой гонки.
- Строка про лучшего — действительно у игрока(ов) с максимумом очков в выведенном списке.
- Общий зачёт — тот же порядок и очки, что на экране «Зачёт» сайта.

Это read-only проверка: `_dry-run-results.js` не вызывает `sendTelegram` и не пишет `telegram_announced_at` — реальная гонка round 10 в БД не меняется.

- [ ] **Step 4: Удалить временный файл проверки**

Run: `git status --short`
Expected: `scripts/telegram/_dry-run-results.js` либо отсутствует, либо помечен как untracked — не должен попасть в коммит. Удалить файл, если ещё существует.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram/notify.js
git commit -m "feat(telegram): подиум прогнозов, лучший тура и зачёт сезона в results()"
```
