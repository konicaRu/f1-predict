# Резервный бэкап в Google Sheets (дизайн)

Дата: 2026-07-15
Статус: согласован, готов к плану
Сверено с `docs/constitution.md` (§4 инфраструктура/секреты, §6 YAGNI).

## 1. Цель

Дать человекочитаемую резервную копию игровых данных (прогнозы, результаты, очки) поверх Supabase —
free-тариф Supabase не делает автобэкапы, а таблица в Google Sheets — простой, надёжный и понятный
без специальных инструментов снимок состояния лиги. Ручной экспорт по требованию; автосинк при
заносе результата — отдельная задача Фазы 4 (Edge Function), вне скоупа этой задачи.

## 2. Контекст (что уже готово)

- Проект уже использует cloud-direct Node-скрипты с прямым подключением к Postgres через `pg`
  (`scripts/db/`, `scripts/import/`), т.к. локальный Docker-стек Supabase недоступен на этой машине.
  Подключение — transaction-пулер `aws-0-eu-west-1.pooler.supabase.com:6543`, строка в `.env` (корень,
  gitignored) как `SUPABASE_DB_URL`.
- Таблицы: `predictions(user_id, race_id, positions jsonb, created_at)`, `results(race_id, positions
  jsonb, status, fetched_at)`, `scores` (view: `user_id, race_id, points, exact_hits`), `users(id,
  display_name)`, `drivers(id, code, name)`, `races(id, round, name)`.
- `.gitignore` уже исключает `.env`, `.env.*`, `*.key`, `**/service_role*` — паттерн для JSON-ключа
  сервис-аккаунта нужно добавить отдельно (не подпадает под текущие маски).

## 3. Решения (из брейншторма)

- **Подход — свой cloud-direct Node-скрипт** (`pg` для чтения + `googleapis` для записи), без
  автосинка/no-code коннекторов — соответствует уже принятому стеку и YAGNI.
- **Состав бэкапа:** три вкладки — Прогнозы, Результаты, Очки. Без агрегированного «Зачёта» (дублировал
  бы `standings.ts`, доступен на сайте).
- **Владение таблицей:** пользователь создаёт пустой Google Sheet вручную и шарит доступ сервис-аккаунту
  (email из JSON-ключа) с правом редактирования. Скрипт НЕ создаёт саму таблицу (это требует Drive API
  и лишнего скоупа прав) — только создаёт недостающие вкладки внутри неё через Sheets API.
- **Режим записи:** полная перезапись каждой вкладки при каждом запуске (`values.clear` + `values.update`)
  — простой снэпшот текущего состояния БД, без diff/upsert по ключу, без риска дублей при повторном запуске.
- **Читаемость:** id/uuid всюду заменяются на человекочитаемые поля через SQL join (код пилота вместо
  `driver_id`, имя участника вместо `user_id`, название+раунд гонки вместо `race_id`); даты — в МСК.

## 4. Архитектура и файлы

```
scripts/export/
  package.json       — зависимости: pg, googleapis
  lib.js             — pg-подключение (по образцу scripts/import/lib.js) + Sheets-клиент (JWT сервис-аккаунта)
  export.js          — точка входа: 3 SQL-запроса → 3 записи в Sheets, печать итоговых счётчиков строк
  README.md          — пошаговая инструкция: создание проекта в Google Cloud Console, включение Sheets API,
                       создание сервис-аккаунта и JSON-ключа, создание пустой таблицы и шаринг доступа,
                       нужные переменные в `.env`
.env (корень)        += GOOGLE_SHEET_ID (id таблицы из её URL)
                     += GOOGLE_SERVICE_ACCOUNT_KEY_PATH (путь к JSON-ключу, по умолчанию
                        scripts/export/service-account.json)
.gitignore           += `scripts/export/service-account*.json`
```

**Границы:** `lib.js` — только подключение (БД + Sheets-клиент), без бизнес-логики. `export.js` — вся
логика запроса+трансформации+записи, читается сверху вниз как один линейный скрипт (по объёму — не
больше существующего `scripts/import/import.js`, отдельных модулей на каждую вкладку не заводим).

## 5. SQL-запросы (человекочитаемые джойны)

- **Прогнозы:**
  ```sql
  select r.round, r.name as race, u.display_name as user, p.positions, p.created_at
  from predictions p
  join races r on r.id = p.race_id
  join users u on u.id = p.user_id
  order by r.round, u.display_name;
  ```
  `positions` (jsonb-массив id пилотов) в JS раскладывается в 10 колонок П1..П10 через join с картой
  `drivers.id → code` (карта грузится одним запросом `select id, code from drivers` и кешируется в памяти
  скрипта на время запуска).
- **Результаты:** аналогично, из `results` (только строки с непустым `positions`), + `status`, `fetched_at`.
- **Очки:** `select r.round, r.name, u.display_name, s.points, s.exact_hits from scores s join races r
  on r.id=s.race_id join users u on u.id=s.user_id order by r.round, s.points desc`.

## 6. Запись в Sheets

- Аутентификация: `google.auth.JWT` со scope `https://www.googleapis.com/auth/spreadsheets`, ключ из
  файла `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`.
- На старте: `spreadsheets.get` — список существующих вкладок; для каждой из трёх недостающих —
  `spreadsheets.batchUpdate` с `addSheet`.
- Для каждой вкладки: `spreadsheets.values.clear` (весь диапазон) → `spreadsheets.values.update` с
  заголовком + строками данных (одним batch-запросом на вкладку).
- В конце — консольный отчёт: `Прогнозы: N строк | Результаты: N строк | Очки: N строк`. Это и есть
  проверка успешности запуска (без отдельного verify-скрипта — задача проще, чем импорт из Фазы 1).

## 7. Тестирование

- Ручной прогон на реальных данных: `npm run export` из `scripts/export/`, затем визуальная сверка
  открытой Google-таблицы — счётчики строк в консоли совпадают с количеством строк на вкладках,
  выборочно сверить 1-2 записи (код пилота, имя участника, очки) с тем, что видно на сайте
  (`/results`, `/standings`).
- Автотестов нет — по объёму и риску сопоставимо с обычным report-скриптом, не с миграцией схемы
  (сверка с практикой других `scripts/*` в проекте: `verify.js` был нужен для импорта, где важна
  идемпотентность в БД; здесь только чтение+запись наружу, ничего не меняется в Supabase).

## 8. Вне скоупа

- Автосинк по расписанию/pg_cron/Edge Function при заносе результата — Фаза 4.
- Запись из Sheets обратно в Supabase (мирроринг строго в одну сторону).
- История версий/append-лог в самой таблице — каждый запуск полностью перезаписывает снэпшот.
- Автосоздание самой Google-таблицы (Drive API) — таблицу создаёт пользователь вручную.
- Вкладка агрегированного «Зачёта» — дублировала бы `standings.ts`.
