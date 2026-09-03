# Автопроверка состава пилотов + уведомления в оба чата — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматически обнаруживать изменения состава пилотов открытой гонки (Jolpica + OpenF1) и
слать уведомление в оба Telegram-чата; дать админу быстрый ручной путь через веб-Админку вместо SQL.

**Architecture:** Бэкенд — новая функция `checkDriverPool()` в `scripts/telegram/notify.js`, встроена в
уже существующие крон-слоты `raceweek`/`deadline` (Пн/Ср/Чт). Фронтенд — новая страница `/admin/pool/:raceId`
пишет прямо в `race_driver_pool` (RLS уже пускает админа) и дёргает существующую Edge Function
`admin-notify` (новый `event_type: 'pool_change'`) для доставки в оба Telegram-чата, т.к. у браузера
нет `TELEGRAM_BOT_TOKEN`.

**Tech Stack:** Node.js (CommonJS, `pg`, встроенный `fetch`), Deno (Supabase Edge Function), React + TS,
Supabase (Postgres + RLS + Edge Functions), Telegram Bot API, Jolpica/OpenF1 REST API.

Спека: `docs/superpowers/specs/2026-09-03-driver-pool-check-design.md`.

---

### Task 1: `scripts/import/import.js` — экспорт `importDrivers`, убрать неявный запуск при `require`

**Проблема:** файл сейчас вызывает `main().catch(...)` безусловно в конце файла (не за
`require.main === module`). Если `notify.js` сделает `require('../import/import.js')`, этот `main()`
выполнится немедленно, прочитает `process.argv[2]` (это будет режим `notify.js`, например `raceweek`,
а не `drivers`/`calendar`/`results`/`all`), попадёт в `else` и вызовет `process.exit(2)` — убьёт весь
процесс `notify.js`. Это нужно исправить, иначе Task 4 не заработает.

**Files:**
- Modify: `scripts/import/import.js:80-90`

- [ ] **Step 1: Экспортировать `importDrivers` и защитить `main()`**

Текущий конец файла:
```js
async function main(){
  const cmd = process.argv[2];
  if(cmd==='drivers') await importDrivers();
  else if(cmd==='calendar') await importCalendar();
  else if(cmd==='results') await importResults();
  else if(cmd==='all'){ await importDrivers(); await importCalendar(); await importResults(); }
  else { console.error('usage: drivers|calendar|results|all'); process.exit(2); }
  await close();
}
main().catch(async e=>{ console.error('ERR', e.code||'', e.message); await close(); process.exit(1); });
```

Заменить на:
```js
async function main(){
  const cmd = process.argv[2];
  if(cmd==='drivers') await importDrivers();
  else if(cmd==='calendar') await importCalendar();
  else if(cmd==='results') await importResults();
  else if(cmd==='all'){ await importDrivers(); await importCalendar(); await importResults(); }
  else { console.error('usage: drivers|calendar|results|all'); process.exit(2); }
  await close();
}
if (require.main === module) {
  main().catch(async e=>{ console.error('ERR', e.code||'', e.message); await close(); process.exit(1); });
}
module.exports = { importDrivers };
```

- [ ] **Step 2: Проверить, что CLI-режим всё ещё работает как раньше**

Run: `cd scripts/import && node import.js drivers`
Expected: тот же вывод, что и раньше (`drivers: N upsert (...)`), без падений.

- [ ] **Step 3: Проверить, что require больше не вызывает main()**

Run: `cd scripts/import && node -e "require('./import.js'); console.log('require OK, main не запустился')"`
Expected: печатает `require OK, main не запустился` и завершается кодом 0 (если бы `main()` всё ещё
запускался безусловно, тут был бы `usage: ...` и код выхода 2).

- [ ] **Step 4: Commit**

```bash
git add scripts/import/import.js
git commit -m "fix(import): не запускать main() при require, экспортировать importDrivers"
```

---

### Task 2: `scripts/telegram/notify.js` — чистая функция `diffPoolAdditions` + тесты

Функция сравнивает текущий пул гонки с «активными по Jolpica» и «увиденными в OpenF1» пилотами и
возвращает, кого добавить и откуда узнали (для сообщения админу).

**Files:**
- Modify: `scripts/telegram/notify.js` (добавить функцию + расширить `module.exports`)
- Test: `scripts/telegram/notify.test.js`

- [ ] **Step 1: Написать падающий тест**

Добавить в `scripts/telegram/notify.test.js` **после** строки 1 (`const { isMskThursday, ... } = require('./notify');`) — заменить импорт на:

```js
const { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings, predictButton, diffPoolAdditions } = require('./notify');
```

И добавить перед строкой `console.log(fail === 0 ? 'ВСЕ 16 PASS' : ...)` (сейчас — последние 4 строки файла):

```js
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
```

И заменить последнюю строку с `'ВСЕ 16 PASS'` на `'ВСЕ 21 PASS'` (16 существующих + 5 новых).

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd scripts/telegram && node notify.test.js`
Expected: `TypeError: diffPoolAdditions is not a function` (функции ещё нет).

- [ ] **Step 3: Реализовать `diffPoolAdditions`**

Добавить в `scripts/telegram/notify.js` сразу после функции `thisWeekOpenRaces()` (перед `async function raceweek()`):

```js
// Сравнивает текущий пул гонки с активными по Jolpica и увиденными в OpenF1 пилотами.
// Возвращает, кого добавить и откуда узнали (для админ-сообщения) — отсортировано по driverId
// для детерминированного вывода. openf1Codes может быть null (сессий уикенда ещё нет — это ожидаемо).
function diffPoolAdditions(currentPoolIds, activeDriverIds, openf1Codes, codeToId) {
  const bySource = new Map();
  for (const id of activeDriverIds) {
    if (currentPoolIds.has(id)) continue;
    if (!bySource.has(id)) bySource.set(id, new Set());
    bySource.get(id).add('jolpica');
  }
  if (openf1Codes) {
    for (const code of openf1Codes) {
      const id = codeToId.get(code);
      if (!id || currentPoolIds.has(id)) continue;
      if (!bySource.has(id)) bySource.set(id, new Set());
      bySource.get(id).add('openf1');
    }
  }
  return [...bySource.entries()]
    .map(([driverId, sources]) => ({ driverId, sources: [...sources].sort() }))
    .sort((a, b) => a.driverId.localeCompare(b.driverId));
}
```

И расширить `module.exports` в самом низу файла:
```js
module.exports = { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings, predictButton, diffPoolAdditions };
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `cd scripts/telegram && node notify.test.js`
Expected: `ВСЕ 21 PASS`, код выхода 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram/notify.js scripts/telegram/notify.test.js
git commit -m "feat(telegram): diffPoolAdditions — сравнение пула с активными/OpenF1 пилотами"
```

---

### Task 3: `scripts/telegram/notify.js` — `fetchOpenF1SessionCodes`

По образцу `findSessionKey()` из `scripts/autoresults/openf1.js`, но берёт ближайшую сессию ЛЮБОГО типа
(не только `Race` — нужен состав уикенда пораньше), и возвращает коды пилотов, а не результат.

**Files:**
- Modify: `scripts/telegram/notify.js`

- [ ] **Step 1: Добавить функцию**

Добавить сразу после `diffPoolAdditions` (из Task 2):

```js
const OPENF1_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // ±3 дня — тот же паттерн, что scripts/autoresults/openf1.js

// Состав пилотов ближайшей по дате сессии этого гоночного уикенда (Practice/Qualifying/Race — любая,
// нужен самый ранний доступный сигнал). Возвращает null, если в окне ±3 дня вообще нет сессий с
// данными (уикенд ещё не начался — это ожидаемо, не ошибка). Бросает исключение при сетевой/HTTP
// ошибке — вызывающий код сам решает, что с этим делать (см. checkDriverPool).
async function fetchOpenF1SessionCodes(raceDatetimeUtc) {
  const res = await fetch('https://api.openf1.org/v1/sessions?year=2026');
  if (!res.ok) throw new Error(`OpenF1 sessions HTTP ${res.status}`);
  const sessions = await res.json();
  const target = new Date(raceDatetimeUtc).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const s of sessions) {
    const diff = Math.abs(new Date(s.date_start).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  if (!best || bestDiff > OPENF1_WINDOW_MS) return null;

  const driversRes = await fetch(`https://api.openf1.org/v1/drivers?session_key=${best.session_key}`);
  if (!driversRes.ok) throw new Error(`OpenF1 drivers HTTP ${driversRes.status}`);
  const drivers = await driversRes.json();
  return new Set(drivers.map((d) => d.name_acronym).filter(Boolean));
}
```

- [ ] **Step 2: Ручная проверка вживую (Italian GP уже реальная гонка в БД)**

Run: `cd scripts/telegram && node -e "require('./notify')" 2>&1 || true` — просто чтобы проверить, что файл всё ещё валиден синтаксически после вставки (функция пока нигде не вызывается и не экспортируется — этого достаточно для этого шага).

Затем: `cd scripts/telegram && node -e "
const { fetch } = globalThis;
(async () => {
  const res = await fetch('https://api.openf1.org/v1/sessions?year=2026');
  console.log(res.status, (await res.json()).length, 'сессий за 2026');
})();
"`
Expected: код 200 и число сессий > 0 (сам эндпоинт доступен) — подтверждает, что OpenF1 отвечает, реальный вызов `fetchOpenF1SessionCodes` будет протестирован вместе с `checkDriverPool()` в Task 4.

- [ ] **Step 3: Commit**

```bash
git add scripts/telegram/notify.js
git commit -m "feat(telegram): fetchOpenF1SessionCodes — состав ближайшей сессии уикенда"
```

---

### Task 4: `scripts/telegram/notify.js` — `checkDriverPool()` + подключение в `main()`

**Files:**
- Modify: `scripts/telegram/notify.js`

- [ ] **Step 1: Добавить `checkDriverPool()`**

Добавить сразу после `fetchOpenF1SessionCodes` (из Task 3), перед `async function raceweek()`:

```js
// Автопроверка состава: подтягивает Jolpica (importDrivers, безопасно — только active=true,
// никого не деактивирует), сверяет с OpenF1 по ближайшей сессии уикенда (best-effort, часто пусто
// до пятницы — это ожидаемо), расширяет race_driver_pool открытых на этой неделе гонок и шлёт
// уведомление в оба чата, если что-то реально добавилось. Вызывается только из main() при
// mode === 'raceweek' || mode === 'deadline' (см. ниже) — не на каждом 2-часовом autoresults-крон.
async function checkDriverPool() {
  try {
    const { importDrivers } = require('../import/import.js');
    await importDrivers();
  } catch (e) {
    console.warn('checkDriverPool: importDrivers сорвался, продолжаем с уже имеющимися данными:', e.message);
  } finally {
    try {
      await require('../import/lib').close();
    } catch (_) {
      /* уже закрыт или не открывался */
    }
  }

  const races = await thisWeekOpenRaces();
  if (races.length === 0) {
    console.log('checkDriverPool: нет открытых гонок на этой неделе');
    return;
  }

  const { rows: driverRows } = await q('select id, code, name, active from drivers');
  const activeIds = new Set(driverRows.filter((d) => d.active).map((d) => d.id));
  const codeToId = new Map(driverRows.map((d) => [d.code, d.id]));
  const infoById = new Map(driverRows.map((d) => [d.id, d]));

  for (const race of races) {
    const { rows: poolRows } = await q('select driver_id from race_driver_pool where race_id = $1', [race.id]);
    const currentPoolIds = new Set(poolRows.map((r) => r.driver_id));

    let openf1Codes = null;
    try {
      openf1Codes = await fetchOpenF1SessionCodes(race.race_datetime_utc);
    } catch (e) {
      console.warn(`checkDriverPool: OpenF1 недоступен для ${race.name}:`, e.message);
    }

    const additions = diffPoolAdditions(currentPoolIds, activeIds, openf1Codes, codeToId);
    if (additions.length === 0) continue;

    for (const { driverId } of additions) {
      await q('insert into race_driver_pool(race_id, driver_id) values ($1,$2) on conflict do nothing', [race.id, driverId]);
    }

    const codes = additions.map((a) => infoById.get(a.driverId)?.code || a.driverId);
    const adminLines = additions
      .map((a) => `${infoById.get(a.driverId)?.code || a.driverId} (${infoById.get(a.driverId)?.name || '?'}) — источник: ${a.sources.join('+')}`)
      .join('\n');
    await sendTelegram(
      `🔄 Автопроверка состава — ${escapeHtml(race.name)}:\n${escapeHtml(adminLines)}`,
      readEnv('TELEGRAM_ADMIN_CHAT_ID'),
    );
    await sendTelegram(
      `🔄 Состав ${escapeHtml(race.name)} обновлён: добавлен${codes.length > 1 ? 'ы' : ''} ${escapeHtml(codes.join(', '))}.`,
    );
    console.log(`checkDriverPool: ${race.name} — добавлено ${codes.join(', ')}`);
  }
}
```

- [ ] **Step 2: Подключить в `main()`**

Найти в `scripts/telegram/notify.js`:
```js
async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results, remind, adminflush };
  if (!modes[mode]) {
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results|remind|adminflush`);
    process.exit(1);
  }
  await ensureCurrentWeekOpen();
  await raceweek(); // идемпотентна — подстраховка, если понедельничный слот пропал (см. её комментарий)
  await modes[mode]();
  await close();
}
```

Заменить на:
```js
async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results, remind, adminflush };
  if (!modes[mode]) {
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results|remind|adminflush`);
    process.exit(1);
  }
  await ensureCurrentWeekOpen();
  await raceweek(); // идемпотентна — подстраховка, если понедельничный слот пропал (см. её комментарий)
  if (mode === 'raceweek' || mode === 'deadline') await checkDriverPool();
  await modes[mode]();
  await close();
}
```

- [ ] **Step 3: Убедиться, что юнит-тесты всё ещё зелёные**

Run: `cd scripts/telegram && node notify.test.js`
Expected: `ВСЕ 21 PASS` (checkDriverPool не тестируется юнит-тестами — она делает реальные сетевые/БД
вызовы, проверяется вживую в Task 6).

- [ ] **Step 4: Commit**

```bash
git add scripts/telegram/notify.js
git commit -m "feat(telegram): checkDriverPool — автопроверка состава на raceweek/deadline-крон"
```

---

### Task 5: `.github/workflows/telegram-notify.yml` — установить зависимости `scripts/import`

**Проблема:** `checkDriverPool()` (Task 4) теперь требует `scripts/import/import.js`, которая требует
`scripts/import/lib.js`, которая требует пакет `pg`. Текущий workflow ставит `npm install` только для
`scripts/telegram`, `scripts/autoresults`, `scripts/ai-player` — без этого шага CI упадёт с
`Cannot find module 'pg'` на первом же `raceweek`/`deadline`-запуске.

**Files:**
- Modify: `.github/workflows/telegram-notify.yml:64-68`

- [ ] **Step 1: Добавить установку зависимостей `scripts/import`**

Найти:
```yaml
      - name: npm install
        run: |
          cd scripts/telegram && npm install
          cd ../autoresults && npm install
          cd ../ai-player && npm install
```

Заменить на:
```yaml
      - name: npm install
        run: |
          cd scripts/telegram && npm install
          cd ../autoresults && npm install
          cd ../ai-player && npm install
          cd ../import && npm install
```

- [ ] **Step 2: Проверить локально, что `scripts/import` действительно ставится этой же командой**

Run: `cd scripts/import && npm install`
Expected: `up to date` или установка без ошибок (пакет `pg` уже должен быть в `package-lock.json`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/telegram-notify.yml
git commit -m "ci(telegram-notify): ставить зависимости scripts/import — нужны checkDriverPool"
```

---

### Task 6: Ручная проверка бэкенд-части вживую

Реальный smoke без фикстур — используем текущую открытую гонку в БД (на момент написания это Italian
GP, round 13, id=15; если к моменту выполнения плана она уже `resulted`, проверить `select id, name,
status from races where status='open'` и подставить актуальный id/гонку).

**Files:** нет изменений, только запуск.

- [ ] **Step 1: Убедиться, что `.env` в корне проекта настроен** (уже должен быть — `SUPABASE_DB_URL`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_CHAT_ID`).

- [ ] **Step 2: Прогнать реальный `raceweek`-режим**

Run: `cd scripts/telegram && node notify.js raceweek`
Expected: в консоли строка `checkDriverPool: ...` — либо `нет открытых гонок`, либо `— добавлено ...`
(если Jolpica/OpenF1 к этому моменту знают о ком-то, кого нет в пуле — маловероятно, т.к. Цунода уже
добавлен вручную сегодня), без необработанных исключений. Само сообщение `raceweek` могло уже быть
отправлено ранее на этой неделе (идемпотентно, `raceweek_announced_at`) — это ожидаемо и не ошибка.

- [ ] **Step 3: Проверить в БД, что пул не пострадал**

Run: `cd scripts/db && node runner.js sql "select d.code from race_driver_pool p join drivers d on d.id=p.driver_id where p.race_id=(select id from races where status='open' order by round limit 1) order by d.code"`
Expected: тот же список пилотов, что и до запуска (включая `TSU`), плюс, возможно, новых, если реально
что-то подтянулось — никто не пропал (у `checkDriverPool()` нет удаления, только `insert ... on
conflict do nothing`).

- [ ] **Step 4: Никакого коммита — это только проверка поведения, изменений в файлах нет.**

---

### Task 7: `supabase/functions/admin-notify/format.ts` — `event_type: 'pool_change'`

**Files:**
- Modify: `supabase/functions/admin-notify/format.ts`
- Test: `supabase/functions/admin-notify/format.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `supabase/functions/admin-notify/format.test.ts`:

```ts
Deno.test('buildMessage: pool_change — добавлен в состав', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'TSU',
    driver_name: 'Yuki Tsunoda',
    action: 'added',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Yuki Tsunoda (TSU) добавлен в состав.');
});

Deno.test('buildMessage: pool_change — не участвует, с причиной', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'HAD',
    driver_name: 'Isack Hadjar',
    action: 'out',
    reason: 'Травма запястья',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Isack Hadjar (HAD) отмечен как не участвует — Травма запястья.');
});

Deno.test('buildMessage: pool_change — не участвует, без причины', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'HAD',
    driver_name: 'Isack Hadjar',
    action: 'out',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Isack Hadjar (HAD) отмечен как не участвует.');
});

Deno.test('buildMessage: pool_change — экранирует HTML в причине', () => {
  const text = buildMessage({
    event_type: 'pool_change',
    race_name: 'Italian Grand Prix',
    driver_code: 'HAD',
    driver_name: 'Isack Hadjar',
    action: 'out',
    reason: '<b>травма</b>',
  });
  assertEquals(text, '🔄 Italian Grand Prix: Isack Hadjar (HAD) отмечен как не участвует — &lt;b&gt;травма&lt;/b&gt;.');
});
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `cd supabase/functions/admin-notify && deno test format.test.ts`
Expected: ошибка типов (`event_type: 'pool_change'` не входит в `ResolvedEvent`) — `deno test` не
скомпилируется.

- [ ] **Step 3: Реализовать в `format.ts`**

Текущее:
```ts
export type ResolvedEvent =
  | { event_type: 'registration'; display_name: string }
  | { event_type: 'prediction'; display_name: string; race_name: string }
  | { event_type: 'result'; race_name: string };
```

Заменить на:
```ts
export type ResolvedEvent =
  | { event_type: 'registration'; display_name: string }
  | { event_type: 'prediction'; display_name: string; race_name: string }
  | { event_type: 'result'; race_name: string }
  | {
      event_type: 'pool_change';
      race_name: string;
      driver_code: string;
      driver_name: string;
      action: 'added' | 'out';
      reason?: string;
    };
```

Текущее:
```ts
export function buildMessage(event: ResolvedEvent): string {
  switch (event.event_type) {
    case 'registration':
      return `🆕 Новый участник: ${escapeHtml(event.display_name)}`;
    case 'prediction':
      return `📝 ${escapeHtml(event.display_name)} поставил прогноз на ${escapeHtml(event.race_name)}`;
    case 'result':
      return `🏁 Результат гонки ${escapeHtml(event.race_name)} занесён в систему`;
  }
}
```

Заменить на:
```ts
export function buildMessage(event: ResolvedEvent): string {
  switch (event.event_type) {
    case 'registration':
      return `🆕 Новый участник: ${escapeHtml(event.display_name)}`;
    case 'prediction':
      return `📝 ${escapeHtml(event.display_name)} поставил прогноз на ${escapeHtml(event.race_name)}`;
    case 'result':
      return `🏁 Результат гонки ${escapeHtml(event.race_name)} занесён в систему`;
    case 'pool_change': {
      const driver = `${escapeHtml(event.driver_name)} (${escapeHtml(event.driver_code)})`;
      if (event.action === 'added') {
        return `🔄 ${escapeHtml(event.race_name)}: ${driver} добавлен в состав.`;
      }
      const reason = event.reason ? ` — ${escapeHtml(event.reason)}` : '';
      return `🔄 ${escapeHtml(event.race_name)}: ${driver} отмечен как не участвует${reason}.`;
    }
  }
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `cd supabase/functions/admin-notify && deno test format.test.ts`
Expected: все тесты `ok` (было 9, стало 13).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/admin-notify/format.ts supabase/functions/admin-notify/format.test.ts
git commit -m "feat(admin-notify): event_type pool_change — текст сообщения о замене пилота"
```

---

### Task 8: `supabase/functions/admin-notify/index.ts` — обработка `pool_change` + отправка в общий чат

**Files:**
- Modify: `supabase/functions/admin-notify/index.ts`

- [ ] **Step 1: Добавить ветку `pool_change` в разбор `event_type`**

Найти:
```ts
    } else if (body.event_type === 'result') {
      const { data: race, error: raceError } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      resolved = { event_type: 'result', race_name: race?.name ?? '(неизвестная гонка)' };
    } else {
      return Response.json({ error: `неизвестный event_type: ${body.event_type}` }, { status: 400 });
    }
```

Заменить на:
```ts
    } else if (body.event_type === 'result') {
      const { data: race, error: raceError } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      resolved = { event_type: 'result', race_name: race?.name ?? '(неизвестная гонка)' };
    } else if (body.event_type === 'pool_change') {
      const driversTable = supabaseAdmin.from('drivers') as any;
      const { data: race, error: raceError } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      const { data: driver, error: driverError } = await driversTable
        .select('code, name')
        .eq('id', body.payload?.driver_id)
        .maybeSingle();
      if (driverError) {
        console.error(`admin-notify: ошибка lookup drivers (id=${body.payload?.driver_id}):`, driverError.message);
      }
      const action = body.payload?.action === 'out' ? 'out' : 'added';
      const reason = typeof body.payload?.reason === 'string' ? body.payload.reason : undefined;
      resolved = {
        event_type: 'pool_change',
        race_name: race?.name ?? '(неизвестная гонка)',
        driver_code: driver?.code ?? '?',
        driver_name: driver?.name ?? '(неизвестный пилот)',
        action,
        reason,
      };
    } else {
      return Response.json({ error: `неизвестный event_type: ${body.event_type}` }, { status: 400 });
    }
```

- [ ] **Step 2: Добавить немедленную и безусловную отправку в общий чат для `pool_change`**

Найти:
```ts
    const text = buildMessage(resolved);

    if (isQuietHours(new Date())) {
```

Заменить на:
```ts
    const text = buildMessage(resolved);

    // pool_change — редкое и важное для игроков сообщение (замена/травма пилота), в отличие от
    // registration/prediction (породивших правило тихих часов) откладывать на утро не нужно —
    // уходит в общий чат сразу и безусловно, независимо от тихих часов админ-чата ниже.
    if (resolved.event_type === 'pool_change') {
      const generalChatId = Deno.env.get('TELEGRAM_CHAT_ID');
      if (!generalChatId) {
        return Response.json({ error: 'TELEGRAM_CHAT_ID не настроен' }, { status: 500 });
      }
      const generalRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: generalChatId, text, parse_mode: 'HTML' }),
      });
      const generalData = await generalRes.json();
      if (!generalData.ok) {
        return Response.json({ error: `Telegram API error (общий чат): ${JSON.stringify(generalData)}` }, { status: 500 });
      }
    }

    if (isQuietHours(new Date())) {
```

(Дальше — существующая логика тихих часов/немедленной отправки в `ADMIN_CHAT_ID` остаётся без
изменений, она выполняется для ВСЕХ event_type, включая `pool_change`.)

- [ ] **Step 3: Проверить типы (Deno)**

Run: `cd supabase/functions/admin-notify && deno check index.ts`
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/admin-notify/index.ts
git commit -m "feat(admin-notify): pool_change — шлёт и в общий, и в админ-чат"
```

---

### Task 9: `src/lib/db.ts` — `addDriverToPool`, `setDriverOutReason`, `notifyPoolChange`

**Files:**
- Modify: `src/lib/db.ts` (добавить после `listDrivers`, перед секцией `// ===== Гостевой доступ`)

- [ ] **Step 1: Добавить функции**

Вставить перед строкой `// ===== Гостевой доступ (read-only без аккаунта, Фаза 6) =====`:

```ts
// ===== Состав пилотов гонки (правка вручную из Админки, замена SQL-костыля) =====

// Best-effort: у браузера нет TELEGRAM_BOT_TOKEN, поэтому сообщение шлёт Edge Function admin-notify
// (тот же паттерн, что уже используют триггеры registration/prediction/result). Сбой уведомления не
// должен ронять сохранение состава — только выводится в консоль для отладки.
async function notifyPoolChange(payload: {
  race_id: number;
  driver_id: string;
  action: 'added' | 'out';
  reason?: string;
}): Promise<void> {
  try {
    await supabase.functions.invoke('admin-notify', {
      body: { event_type: 'pool_change', payload },
      timeout: 8000,
    });
  } catch (e) {
    console.warn('notifyPoolChange: не удалось отправить уведомление', e);
  }
}

export async function addDriverToPool(raceId: number, driverId: string): Promise<void> {
  await withRetry(async () => {
    const { error } = await supabase
      .from('race_driver_pool')
      .insert({ race_id: raceId, driver_id: driverId });
    if (error) throw error;
  });
  await notifyPoolChange({ race_id: raceId, driver_id: driverId, action: 'added' });
}

export async function setDriverOutReason(raceId: number, driverId: string, reason: string | null): Promise<void> {
  await withRetry(async () => {
    const { error } = await supabase
      .from('race_driver_pool')
      .update({ out_reason: reason })
      .eq('race_id', raceId)
      .eq('driver_id', driverId);
    if (error) throw error;
  });
  if (reason) {
    await notifyPoolChange({ race_id: raceId, driver_id: driverId, action: 'out', reason });
  }
}
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc -b`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(db): addDriverToPool/setDriverOutReason — правка пула из Админки, не из SQL"
```

---

### Task 10: `src/pages/AdminPool.tsx` — новая страница

**Files:**
- Create: `src/pages/AdminPool.tsx`

- [ ] **Step 1: Написать страницу**

```tsx
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, listDrivers, addDriverToPool, setDriverOutReason } from '../lib/db';
import type { Driver, Race } from '../lib/types';

export default function AdminPool() {
  const { raceId } = useParams();
  const nav = useNavigate();
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [allDrivers, setAllDrivers] = useState<Driver[]>([]);
  const [addId, setAddId] = useState('');
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const [{ race, pool }, drivers] = await Promise.all([
          getRaceWithPool(Number(raceId)),
          listDrivers(),
        ]);
        setRace(race);
        setPool(pool);
        setAllDrivers(drivers);
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);

  const poolIds = new Set(pool.map((d) => d.id));
  const candidates = allDrivers.filter((d) => !poolIds.has(d.id));

  async function onAdd() {
    if (!race || !addId) return;
    setBusyId(addId);
    setErr('');
    setMsg('');
    try {
      await addDriverToPool(race.id, addId);
      setMsg('Пилот добавлен в пул');
      setAddId('');
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось добавить');
    } finally {
      setBusyId(null);
    }
  }

  async function onMarkOut(driverId: string) {
    if (!race) return;
    const reason = (reasonDrafts[driverId] || '').trim();
    if (!reason) return;
    setBusyId(driverId);
    setErr('');
    setMsg('');
    try {
      await setDriverOutReason(race.id, driverId, reason);
      setMsg('Пилот помечен как не участвует');
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось сохранить');
    } finally {
      setBusyId(null);
    }
  }

  async function onClearOut(driverId: string) {
    if (!race) return;
    setBusyId(driverId);
    setErr('');
    try {
      await setDriverOutReason(race.id, driverId, null);
      setReload((n) => n + 1);
    } catch (e: any) {
      setErr(e.message || 'Не удалось снять пометку');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="stub">Загрузка…</div>;
  if (err && !race)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={() => setReload((n) => n + 1)}>Повторить</button>
      </div>
    );
  if (!race) return <div className="stub">Загрузка…</div>;

  return (
    <div className="admin">
      <h1 className="admin-h1">Состав пилотов: {race.name}</h1>
      {err && <p className="auth-err">{err}</p>}
      {msg && <p className="ok-note">{msg}</p>}

      <div className="admin-list">
        {pool.map((d) => (
          <div key={d.id} className="admin-row">
            <div className="admin-race">
              <span className="race-name">{d.code} — {d.name}</span>
              {d.out_reason && <span className="chip-dnf">DNF</span>}
            </div>
            <div className="admin-actions">
              {d.out_reason ? (
                <>
                  <span className="lock-note">{d.out_reason}</span>
                  <button disabled={busyId === d.id} onClick={() => onClearOut(d.id)}>
                    {busyId === d.id ? '…' : 'Снять пометку'}
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="reason-input"
                    placeholder="причина (напр. травма)"
                    value={reasonDrafts[d.id] || ''}
                    onChange={(e) => setReasonDrafts((prev) => ({ ...prev, [d.id]: e.target.value }))}
                  />
                  <button
                    disabled={busyId === d.id || !(reasonDrafts[d.id] || '').trim()}
                    onClick={() => onMarkOut(d.id)}
                  >
                    {busyId === d.id ? '…' : 'Пометить как не участвует'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="admin-row">
        <div className="admin-race">
          <select value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Выбери пилота…</option>
            {candidates.map((d) => (
              <option key={d.id} value={d.id}>{d.code} — {d.name}</option>
            ))}
          </select>
        </div>
        <div className="admin-actions">
          <button disabled={!addId || busyId === addId} onClick={onAdd}>
            {busyId === addId ? '…' : 'Добавить в пул'}
          </button>
        </div>
      </div>

      <button className="retry-btn" onClick={() => nav('/admin')}>Назад в Админку</button>
    </div>
  );
}
```

Использует только уже существующие CSS-классы (`admin`, `admin-h1`, `admin-list`, `admin-row`,
`admin-race`, `race-name`, `admin-actions`, `chip-dnf`, `lock-note`, `reason-input`, `retry-btn`,
`auth-err`, `ok-note`) — новых стилей не нужно.

- [ ] **Step 2: Проверить типы**

Run: `npx tsc -b`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/pages/AdminPool.tsx
git commit -m "feat(admin): страница /admin/pool/:raceId — ручная правка состава без SQL"
```

---

### Task 11: Роут и кнопка — `src/App.tsx`, `src/pages/Admin.tsx`

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/pages/Admin.tsx`

- [ ] **Step 1: Добавить импорт и роут в `App.tsx`**

Найти:
```tsx
import Admin from './pages/Admin';
import AdminResult from './pages/AdminResult';
```
Заменить на:
```tsx
import Admin from './pages/Admin';
import AdminResult from './pages/AdminResult';
import AdminPool from './pages/AdminPool';
```

Найти:
```tsx
            <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
            <Route path="/admin/result/:raceId" element={<AdminRoute><AdminResult /></AdminRoute>} />
```
Заменить на:
```tsx
            <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
            <Route path="/admin/result/:raceId" element={<AdminRoute><AdminResult /></AdminRoute>} />
            <Route path="/admin/pool/:raceId" element={<AdminRoute><AdminPool /></AdminRoute>} />
```

- [ ] **Step 2: Добавить кнопку в `Admin.tsx`**

Найти в `src/pages/Admin.tsx`:
```tsx
              <div className="admin-actions">
                {upcoming && (
                  <button disabled={busyId === r.id} onClick={() => onOpen(r.id)}>
                    {busyId === r.id ? '…' : 'Открыть гонку'}
                  </button>
                )}
                {opened && (
                  <button onClick={() => nav(`/admin/result/${r.id}`)}>Занести результат</button>
                )}
                {resulted && (
                  <>
                    <button onClick={() => nav(`/admin/result/${r.id}`)}>✏ Редактировать результат</button>
                    <span className="admin-badge">результат ✓</span>
                  </>
                )}
              </div>
```
Заменить на:
```tsx
              <div className="admin-actions">
                {upcoming && (
                  <button disabled={busyId === r.id} onClick={() => onOpen(r.id)}>
                    {busyId === r.id ? '…' : 'Открыть гонку'}
                  </button>
                )}
                {(opened || resulted) && (
                  <button onClick={() => nav(`/admin/pool/${r.id}`)}>Состав пилотов</button>
                )}
                {opened && (
                  <button onClick={() => nav(`/admin/result/${r.id}`)}>Занести результат</button>
                )}
                {resulted && (
                  <>
                    <button onClick={() => nav(`/admin/result/${r.id}`)}>✏ Редактировать результат</button>
                    <span className="admin-badge">результат ✓</span>
                  </>
                )}
              </div>
```

- [ ] **Step 3: Проверить типы и сборку**

Run: `npx tsc -b && npm run build`
Expected: без ошибок, `dist/` собирается.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/pages/Admin.tsx
git commit -m "feat(admin): кнопка «Состав пилотов» на список гонок"
```

---

### Task 12: Деплой `admin-notify` (секрет `TELEGRAM_CHAT_ID`) + смоук

**Files:** нет изменений в коде, только деплой существующей функции с новым секретом.

- [ ] **Step 1: Задать секрет и задеплоить (PowerShell)**

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$env:SUPABASE_ACCESS_TOKEN = (Select-String -Path .env -Pattern '^SUPABASE_ACCESS_TOKEN=(.+)$').Matches[0].Groups[1].Value
$env:CHAT = (Select-String -Path .env -Pattern '^TELEGRAM_CHAT_ID=(.+)$').Matches[0].Groups[1].Value
supabase secrets set TELEGRAM_CHAT_ID=$env:CHAT --project-ref kolrwuhjjsclqalapfzt
supabase functions deploy admin-notify --project-ref kolrwuhjjsclqalapfzt --use-api
```
Expected: `Deployed Function admin-notify` без ошибок. `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ADMIN_CHAT_ID` уже
существуют как секреты проекта (заданы раньше) — повторно не нужны.

- [ ] **Step 2: Ручной смоук — вызвать функцию напрямую с `pool_change`**

```powershell
$env:ANON_KEY = (Select-String -Path .env.local -Pattern 'VITE_SUPABASE_ANON_KEY=(.+)').Matches[0].Groups[1].Value
$env:PROJECT_URL = (Select-String -Path .env.local -Pattern 'VITE_SUPABASE_URL=(.+)').Matches[0].Groups[1].Value
Invoke-RestMethod -Uri "$env:PROJECT_URL/functions/v1/admin-notify" -Method Post `
  -Headers @{ apikey = $env:ANON_KEY; Authorization = "Bearer $env:ANON_KEY" } `
  -ContentType 'application/json' `
  -Body '{"event_type":"pool_change","payload":{"race_id":15,"driver_id":"tsunoda","action":"added"}}'
```
Expected: ответ `{ sent: true }` (или `{ queued: true }`, если сейчас тихие часы 22:00–10:00 МСК для
админ-чата — в любом случае в **общий** чат сообщение должно прийти сразу, независимо от времени
суток). Проверить оба чата вживую — должно прийти «🔄 Italian Grand Prix: Yuki Tsunoda (TSU) добавлен
в состав.» (замени `race_id`/`driver_id` на реальные, если Italian GP к этому моменту уже не `open`).

- [ ] **Step 3: Никакого коммита — это только деплой и проверка.**

---

### Task 13: Итоговая проверка UI вживую

- [ ] **Step 1: Запустить дев-сервер**

Run: `npm run dev`

- [ ] **Step 2: Открыть `/admin/pool/<id открытой гонки>` под админским аккаунтом**

Проверить:
- Текущий пул отображается, у Аджара — бейдж DNF и его `out_reason` текстом.
- В выпадающем списке нет пилотов, уже находящихся в пуле.
- Добавление пилота из списка → появляется в пуле без перезагрузки страницы, приходит сообщение в оба
  Telegram-чата (может прийти не сразу для общего чата — сеть до Telegram API из Edge Function).
- Простановка причины у пилота без `out_reason` → появляется бейдж DNF, приходит сообщение в оба чата
  с причиной.
- «Снять пометку» убирает бейдж, новых сообщений не шлёт (по дизайну — снятие не уведомляется).

- [ ] **Step 3: Финальный прогон тестов и типов**

Run:
```bash
cd scripts/telegram && node notify.test.js
cd ../../supabase/functions/admin-notify && deno test format.test.ts
cd ../../.. && npx tsc -b && npm run build
```
Expected: всё зелёное.

- [ ] **Step 4: Не пушить без явного запроса** — по договорённости проекта, `git push` делается
только по прямой команде пользователя (см. `MEMORY.md`).
