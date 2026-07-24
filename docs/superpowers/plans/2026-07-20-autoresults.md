# Автозабор результатов гонки — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** После того как гонка прошла, автоматически найти её результат (Jolpica → OpenF1 как резерв) и
занести через уже существующий RPC `set_race_result()`; если оба источника молчат к понедельнику —
напомнить в Telegram, что нужно занести вручную.

**Architecture:** Новая папка `scripts/autoresults/` (cloud-direct к Postgres, `fetch` к двум внешним
API) на той же ветке `telegram-notify`. Существующий workflow `telegram-notify.yml` расширяется:
на 2-часовом cron сначала пробует автозабор, потом уже существующее объявление в Telegram; на
понедельничном cron — уже существующий `raceweek` плюс новый `remind`.

**Tech Stack:** Node.js (CommonJS), `pg`, встроенный `fetch` (Jolpica REST + OpenF1 REST).

Сверено с `docs/constitution.md`. Спека: `docs/superpowers/specs/2026-07-20-autoresults-design.md`.
Дополняет уже открытую ветку `telegram-notify` (не отдельная ветка).

---

### Task 1: Каркас `scripts/autoresults/`

**Files:**
- Create: `scripts/autoresults/package.json`
- Create: `scripts/autoresults/lib.js`

- [ ] **Step 1: Создать `scripts/autoresults/package.json`**

```json
{
  "name": "f1-predict-autoresults",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "fetch": "node fetch.js"
  }
}
```

- [ ] **Step 2: Установить зависимости**

Run: `cd scripts/autoresults && npm install pg`
Expected: создаются `node_modules/`, `package-lock.json`; `package.json` дополняется `dependencies.pg`.

- [ ] **Step 3: Написать `scripts/autoresults/lib.js`**

```js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Читает переменную напрямую из корневого .env (по образцу scripts/telegram/lib.js).
function readEnv(key) {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} не найден в .env`);
  return m[1].trim();
}

let client = null;
async function ensure() {
  if (client) return client;
  client = new Client({
    connectionString: readEnv('SUPABASE_DB_URL'),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  return client;
}

async function q(text, params) {
  const c = await ensure();
  return c.query(text, params);
}

async function close() {
  if (client) {
    try {
      await client.end();
    } catch (_) {
      /* уже закрыт */
    }
    client = null;
  }
}

module.exports = { readEnv, q, close };
```

- [ ] **Step 4: Синтаксическая проверка**

Run: `cd scripts/autoresults && node --check lib.js`
Expected: без вывода, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoresults/package.json scripts/autoresults/package-lock.json scripts/autoresults/lib.js
git commit -m "feat(autoresults): каркас scripts/autoresults — подключение к БД"
```

---

### Task 2: `jolpica.js` — основной источник

**Files:**
- Create: `scripts/autoresults/jolpica.js`

- [ ] **Step 1: Написать `scripts/autoresults/jolpica.js`**

```js
// Основной источник результатов — Jolpica (Ergast-совместимый REST).
// Тот же эндпоинт, что уже использовался в scripts/import/import.js для разовой загрузки истории.
async function fetchJolpicaResults(round) {
  const res = await fetch(`https://api.jolpi.ca/ergast/f1/2026/${round}/results.json?limit=100`);
  if (!res.ok) throw new Error(`Jolpica HTTP ${res.status}`);
  const data = await res.json();
  const races = data.MRData.RaceTable.Races;
  if (!races.length || !races[0].Results || races[0].Results.length < 10) return null;
  return races[0].Results
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position))
    .slice(0, 10)
    .map((r) => r.Driver.driverId);
}

module.exports = { fetchJolpicaResults };
```

- [ ] **Step 2: Проверить на реальном раунде (Бельгия, round 10 — гонка уже прошла 2026-07-19)**

Run: `cd scripts/autoresults && node -e "require('./jolpica').fetchJolpicaResults(10).then(r => console.log(JSON.stringify(r)))"`
Expected: либо массив из 10 driver-id строк (если Jolpica уже классифицировала гонку — вероятно, раз
гонка была позавчера), либо `null` (если ещё не готово — тоже нормальный результат на этом шаге, не
ошибка; функция обязана возвращать `null`, а не падать, пока источник не готов).

- [ ] **Step 3: Синтаксическая проверка**

Run: `node --check jolpica.js`
Expected: без вывода, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/autoresults/jolpica.js
git commit -m "feat(autoresults): jolpica.js — основной источник результатов"
```

---

### Task 3: `openf1.js` — резервный источник

**Files:**
- Create: `scripts/autoresults/openf1.js`

- [ ] **Step 1: Написать `scripts/autoresults/openf1.js`**

```js
// Резервный источник — OpenF1. Сессия гонки ищется по дате (надёжнее парсинга англ. названия страны
// из races.name), позиции сопоставляются с нашими drivers через driver_number -> name_acronym -> code.
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // ±3 дня — гонка должна попасть в это окно, иначе не она

async function findSessionKey(raceDatetimeUtc) {
  const res = await fetch('https://api.openf1.org/v1/sessions?year=2026&session_name=Race');
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
  if (!best || bestDiff > WINDOW_MS) return null;
  return best.session_key;
}

async function fetchOpenF1Results(raceDatetimeUtc, driverCodeToId) {
  const sessionKey = await findSessionKey(raceDatetimeUtc);
  if (!sessionKey) return null;

  const [resultsRes, driversRes] = await Promise.all([
    fetch(`https://api.openf1.org/v1/session_result?session_key=${sessionKey}`),
    fetch(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`),
  ]);
  if (!resultsRes.ok) throw new Error(`OpenF1 session_result HTTP ${resultsRes.status}`);
  if (!driversRes.ok) throw new Error(`OpenF1 drivers HTTP ${driversRes.status}`);

  const results = await resultsRes.json();
  const drivers = await driversRes.json();
  if (results.length < 10) return null;

  const numberToCode = new Map(drivers.map((d) => [d.driver_number, d.name_acronym]));
  const top10 = results
    .slice()
    .sort((a, b) => a.position - b.position)
    .slice(0, 10)
    .map((r) => {
      const code = numberToCode.get(r.driver_number);
      return code ? driverCodeToId.get(code) : undefined;
    });
  if (top10.some((id) => !id)) return null; // не смогли сопоставить кого-то — не рискуем занести неполные данные

  return top10;
}

module.exports = { fetchOpenF1Results };
```

- [ ] **Step 2: Проверить на реальной дате Бельгии**

Сначала получить карту code→id пилотов напрямую из БД (из `scripts/db/`):
```bash
cd scripts/db
node runner.js sql "select id, code from drivers"
```
Взять вывод, вручную собрать JS-объект вида `{VER:'max_verstappen', HAM:'hamilton', ...}` (или
использовать реальный вывод programmatically в следующей команде — главное свериться, что коды
совпадают с `name_acronym` из OpenF1).

Run (из `scripts/autoresults/`, `raceDatetimeUtc` — реальное время старта Бельгии из БД,
`2026-07-19T13:00:00.000Z`):
```bash
node -e "
const { q, close } = require('./lib');
const { fetchOpenF1Results } = require('./openf1');
(async () => {
  const { rows } = await q('select id, code from drivers');
  const codeToId = new Map(rows.map(r => [r.code, r.id]));
  const result = await fetchOpenF1Results('2026-07-19T13:00:00.000Z', codeToId);
  console.log(JSON.stringify(result));
  await close();
})();
"
```
Expected: массив из 10 driver-id (если OpenF1 успел проиндексировать сессию) либо `null` (тоже
нормально — не каждая гонка сразу появляется в OpenF1). Главное — команда не должна упасть с
необработанной ошибкой.

- [ ] **Step 3: Синтаксическая проверка**

Run: `cd scripts/autoresults && node --check openf1.js`
Expected: без вывода, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/autoresults/openf1.js
git commit -m "feat(autoresults): openf1.js — резервный источник результатов"
```

---

### Task 4: `fetch.js` — оркестрация

**Files:**
- Create: `scripts/autoresults/fetch.js`

- [ ] **Step 1: Проверить запрос «просроченные open-гонки» напрямую через раннер**

Run (из `scripts/db/`):
```bash
node runner.js sql "select id, round, name, race_datetime_utc from races where status='open' and race_datetime_utc < now() order by round"
```
Expected: как минимум одна строка — Бельгия (round 10), раз её результат ещё не занесён.

- [ ] **Step 2: Написать `scripts/autoresults/fetch.js`**

```js
const { q, close } = require('./lib');
const { fetchJolpicaResults } = require('./jolpica');
const { fetchOpenF1Results } = require('./openf1');

async function driverCodeToIdMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((d) => [d.code, d.id]));
}

async function main() {
  const { rows: races } = await q(
    `select id, round, name, race_datetime_utc from races where status = 'open' and race_datetime_utc < now() order by round`,
  );
  if (races.length === 0) {
    console.log('autoresults: просроченных гонок нет');
    await close();
    return;
  }

  const codeToId = await driverCodeToIdMap();

  for (const r of races) {
    let positions = await fetchJolpicaResults(r.round);
    let source = 'Jolpica';
    if (!positions) {
      positions = await fetchOpenF1Results(r.race_datetime_utc, codeToId);
      source = 'OpenF1';
    }
    if (!positions) {
      console.log(`autoresults: ${r.name} — источники пока пусты`);
      continue;
    }
    await q('select set_race_result($1, $2::jsonb)', [r.id, JSON.stringify(positions)]);
    console.log(`autoresults: ${r.name} — занесено (${source})`);
  }

  await close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
```

- [ ] **Step 3: Синтаксическая проверка (БЕЗ реального запуска — реальный запуск это отдельная,
      сознательная Task 7, после ревью всей цепочки)**

Run: `cd scripts/autoresults && node --check fetch.js`
Expected: без вывода, exit 0.

**ВАЖНО:** не запускать `node fetch.js` по-настоящему на этом шаге — он вызовет `set_race_result()`
против боевой БД и реально занесёт результат Бельгии, если источники его нашли. Это осознанно
отложено до Task 7 (после того как весь код пройдёт ревью).

- [ ] **Step 4: Commit**

```bash
git add scripts/autoresults/fetch.js
git commit -m "feat(autoresults): fetch.js — оркестрация Jolpica→OpenF1→set_race_result"
```

---

### Task 5: Режим `remind` в `scripts/telegram/notify.js`

**Files:**
- Modify: `scripts/telegram/notify.js`

- [ ] **Step 1: Добавить функцию `remind` перед `main`**

Найти в файле блок:
```js
async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results };
```

Заменить на:
```js
async function remind() {
  const { rows } = await q(`
    select id, round, name
    from races
    where status = 'open' and race_datetime_utc < now()
    order by round
  `);
  if (rows.length === 0) {
    console.log('remind: просроченных гонок нет');
    return;
  }
  for (const r of rows) {
    const text =
      `⚠️ Автопоиск не нашёл результат <b>${escapeHtml(r.name)}</b> — занеси вручную в Админке.\n` +
      `${SITE_URL}/admin`;
    await sendTelegram(text);
    console.log(`remind: отправлено для ${r.name}`);
  }
}

async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results, remind };
```

(`escapeHtml`, `q`, `sendTelegram`, `SITE_URL` уже определены выше в этом файле — переиспользуются,
ничего дополнительно импортировать не нужно.)

- [ ] **Step 2: Синтаксическая проверка**

Run: `cd scripts/telegram && node --check notify.js`
Expected: без вывода, exit 0.

- [ ] **Step 3: Проверить SQL-запрос режима напрямую (тот же, что уже проверяли для fetch.js Task 4 —
      здесь просто подтверждаем, что и notify.js использует идентичную выборку)**

Run (из `scripts/db/`):
```bash
node runner.js sql "select id, round, name from races where status='open' and race_datetime_utc < now() order by round"
```
Expected: та же Бельгия, что и в Task 4 Step 1.

- [ ] **Step 4: Commit**

```bash
git add scripts/telegram/notify.js
git commit -m "feat(telegram): режим remind — напоминание об отсутствующем результате"
```

---

### Task 6: Обновить workflow — цепочка автозабор→объявление, raceweek→remind

**Files:**
- Modify: `.github/workflows/telegram-notify.yml`

- [ ] **Step 1: Заменить весь файл на новую версию**

Текущий файл целиком заменяется на:

```yaml
name: telegram-notify
# Напоминания, автозабор и итоги гонок в общий Telegram-чат (спеки
# docs/superpowers/specs/2026-07-19-telegram-notify-design.md,
# docs/superpowers/specs/2026-07-20-autoresults-design.md). Расписание в UTC, МСК = UTC+3
# (в России нет перехода на летнее время).
on:
  schedule:
    - cron: '0 7 * * 1'    # Пн 10:00 МСК — raceweek + remind
    - cron: '0 7 * * 3'    # Ср 10:00 МСК — deadline
    - cron: '0 16 * * 3'   # Ср 19:00 МСК — deadline
    - cron: '0 7 * * 4'    # Чт 10:00 МСК — deadline
    - cron: '0 16 * * 4'   # Чт 19:00 МСК — deadline
    - cron: '0 */2 * * *'  # каждые 2 часа — autoresults (забор) + results (объявление)
  workflow_dispatch:
    inputs:
      mode:
        description: 'Режим (для ручного запуска)'
        required: true
        type: choice
        options: [raceweek, deadline, results, remind, autoresults]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Определить режимы
        id: mode
        run: |
          if [ -n "${{ inputs.mode }}" ]; then
            echo "modes=${{ inputs.mode }}" >> "$GITHUB_OUTPUT"
          else
            case "${{ github.event.schedule }}" in
              '0 7 * * 1') echo "modes=raceweek remind" >> "$GITHUB_OUTPUT" ;;
              '0 7 * * 3'|'0 16 * * 3'|'0 7 * * 4'|'0 16 * * 4') echo "modes=deadline" >> "$GITHUB_OUTPUT" ;;
              '0 */2 * * *') echo "modes=autoresults results" >> "$GITHUB_OUTPUT" ;;
              *) echo "ERR неизвестное расписание: ${{ github.event.schedule }}"; exit 1 ;;
            esac
          fi
      - name: Записать .env для scripts/telegram и scripts/autoresults
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          cat > .env <<EOF
          SUPABASE_DB_URL=$SUPABASE_DB_URL
          TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
          TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
          EOF
      - name: npm install
        run: |
          cd scripts/telegram && npm install
          cd ../autoresults && npm install
      - name: Запустить режимы
        run: |
          for m in ${{ steps.mode.outputs.modes }}; do
            if [ "$m" = "autoresults" ]; then
              node scripts/autoresults/fetch.js
            else
              node scripts/telegram/notify.js "$m"
            fi
          done
```

- [ ] **Step 2: Проверить YAML на валидность синтаксиса**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/telegram-notify.yml'))" 2>&1`
Expected: тихий успех (без вывода/ошибки). Если `python3` недоступен на машине — визуально сверить
отступы с версией файла до этого изменения (тот же общий стиль: `on:`/`jobs:`/`steps:`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/telegram-notify.yml
git commit -m "feat(autoresults): workflow — цепочка autoresults→results, raceweek→remind"
```

---

### Task 7: Реальный смоук (боевая Бельгия) + финальное ревью + мерж

**Files:** нет новых файлов — только запуск, проверка, при необходимости точечные фиксы.

- [ ] **Step 1: Запустить автозабор по-настоящему**

Требует, чтобы в корневом `.env` уже был `SUPABASE_DB_URL` (он там есть с самого начала проекта).

Run: `cd scripts/autoresults && node fetch.js`
Expected: один из двух исходов —
  - `autoresults: Belgian Grand Prix — занесено (Jolpica)` (или `(OpenF1)`) — источник нашёл результат,
    RPC отработал. Дальше сверить в БД: `races.status='resulted', scored=true` для round 10.
  - `autoresults: Belgian Grand Prix — источники пока пусты` — оба источника ещё не готовы. Это НЕ
    провал автоматики (гонка реальная, сроки классификации у Jolpica/OpenF1 вне нашего контроля) —
    просто подожди и прогони ещё раз позже, либо (по договорённости с пользователем) занеси Бельгию
    вручную через Админку прямо сейчас, автоматика подхватит уже следующую просроченную гонку.

- [ ] **Step 2: Если результат занесён — проверить, что Telegram-объявление сработало следом**

Run: `cd ../telegram && node notify.js results`
Expected: если `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` уже настроены (Task 7 из плана
`2026-07-19-telegram-notify.md`) — сообщение с топ-10 и очками пришло в чат; `races.telegram_announced_at`
проставлен. Если секреты бота ещё не настроены — эта проверка недоступна, пропустить (не блокирует
мерж автозабора — это отдельная, уже принятая функциональность).

- [ ] **Step 3: Проверить `remind`, если результат НЕ занесён на шаге 1**

Run: `cd ../telegram && node notify.js remind`
Expected: сообщение «Автопоиск не нашёл результат Belgian Grand Prix — занеси вручную» пришло в чат
(если секреты бота настроены) либо команда завершилась без ошибки (если секретов ещё нет — тогда
`sendTelegram` упадёт с понятной ошибкой `TELEGRAM_BOT_TOKEN не найден в .env`, что ожидаемо и не
является багом кода).

- [ ] **Step 4: Проверить workflow вручную через `workflow_dispatch`**

Во вкладке Actions репозитория — запустить `telegram-notify` с режимом `autoresults`, затем (если
применимо) `remind` — убедиться, что job проходит зелёным на реальном GitHub-раннере (не только
локально).

- [ ] **Step 5: Финальное ревью ветки и мерж**

Использовать `superpowers:finishing-a-development-branch` — ревью всего диффа ветки `telegram-notify`
целиком (обе фичи: напоминания/итоги + автозабор), сверка с обеими спеками, затем мерж в `main`.
После мержа `git push origin main` — расписание GitHub Actions активируется только для файлов на
дефолтной ветке.

---

## Self-Review

**Spec coverage:** §4 (файлы) → Task 1 (lib.js), Task 2 (jolpica.js), Task 3 (openf1.js), Task 4
(fetch.js), Task 5 (remind), Task 6 (workflow). §5 (jolpica.js логика) → Task 2, код идентичен спеке.
§6 (openf1.js логика, сопоставление по дате+driver_number→acronym→code) → Task 3, идентично. §7
(fetch.js оркестрация, RPC вместо прямой записи) → Task 4. §8 (remind) → Task 5. §9 (порядок шагов
workflow) → Task 6, cron→modes маппинг точно по спеке (`raceweek remind` / `deadline` / `autoresults
results`). §10 (тестирование — реальная Бельгия, без фикстуры) → Task 7. §11 (вне скоупа) — ничего
лишнего не добавлено (без provisional, без автосинка пилотов, без отдельного «занесено автоматически»
текста, без ретраев внутри скриптов).

**Placeholder scan:** нет TBD/TODO. Весь код полный. Команды — с ожидаемым выводом, включая явно
допустимые «оба исхода нормальны» там, где результат зависит от реального состояния внешних API
(Task 2 Step 2, Task 3 Step 2, Task 7 Step 1) — это не расплывчатость, а честное описание того, что
подтверждает шаг (что функция не падает и возвращает валидный тип, а не что она гарантированно найдёт
данные, которые ей не подконтрольны).

**Type consistency:** `q`/`close`/`readEnv` в `scripts/autoresults/lib.js` (Task 1) используются с теми
же именами в `fetch.js` (Task 4). `fetchJolpicaResults(round)` (Task 2) и `fetchOpenF1Results(raceDatetimeUtc,
driverCodeToId)` (Task 3) вызываются в `fetch.js` (Task 4) с теми же сигнатурами. `escapeHtml`/`q`/
`sendTelegram`/`SITE_URL`, на которые ссылается новый `remind()` (Task 5), уже определены в существующем
`notify.js` (проверено чтением актуального файла перед написанием плана) — не выдуманы. Названия режимов
(`raceweek`/`deadline`/`results`/`remind`/`autoresults`) совпадают между `notify.js`'s `modes`-объектом,
workflow's `case`-веткой и `workflow_dispatch.inputs.mode.options`.
