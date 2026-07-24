# Резервный бэкап в Google Sheets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloud-direct Node-скрипт `scripts/export/`, который по требованию зеркалит прогнозы, результаты
и очки лиги из Supabase в три вкладки Google-таблицы (человекочитаемо, полная перезапись при каждом запуске).

**Architecture:** Прямое подключение к Postgres через `pg` (тот же `SUPABASE_DB_URL`, что и у
`scripts/import`/`scripts/db`) для чтения; `googleapis` (Sheets API, сервис-аккаунт) для записи.
Один линейный скрипт `export.js` + общий `lib.js` (подключения). Без автосинка, без диффа — снэпшот
каждый раз.

**Tech Stack:** Node.js (CommonJS), `pg`, `googleapis`.

Сверено с `docs/constitution.md` (§4 секреты не в git, §6 YAGNI). Спека:
`docs/superpowers/specs/2026-07-15-sheets-backup-design.md`.

---

### Task 1: Каркас `scripts/export/` + секреты

**Files:**
- Create: `scripts/export/package.json`
- Create: `scripts/export/lib.js`
- Modify: `.gitignore`
- Modify: `.env.example`

- [ ] **Step 1: Создать `scripts/export/package.json`**

```json
{
  "name": "f1-predict-export",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "export": "node export.js"
  }
}
```

- [ ] **Step 2: Установить зависимости**

Run: `cd scripts/export && npm install pg googleapis`
Expected: создаются `node_modules/`, `package-lock.json`; `package.json` автоматически дополняется
полями `dependencies.pg` и `dependencies.googleapis` с реальными резолвнутыми версиями.

- [ ] **Step 3: Написать `scripts/export/lib.js`**

```js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { google } = require('googleapis');

// Читает переменную напрямую из корневого .env (без пакета dotenv — по образцу scripts/import/lib.js).
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

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
}

function sheetsClient() {
  const keyFile = resolveFromRoot(readEnv('GOOGLE_SERVICE_ACCOUNT_KEY_PATH'));
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

module.exports = { readEnv, q, close, sheetsClient };
```

- [ ] **Step 4: Добавить в `.gitignore` паттерн для JSON-ключа сервис-аккаунта**

Добавить строку в существующий блок «Секреты» в `.gitignore` (после `**/service_role*`):

```
scripts/export/service-account*.json
```

- [ ] **Step 5: Задокументировать новые переменные в `.env.example`**

Добавить в конец `.env.example`:

```

# --- Экспорт в Google Sheets (scripts/export, ручной запуск) ---
GOOGLE_SHEET_ID=<id таблицы из её URL: https://docs.google.com/spreadsheets/d/ЭТОТ_ID/edit>
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=scripts/export/service-account.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/export/package.json scripts/export/package-lock.json scripts/export/lib.js .gitignore .env.example
git commit -m "feat(export): каркас scripts/export — подключение к БД и Sheets API"
```

---

### Task 2: SQL-запросы и `export.js`

**Files:**
- Create: `scripts/export/export.js`

- [ ] **Step 1: Проверить запрос для «Прогнозы» напрямую через существующий раннер**

Run (из `scripts/db/`):
```bash
node runner.js sql "select r.round, r.name as race, u.display_name as \"user\", p.positions, p.created_at from predictions p join races r on r.id=p.race_id join users u on u.id=p.user_id order by r.round, u.display_name limit 3"
```
Expected: JSON-массив строк вида `{round, race, user, positions: [...10 driver id...], created_at}`, без ошибок.

- [ ] **Step 2: Проверить запрос для «Результаты»**

Run (из `scripts/db/`):
```bash
node runner.js sql "select r.round, r.name as race, res.positions, res.status, res.fetched_at from results res join races r on r.id=res.race_id where res.positions is not null order by r.round limit 3"
```
Expected: JSON-массив строк (может быть пустым, если сейчас нет ни одной зачётной гонки — это нормально).

- [ ] **Step 3: Проверить запрос для «Очки»**

Run (из `scripts/db/`):
```bash
node runner.js sql "select r.round, r.name as race, u.display_name as \"user\", s.points, s.exact_hits from scores s join races r on r.id=s.race_id join users u on u.id=s.user_id order by r.round, s.points desc limit 3"
```
Expected: JSON-массив строк (может быть пустым по той же причине).

- [ ] **Step 4: Написать `scripts/export/export.js`**

```js
const { q, close, sheetsClient, readEnv } = require('./lib');

const TABS = ['Прогнозы', 'Результаты', 'Очки'];

async function ensureTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
  const toAdd = TABS.filter((t) => !existing.has(t));
  if (toAdd.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })) },
  });
}

function toMsk(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

async function writeTab(sheets, spreadsheetId, tab, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

async function driverCodeMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((r) => [r.id, r.code]));
}

function posHeader() {
  return Array.from({ length: 10 }, (_, i) => `П${i + 1}`);
}

async function exportPredictions(sheets, spreadsheetId, codeOf) {
  const { rows } = await q(`
    select r.round, r.name as race, u.display_name as "user", p.positions, p.created_at
    from predictions p
    join races r on r.id = p.race_id
    join users u on u.id = p.user_id
    order by r.round, u.display_name
  `);
  const header = ['Раунд', 'Гонка', 'Участник', ...posHeader(), 'Дата отправки (МСК)'];
  const data = rows.map((r) => [
    r.round,
    r.race,
    r.user,
    ...r.positions.map((id) => codeOf.get(id) || id),
    toMsk(r.created_at),
  ]);
  await writeTab(sheets, spreadsheetId, 'Прогнозы', [header, ...data]);
  return data.length;
}

async function exportResults(sheets, spreadsheetId, codeOf) {
  const { rows } = await q(`
    select r.round, r.name as race, res.positions, res.status, res.fetched_at
    from results res
    join races r on r.id = res.race_id
    where res.positions is not null
    order by r.round
  `);
  const header = ['Раунд', 'Гонка', ...posHeader(), 'Статус', 'Дата заноса (МСК)'];
  const data = rows.map((r) => [
    r.round,
    r.race,
    ...r.positions.map((id) => codeOf.get(id) || id),
    r.status,
    toMsk(r.fetched_at),
  ]);
  await writeTab(sheets, spreadsheetId, 'Результаты', [header, ...data]);
  return data.length;
}

async function exportScores(sheets, spreadsheetId) {
  const { rows } = await q(`
    select r.round, r.name as race, u.display_name as "user", s.points, s.exact_hits
    from scores s
    join races r on r.id = s.race_id
    join users u on u.id = s.user_id
    order by r.round, s.points desc
  `);
  const header = ['Раунд', 'Гонка', 'Участник', 'Очки', 'Точных попаданий'];
  const data = rows.map((r) => [r.round, r.race, r.user, r.points, r.exact_hits]);
  await writeTab(sheets, spreadsheetId, 'Очки', [header, ...data]);
  return data.length;
}

async function main() {
  const spreadsheetId = readEnv('GOOGLE_SHEET_ID');
  const sheets = sheetsClient();
  await ensureTabs(sheets, spreadsheetId);
  const codeOf = await driverCodeMap();
  const nPred = await exportPredictions(sheets, spreadsheetId, codeOf);
  const nRes = await exportResults(sheets, spreadsheetId, codeOf);
  const nScores = await exportScores(sheets, spreadsheetId);
  console.log(`Прогнозы: ${nPred} строк | Результаты: ${nRes} строк | Очки: ${nScores} строк`);
  await close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
```

- [ ] **Step 5: Синтаксическая проверка (без реального запуска — credentials появятся в Task 4)**

Run: `cd scripts/export && node --check export.js`
Expected: без вывода, код завершения 0 (синтаксис валиден).

- [ ] **Step 6: Commit**

```bash
git add scripts/export/export.js
git commit -m "feat(export): скрипт экспорта — 3 вкладки, полная перезапись"
```

---

### Task 3: README с инструкцией по настройке

**Files:**
- Create: `scripts/export/README.md`

- [ ] **Step 1: Написать `scripts/export/README.md`**

```markdown
# Экспорт в Google Sheets

Ручной бэкап прогнозов/результатов/очков лиги в Google-таблицу. Каждый запуск полностью
перезаписывает три вкладки актуальным снэпшотом из Supabase. Без автосинка (это отдельная
задача на будущее) — запускается по требованию.

## Разовая настройка

1. Открыть [Google Cloud Console](https://console.cloud.google.com/) → создать новый проект
   (или выбрать существующий).
2. В проекте: **APIs & Services → Library** → найти «Google Sheets API» → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service Account**.
   Имя — любое (например `f1-predict-export`), роль на уровне проекта не нужна — доступ дадим
   точечно через шаринг конкретной таблицы (шаг 7).
4. Открыть созданный сервис-аккаунт → вкладка **Keys → Add Key → Create new key → JSON**.
   Скачается файл ключа.
5. Положить скачанный файл в `scripts/export/service-account.json` (путь уже в `.gitignore`,
   в git не попадёт).
6. Открыть скачанный JSON, скопировать поле `client_email`
   (вид: `имя@проект.iam.gserviceaccount.com`).
7. Создать пустую Google-таблицу ([sheets.new](https://sheets.new)) → **Настройки доступа** →
   расшарить на email из шага 6 с правом **Редактор**.
8. Скопировать ID таблицы из её URL: `https://docs.google.com/spreadsheets/d/`**`ЭТОТ_ID`**`/edit`.
9. В корневом `.env` (НЕ `.env.example`) добавить (см. шаблон в `.env.example`):
   ```
   GOOGLE_SHEET_ID=<id из шага 8>
   GOOGLE_SERVICE_ACCOUNT_KEY_PATH=scripts/export/service-account.json
   ```

## Запуск

```bash
cd scripts/export
npm install   # один раз
npm run export
```

Скрипт сам создаст вкладки «Прогнозы», «Результаты», «Очки» (если их ещё нет в таблице),
полностью перезапишет их текущими данными и напечатает счётчики строк, например:

```
Прогнозы: 4 строк | Результаты: 1 строк | Очки: 4 строк
```

Это и есть проверка успешного запуска — отдельного verify-скрипта нет (низкий риск: только
чтение из Supabase и запись наружу, схема БД не меняется).
```

- [ ] **Step 2: Commit**

```bash
git add scripts/export/README.md
git commit -m "docs(export): инструкция по настройке Google Sheets"
```

---

### Task 4 (ручной шаг пользователя): настройка Google Cloud + первый запуск

Эта задача не выполняется сабагентом — шаги в Google Cloud Console делает пользователь лично
(создание проекта/сервис-аккаунта/ключа — вне доступа агента), по инструкции из
`scripts/export/README.md`.

- [x] Пройти шаги 1–9 из README (создать сервис-аккаунт, скачать ключ, создать и расшарить таблицу,
      заполнить `.env`). Выполнено 2026-07-24 (проект `f1-predict-503408`, сервис-аккаунт
      `f1-predict-export@f1-predict-503408.iam.gserviceaccount.com`).
- [x] Запустить `cd scripts/export && npm install && npm run export`.
- [x] Проверить консольный вывод (три числа строк) и визуально открыть Google-таблицу — вкладки
      «Прогнозы»/«Результаты»/«Очки» созданы и заполнены, коды пилотов и имена участников читаемы
      (не uuid/id). Вывод: `Прогнозы: 4 строк | Результаты: 10 строк | Очки: 2 строк`, подтверждено
      пользователем визуально.
- [x] Сообщить результат — после подтверждения обновляем `MEMORY.md` (задача закрыта) и коммитим.

---

## Self-Review

**Spec coverage:** §4 (структура файлов) → Task 1+2+3. §5 (SQL) → Task 2 Steps 1-4. §6 (запись в
Sheets, автосоздание вкладок) → Task 2 Step 4 (`ensureTabs`, `writeTab`). §7 (тестирование — ручной
прогон, без автотестов) → Task 4. §8 (вне скоупа) — ничего лишнего не добавлено (нет автосинка, нет
записи обратно в Supabase, нет вкладки «Зачёт», таблицу не создаём программно).

**Placeholder scan:** нет TBD/TODO, весь код полный и рабочий, команды с ожидаемым выводом.

**Type consistency:** `readEnv`/`q`/`close`/`sheetsClient` — сигнатуры одинаковые в Task 1 (объявление)
и Task 2 (использование). Названия вкладок (`'Прогнозы'`, `'Результаты'`, `'Очки'`) совпадают между
`TABS`, `ensureTabs` и вызовами `writeTab` во всех трёх `export*`-функциях.
