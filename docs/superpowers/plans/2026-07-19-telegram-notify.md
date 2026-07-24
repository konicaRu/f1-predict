# Telegram-напоминания и итоги гонок — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматические сообщения в общий Telegram-чат лиги по расписанию GitHub Actions: анонс
RACE WEEK по понедельникам, напоминания о дедлайне ср/чт дважды в день, итоги гонки как только
результат занесён финально (без повтора при правке).

**Architecture:** `scripts/telegram/notify.js` (cloud-direct к Postgres, `pg` + встроенный `fetch`
в Telegram Bot API) — один скрипт, режим `raceweek|deadline|results` первым аргументом.
`.github/workflows/telegram-notify.yml` дёргает его по расписанию (6 cron-триггеров) — та же
проверенная механика, что уже работает в `deploy.yml`/`keepalive.yml`. Официальное отступление от
конституции §4 (pg_cron→GitHub Actions) документируется в этом же плане.

**Tech Stack:** Node.js (CommonJS), `pg`, встроенный `fetch` (Node ≥18), GitHub Actions `schedule`.

Сверено с `docs/constitution.md`. Спека: `docs/superpowers/specs/2026-07-19-telegram-notify-design.md`.

---

### Task 1: Миграция — колонка `telegram_announced_at`

**Files:**
- Create: `supabase/migrations/0011_telegram_announced.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- 0011_telegram_announced.sql — трекинг «результат уже объявлен в Telegram».
-- Нужен, чтобы override уже занесённого результата (правка через Admin) НЕ слал повторное
-- сообщение в чат — шлём только один раз на гонку, при первом переходе в resulted+scored.
alter table public.races add column if not exists telegram_announced_at timestamptz;
```

- [ ] **Step 2: Применить миграцию к облаку**

Run (из `scripts/db/`):
```bash
node runner.js applyfile ../../supabase/migrations/0011_telegram_announced.sql
```
Expected: `applied: 0011_telegram_announced.sql (1 stmts)` (или с пометкой «уже были», если
перезапуск после частичного сбоя — это нормально, раннер идемпотентен).

- [ ] **Step 3: Проверить, что колонка появилась**

Run (из `scripts/db/`):
```bash
node runner.js sql "select column_name, data_type from information_schema.columns where table_name='races' and column_name='telegram_announced_at'"
```
Expected: одна строка `{"column_name":"telegram_announced_at","data_type":"timestamp with time zone"}`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0011_telegram_announced.sql
git commit -m "feat(telegram): миграция — races.telegram_announced_at"
```

---

### Task 2: Каркас `scripts/telegram/`

**Files:**
- Create: `scripts/telegram/package.json`
- Create: `scripts/telegram/lib.js`
- Modify: `.env.example`

- [ ] **Step 1: Создать `scripts/telegram/package.json`**

```json
{
  "name": "f1-predict-telegram",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "raceweek": "node notify.js raceweek",
    "deadline": "node notify.js deadline",
    "results": "node notify.js results"
  }
}
```

- [ ] **Step 2: Установить зависимости**

Run: `cd scripts/telegram && npm install pg`
Expected: создаются `node_modules/`, `package-lock.json`; `package.json` дополняется
`dependencies.pg`. `fetch` для Telegram Bot API не требует пакета — встроен в Node ≥18.

- [ ] **Step 3: Написать `scripts/telegram/lib.js`**

```js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Читает переменную напрямую из корневого .env (без пакета dotenv — по образцу scripts/export/lib.js).
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

async function sendTelegram(text) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

module.exports = { readEnv, q, close, sendTelegram };
```

- [ ] **Step 4: Задокументировать новые переменные в `.env.example`**

Добавить в конец `.env.example`:

```

# --- Telegram-напоминания (scripts/telegram, обычно запускается GitHub Actions) ---
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_CHAT_ID=<id группового чата, отрицательное число>
```

- [ ] **Step 5: Синтаксическая проверка**

Run: `cd scripts/telegram && node --check lib.js`
Expected: без вывода, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/telegram/package.json scripts/telegram/package-lock.json scripts/telegram/lib.js .env.example
git commit -m "feat(telegram): каркас scripts/telegram — подключение к БД и Telegram Bot API"
```

---

### Task 3: `notify.js` — три режима

**Files:**
- Create: `scripts/telegram/notify.js`

- [ ] **Step 1: Проверить запрос «эта неделя» напрямую через раннер**

Run (из `scripts/db/`):
```bash
node runner.js sql "select id, round, name, deadline_utc from races where status='open' and date_trunc('week', deadline_utc at time zone 'Europe/Moscow') = date_trunc('week', now() at time zone 'Europe/Moscow') order by round"
```
Expected: JSON-массив (0 или 1+ строк — сейчас должна найтись открытая гонка недели, если такая есть).

- [ ] **Step 2: Проверить запрос «неотправленные результаты»**

Run (из `scripts/db/`):
```bash
node runner.js sql "select id, round, name from races where status='resulted' and scored=true and telegram_announced_at is null order by round"
```
Expected: JSON-массив (скорее всего пустой на данный момент — это нормально, значит нет ещё
объявленных результатов).

- [ ] **Step 3: Написать `scripts/telegram/notify.js`**

```js
const { q, close, sendTelegram } = require('./lib');

const SITE_URL = 'https://konicaru.github.io/f1-predict';

function toMskTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function thisWeekOpenRaces() {
  const { rows } = await q(`
    select id, round, name, deadline_utc
    from races
    where status = 'open'
      and date_trunc('week', deadline_utc at time zone 'Europe/Moscow')
        = date_trunc('week', now() at time zone 'Europe/Moscow')
    order by round
  `);
  return rows;
}

async function raceweek() {
  const races = await thisWeekOpenRaces();
  if (races.length === 0) {
    console.log('raceweek: нет открытой гонки на этой неделе, ничего не шлём');
    return;
  }
  for (const r of races) {
    const text =
      `🏁 RACE WEEK! На очереди <b>${r.name}</b> (раунд ${r.round}).\n` +
      `Дедлайн прогнозов — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `Ставь: ${SITE_URL}/predict`;
    await sendTelegram(text);
    console.log(`raceweek: отправлено для ${r.name}`);
  }
}

async function deadline() {
  const races = (await thisWeekOpenRaces()).filter((r) => new Date(r.deadline_utc) > new Date());
  if (races.length === 0) {
    console.log('deadline: нет открытой гонки с дедлайном впереди, ничего не шлём');
    return;
  }
  for (const r of races) {
    const text =
      `⏰ Не забудь поставить прогноз на <b>${r.name}</b>!\n` +
      `Дедлайн — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `${SITE_URL}/predict`;
    await sendTelegram(text);
    console.log(`deadline: отправлено для ${r.name}`);
  }
}

async function driverCodeMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((d) => [d.id, d.code]));
}

function codeFor(id, codeOf) {
  const code = codeOf.get(id);
  if (!code) console.warn('нет кода для пилота', id);
  return code || id;
}

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
      .map((s, i) => `${i + 1}. ${s.user} — ${s.points} (${s.exact_hits} точных)`)
      .join('\n');

    const text = `🏁 Финиш <b>${r.name}</b>!\n\nТоп-10:\n${top10}\n\nОчки за гонку:\n${scoresText}`;
    await sendTelegram(text);
    await q('update races set telegram_announced_at = now() where id = $1', [r.id]);
    console.log(`results: отправлено для ${r.name}`);
  }
}

async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results };
  if (!modes[mode]) {
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results`);
    process.exit(1);
  }
  await modes[mode]();
  await close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
```

- [ ] **Step 4: Синтаксическая проверка**

Run: `cd scripts/telegram && node --check notify.js`
Expected: без вывода, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram/notify.js
git commit -m "feat(telegram): notify.js — режимы raceweek/deadline/results"
```

---

### Task 4: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/telegram-notify.yml`

- [ ] **Step 1: Написать workflow**

```yaml
name: telegram-notify
# Напоминания и итоги гонок в общий Telegram-чат (plan §10, спека
# docs/superpowers/specs/2026-07-19-telegram-notify-design.md). Расписание в UTC, МСК = UTC+3
# (в России нет перехода на летнее время).
on:
  schedule:
    - cron: '0 7 * * 1'    # Пн 10:00 МСК — raceweek
    - cron: '0 7 * * 3'    # Ср 10:00 МСК — deadline
    - cron: '0 16 * * 3'   # Ср 19:00 МСК — deadline
    - cron: '0 7 * * 4'    # Чт 10:00 МСК — deadline
    - cron: '0 16 * * 4'   # Чт 19:00 МСК — deadline
    - cron: '0 */2 * * *'  # каждые 2 часа — results (проверка новых финальных результатов)
  workflow_dispatch:
    inputs:
      mode:
        description: 'Режим (для ручного запуска)'
        required: true
        type: choice
        options: [raceweek, deadline, results]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Определить режим
        id: mode
        run: |
          if [ -n "${{ inputs.mode }}" ]; then
            echo "mode=${{ inputs.mode }}" >> "$GITHUB_OUTPUT"
          else
            case "${{ github.event.schedule }}" in
              '0 7 * * 1') echo "mode=raceweek" >> "$GITHUB_OUTPUT" ;;
              '0 */2 * * *') echo "mode=results" >> "$GITHUB_OUTPUT" ;;
              *) echo "mode=deadline" >> "$GITHUB_OUTPUT" ;;
            esac
          fi
      - name: Записать .env для scripts/telegram
        run: |
          cat > .env <<EOF
          SUPABASE_DB_URL=${{ secrets.SUPABASE_DB_URL }}
          TELEGRAM_BOT_TOKEN=${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID=${{ secrets.TELEGRAM_CHAT_ID }}
          EOF
      - name: npm install
        run: cd scripts/telegram && npm install
      - name: Запустить notify.js
        run: node scripts/telegram/notify.js ${{ steps.mode.outputs.mode }}
```

- [ ] **Step 2: Проверить YAML на валидность синтаксиса**

Run: `node -e "require('js-yaml') && console.log('no js-yaml, skip')" 2>/dev/null; python3 -c "import yaml; yaml.safe_load(open('.github/workflows/telegram-notify.yml'))" 2>&1 || echo "если ни python3, ни js-yaml не установлены — визуально сверить отступы, это единственная проверка на этом шаге"

Expected: либо тихий успех парсинга YAML, либо (если инструментов нет) — визуальная сверка, что
отступы и структура совпадают с уже существующим `.github/workflows/keepalive.yml` (тот же стиль
`on:`/`jobs:`/`steps:`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/telegram-notify.yml
git commit -m "feat(telegram): workflow — расписание Actions (raceweek/deadline/results)"
```

---

### Task 5: README с инструкцией

**Files:**
- Create: `scripts/telegram/README.md`

- [ ] **Step 1: Написать `scripts/telegram/README.md`**

```markdown
# Telegram-напоминания и итоги

Автоматические сообщения в общий чат лиги: 🏁 RACE WEEK по понедельникам, напоминания о дедлайне
по средам и четвергам (дважды в день), итоги гонки как только результат занесён финально (без
повтора при последующей правке результата). Работает через GitHub Actions
(`.github/workflows/telegram-notify.yml`) по расписанию — деплоя не требует, достаточно завести
секреты и один раз проверить вручную.

## Разовая настройка

1. В Telegram написать [@BotFather](https://t.me/BotFather) → `/newbot` → придумать имя и
   username бота (username должен заканчиваться на `bot`, например `f1predict_league_bot`).
   BotFather пришлёт токен вида `123456:ABC-DEF...` — это `TELEGRAM_BOT_TOKEN`.
2. Добавить бота в общий групповой чат лиги как обычного участника.
3. В чате написать любое сообщение (например «привет»), чтобы у бота появилось событие для чтения.
4. Открыть в браузере (подставив свой токен вместо `<TOKEN>`):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   В JSON-ответе найти `"chat":{"id": -100XXXXXXXXXX, ...}` — это отрицательное число и есть
   `TELEGRAM_CHAT_ID` (у групповых чатов id всегда отрицательный).
5. В GitHub-репозитории: **Settings → Secrets and variables → Actions → New repository secret**,
   добавить три секрета:
   - `TELEGRAM_BOT_TOKEN` — токен из шага 1
   - `TELEGRAM_CHAT_ID` — id из шага 4
   - `SUPABASE_DB_URL` — та же строка подключения, что в локальном `.env` (Dashboard → Connect →
     Session pooler, порт заменить на 6543 — если её раньше не заводили как GitHub secret)

## Проверка

Во вкладке **Actions** репозитория найти workflow «telegram-notify» → **Run workflow** →
выбрать режим (`raceweek` / `deadline` / `results`) → запустить вручную. Проверить, что
сообщение пришло в чат (или что скрипт вывел «ничего не шлём», если сейчас нет подходящей гонки —
это нормальное поведение, не ошибка). После этого расписание сработает само.

## Локальный запуск (для отладки)

```bash
cd scripts/telegram
npm install
```

В корневой `.env` добавить `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (см. шаги 1–4 выше);
`SUPABASE_DB_URL` там уже должен быть из настройки других `scripts/*`. Затем:

```bash
node notify.js raceweek   # или deadline, или results
```
```

- [ ] **Step 2: Commit**

```bash
git add scripts/telegram/README.md
git commit -m "docs(telegram): инструкция по настройке бота и секретов"
```

---

### Task 6: Обновить конституцию — GitHub Actions вместо pg_cron для этой задачи

**Files:**
- Modify: `docs/constitution.md` (раздел «4. Архитектура и инфраструктура»)

- [ ] **Step 1: Найти в `docs/constitution.md` строку про таймер**

Текущий текст (раздел 4): `- **Тайминг на \`pg_cron\`**, не на GitHub Actions (точнее): напоминания, автозанос результатов.`

- [ ] **Step 2: Заменить на уточнённую формулировку**

Новый текст:
```markdown
- **Тайминг:** предпочтение — `pg_cron` (точнее GitHub Actions по времени срабатывания), но
  **pg_cron и Supabase Edge Functions ни разу не проверялись в этом проекте** (тот же сетевой блок,
  что не даёт запустить локальный Docker-стек, мог бы затронуть и `supabase functions deploy`).
  Keep-alive и Telegram-напоминания (2026-07-19) сознательно используют **GitHub Actions** —
  для обеих задач секундная/минутная точность не критична, а GitHub Actions уже дважды доказал
  надёжность в этом проекте (`deploy.yml`, `keepalive.yml`). Автозанос результатов (Фаза 4, если
  дойдём) — кандидат на pg_cron, когда/если понадобится точность.
```

- [ ] **Step 3: Commit**

```bash
git add docs/constitution.md
git commit -m "docs(constitution): расширить исключение pg_cron→GitHub Actions на Telegram-напоминания"
```

---

### Task 7 (ручной шаг пользователя): бот и секреты

Не выполняется сабагентом — создание бота через @BotFather и добавление GitHub-секретов
происходит вне доступа агента.

- [ ] Пройти шаги 1–5 из `scripts/telegram/README.md` (создать бота, добавить в чат, узнать
      `chat_id`, завести 3 секрета в GitHub).
- [ ] Сообщить, когда секреты заведены — дальше идёт Task 8 (смоук).

---

### Task 8: Смоук-тест всех трёх режимов + очистка + мерж

**Files:** нет новых файлов — только проверка и, при необходимости, точечные фиксы.

- [ ] **Step 1: Локально проверить `raceweek`/`deadline` на реальной открытой гонке**

Требует, чтобы в корневом `.env` уже были `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`SUPABASE_DB_URL` (Task 7 выполнен пользователем).

Run: `cd scripts/telegram && node notify.js raceweek` и отдельно `node notify.js deadline`.
Expected: если на этой неделе есть открытая гонка (дедлайн в текущей МСК-неделе) — сообщение
пришло в реальный чат, текст соответствует спеке (§6). Если открытой гонки на этой неделе нет —
консоль печатает «ничего не шлём», сообщений в чате быть не должно (тоже корректный результат).

- [ ] **Step 2: Смоук-тест `results` на гонке-подопытной (фикстура, НЕ трогая играющиеся гонки)**

Через `scripts/db/runner.js` (тот же приём фикстур, что в Фазах 2c/3) — выбрать дальнюю
гонку-подопытную (например round 21, если сейчас не используется активно), временно занести
результат:

```bash
cd scripts/db
node runner.js sql "select open_race(id) from races where round=21"
node runner.js sql "select set_race_result(id, '[\"norris\",\"leclerc\",\"piastri\",\"russell\",\"hamilton\",\"max_verstappen\",\"antonelli\",\"alonso\",\"hadjar\",\"bearman\"]'::jsonb) from races where round=21"
```

Run: `cd scripts/telegram && node notify.js results`
Expected: сообщение с топ-10 и (пустым, если на этой гонке ни у кого нет прогноза — это нормально)
списком очков пришло в реальный чат; в БД `races.telegram_announced_at` для этой гонки стало
заполнено.

Run ещё раз: `node notify.js results`
Expected: повторного сообщения НЕ появилось (гонка уже отфильтрована по `telegram_announced_at
is not null`), консоль печатает «новых финальных результатов нет».

- [ ] **Step 3: Полная очистка фикстуры**

```bash
cd scripts/db
node runner.js sql "select id from races where round=21"
```
Взять полученный `id` (назовём `<ID>`) и выполнить:
```bash
node runner.js sql "do \$\$ begin delete from results where race_id=<ID>; delete from race_driver_pool where race_id=<ID>; update races set status='demo', scored=false, telegram_announced_at=null where id=<ID>; end \$\$;"
```
Expected после проверки:
```bash
node runner.js sql "select status, scored, telegram_announced_at from races where round=21"
```
→ `{"status":"demo","scored":false,"telegram_announced_at":null}`.

- [ ] **Step 4: Проверить workflow вручную через `workflow_dispatch`**

Во вкладке Actions репозитория — запустить `telegram-notify` вручную с каждым из трёх режимов
по очереди (или хотя бы с одним, если предыдущие шаги уже подтвердили логику локально) —
убедиться, что GitHub-секреты подхватываются и job завершается зелёным.

- [ ] **Step 5: Финальное ревью ветки и мерж**

Использовать `superpowers:finishing-a-development-branch` — проверить весь дифф ветки
`telegram-notify` целиком на соответствие спеке (в т.ч. что Task 6 действительно обновила
конституцию), затем смёржить в `main`. Деплоя не требует (это не фронтенд) — но `git push origin
main` нужен, чтобы GitHub Actions на `main` подхватил новый workflow-файл и включил расписание
(schedule-триггеры GitHub Actions работают только для файлов, лежащих в дефолтной ветке).

---

## Self-Review

**Spec coverage:** §3 (GitHub Actions вместо pg_cron) → Task 6 (обновление конституции) явно это
фиксирует. §4 (файлы) → Task 1 (миграция), Task 2 (lib.js), Task 3 (notify.js), Task 4 (workflow),
Task 5 (README) — все файлы из спеки присутствуют. §5 (логика режимов) → Task 3, SQL-запросы
идентичны спеке (та же формула `date_trunc('week', ... at time zone 'Europe/Moscow')`). §6 (тексты
сообщений) → Task 3, тексты дословно из спеки (включая «RACE WEEK», уточнённое в ходе брейншторма).
§7 (секреты) → Task 4 (workflow читает 3 секрета) + Task 5/7 (README + ручной шаг заводят их).
§8 (тестирование) → Task 8 (смоук всех трёх режимов, включая фикстуру для `results` с полной
очисткой, `workflow_dispatch`-проверка). §9 (вне скоупа) — ничего лишнего не добавлено (нет тегов,
нет снимка зачёта в итогах, нет provisional-сообщений).

**Placeholder scan:** нет TBD/TODO; весь код полный и рабочий; команды — с ожидаемым выводом.
Task 1 Step 2 использует реальную команду раннера `applyfile` (сверено с исходником
`scripts/db/runner.js:88-89`, не угадано).

**Type consistency:** `q`/`close`/`sendTelegram`/`readEnv` — одинаковые имена в Task 2 (объявление
в `lib.js`) и Task 3 (`require('./lib')` в `notify.js`). Режимы (`raceweek`/`deadline`/`results`)
совпадают между `notify.js`'s `modes`-объектом, `package.json`'s npm-скриптами (Task 2) и
workflow's `mode`-inputs/case-веткой (Task 4).
