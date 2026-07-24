# Список не проголосовавших в четверговом напоминании — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По четвергам (10:00 и 19:00 МСК) добавлять в текст напоминания `deadline` список игроков лиги, ещё не поставивших прогноз на открытую гонку недели.

**Architecture:** Два чистых хелпера (`isMskThursday`, `notVotedNames`) в `scripts/telegram/notify.js`, покрытые юнит-тестами без обращения к БД. `deadline()` при срабатывании по четвергам делает два дополнительных SQL-запроса (`predictions`, `users`) и дописывает абзац в конец существующего текста. Cron/workflow не меняются — режим тот же, ветвление по дню недели внутри самого скрипта.

**Tech Stack:** Node.js (CommonJS, без фреймворка тестирования — как в остальных `scripts/*`), `pg`, Telegram Bot API (`sendMessage`, `parse_mode: HTML`).

---

### Task 1: Чистые хелперы `isMskThursday` и `notVotedNames` + тесты

**Files:**
- Modify: `scripts/telegram/notify.js`
- Create: `scripts/telegram/notify.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `scripts/telegram/notify.test.js`:

```js
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node scripts/telegram/notify.test.js`
Expected: ошибка при `require('./notify')` — `isMskThursday`/`notVotedNames` ещё не экспортированы (`notify.js` сейчас ничего не экспортирует и к тому же сразу выполняет `main()` при импорте).

- [ ] **Step 3: Добавить хелперы, экспорт и защиту `main()` от выполнения при импорте**

В `scripts/telegram/notify.js` добавить после функции `toMskTime` (строка 15):

```js
function isMskThursday(date = new Date()) {
  return date.toLocaleString('en-US', { timeZone: 'Europe/Moscow', weekday: 'short' }) === 'Thu';
}

function notVotedNames(users, votedIds) {
  const voted = new Set(votedIds);
  return users
    .filter((u) => !voted.has(u.id))
    .map((u) => u.display_name)
    .sort((a, b) => a.localeCompare(b));
}
```

В самом низу файла заменить блок вызова `main()` (сейчас строки 141-144):

```js
main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
```

на:

```js
if (require.main === module) {
  main().catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });
}

module.exports = { isMskThursday, notVotedNames };
```

Защита `require.main === module` нужна, чтобы при `require('./notify')` из теста скрипт не пытался тут же подключаться к БД и слать сообщения.

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `node scripts/telegram/notify.test.js`
Expected: `ВСЕ 9 PASS`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram/notify.js scripts/telegram/notify.test.js
git commit -m "feat(telegram): чистые хелперы isMskThursday и notVotedNames"
```

---

### Task 2: Список не проголосовавших в `deadline()`

**Files:**
- Modify: `scripts/telegram/notify.js`

- [ ] **Step 1: Изменить `deadline()`**

Заменить текущую функцию `deadline()`:

```js
async function deadline() {
  const races = (await thisWeekOpenRaces()).filter((r) => new Date(r.deadline_utc) > new Date());
  if (races.length === 0) {
    console.log('deadline: нет открытой гонки с дедлайном впереди, ничего не шлём');
    return;
  }
  for (const r of races) {
    const text =
      `⏰ Не забудь поставить прогноз на <b>${escapeHtml(r.name)}</b>!\n` +
      `Дедлайн — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `${SITE_URL}/predict`;
    await sendTelegram(text);
    console.log(`deadline: отправлено для ${r.name}`);
  }
}
```

на:

```js
async function deadline() {
  const races = (await thisWeekOpenRaces()).filter((r) => new Date(r.deadline_utc) > new Date());
  if (races.length === 0) {
    console.log('deadline: нет открытой гонки с дедлайном впереди, ничего не шлём');
    return;
  }
  const thursday = isMskThursday();
  for (const r of races) {
    let text =
      `⏰ Не забудь поставить прогноз на <b>${escapeHtml(r.name)}</b>!\n` +
      `Дедлайн — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `${SITE_URL}/predict`;
    if (thursday) {
      const { rows: predRows } = await q('select user_id from predictions where race_id = $1', [r.id]);
      const { rows: userRows } = await q('select id, display_name from users');
      const missing = notVotedNames(userRows, predRows.map((p) => p.user_id));
      text +=
        missing.length === 0
          ? '\n\nВсе уже поставили прогноз, красавцы! 👍'
          : `\n\nЕщё не поставили: ${missing.map(escapeHtml).join(', ')}`;
    }
    await sendTelegram(text);
    console.log(`deadline: отправлено для ${r.name}`);
  }
}
```

- [ ] **Step 2: Прогнать юнит-тесты — регрессии быть не должно**

Run: `node scripts/telegram/notify.test.js`
Expected: `ВСЕ 9 PASS` (Task 1 не тронут).

- [ ] **Step 3: Ручная проверка на реальных данных (текст сообщения, без реальной отправки в чат)**

В `scripts/telegram/notify.js` временно заменить строку `const thursday = isMskThursday();` на `const thursday = true;`, а вызов `await sendTelegram(text);` — на `console.log('--- ЧТО БЫ УШЛО ---\n' + text);` (обе правки — временные, для проверки, не коммитить).

Run: `node scripts/telegram/notify.js deadline`
Expected: в консоли — текст напоминания для текущей открытой гонки недели с абзацем `Ещё не поставили: ...` (или позитивной фразой, если уже все поставили). Сверить список имён с фактическим состоянием: `node -e "require('./scripts/telegram/lib').q('select u.display_name from users u where u.id not in (select user_id from predictions where race_id = (select id from races where status=\'open\' order by round limit 1))').then(r=>{console.log(r.rows);process.exit(0)})"` (заменить подзапрос гонки при необходимости на конкретный `race_id`, если открытых гонок несколько).

- [ ] **Step 4: Откатить временные правки из Step 3**

Run: `git diff scripts/telegram/notify.js`
Expected: diff совпадает с изменением из Step 1 (без `const thursday = true` и без `console.log` вместо `sendTelegram`).

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram/notify.js
git commit -m "feat(telegram): список не проголосовавших в четверговом напоминании"
```
