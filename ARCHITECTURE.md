# ARCHITECTURE

## Назначение
Лига прогнозов на топ-10 гонок Формулы-1: участник до дедлайна расставляет прогноз
(drag-and-drop), после гонки очки считаются автоматически, по сезону — общий зачёт.
Играет и ИИ-участник (GridBot). Полная спецификация — `docs/plan.md` (единый источник правды).

## Стек
- Фронтенд: React 18 + TypeScript + Vite + React Router, `@dnd-kit` (drag-and-drop),
  `country-flag-icons`. Хостинг GitHub Pages (github.com/konicaRu/f1-predict), деплой —
  GitHub Actions (`deploy.yml`).
- Бэкенд: Supabase (Postgres + Auth). Anon-ключ публичен по дизайну — вся защита на RLS
  (`supabase/migrations/0003_rls.sql` и далее).
- Данные F1: Jolpica API (основной), OpenF1 (фолбэк) — `scripts/import/`, `scripts/autoresults/`.
- ИИ-игрок: Gemini API (`gemini-2.5-flash`) — `scripts/ai-player/` (GridBot).
- Уведомления: Telegram Bot API — `scripts/telegram/`.
- Бэкап: Google Sheets API — `scripts/export/`.
- Автоматика: **GitHub Actions (cron)**, не `pg_cron` — идея обсуждалась на старте проекта, но
  не применена; расписания живут в `.github/workflows/telegram-notify.yml`.

## Структура (текущая)
```
f1_predict/
├── CLAUDE.md            — инструкции проекта для агента
├── README.md            — как пользоваться (badges/оглавление/схемы + разбор решений)
├── MEMORY.md            — журнал сессий
├── ARCHITECTURE.md      — этот файл
├── docs/
│   ├── plan.md            — полный план (v2): решения, БД, RLS, дизайн, roadmap — источник правды
│   ├── constitution.md    — незыблемые принципы проекта
│   ├── frontend.md        — детали фронтенд-реализации
│   ├── prototype.html     — статический референс-прототип дизайна
│   └── superpowers/       — spec/plan по каждой фиче (brainstorming → writing-plans → subagent-driven)
├── src/                  — React-приложение
│   ├── App.tsx, main.tsx
│   ├── auth/               — AuthContext, ProtectedRoute, AdminRoute
│   ├── pages/               — Login/Signup/RedeemInvite/ResetPassword, Calendar/Predict/Standings/
│   │                          Results/Rules, Admin/AdminResult
│   ├── components/           — Shell, DriverChip/DriverPool/PredictionSlots/RaceCard/Flag/DriftChart
│   ├── lib/                   — supabase.ts, db.ts, scoring.ts(+test), types.ts, countdown.ts,
│   │                            standings.ts, flags.ts
│   └── styles/
├── supabase/migrations/  — 0001–0015 (схема → очки → RLS → валидация → invite/membership →
│                           open_race → keepalive → admin-результаты → driver_standing →
│                           telegram_announced → predicted_user_ids → revoke_public_execute →
│                           GridBot-аккаунт → display_name unique)
├── scripts/              — самостоятельные cloud-direct пакеты (свой `package.json` в каждом)
│   ├── db/                  — миграции + тесты (RLS, формула очков, view, security grants, GridBot...)
│   ├── import/                — импорт пилотов/календаря/результатов из Jolpica (Фаза 1)
│   ├── autoresults/             — автозабор результата гонки (Jolpica → OpenF1 фолбэк)
│   ├── ai-player/                — GridBot: сбор данных, промпт Gemini, валидация/фолбэк, сохранение
│   ├── telegram/                   — напоминания/итоги в общий чат
│   ├── export/                       — бэкап в Google Sheets
│   └── dev/                            — разовые dev-бутстрап скрипты
└── .github/workflows/
    ├── deploy.yml           — сборка + публикация на GitHub Pages
    ├── keepalive.yml         — 2×/день, реальный RPC против Supabase (free-tier не засыпает)
    └── telegram-notify.yml    — cron: raceweek/deadline/remind/autoresults/results/aiplayer
```

## Roadmap (фазы)
0 Supabase ✅ · 1 Данные ✅ · 2 Ядро: 2a Каркас+Auth ✅ 2026-06-30 → 2b Календарь+Прогноз ✅
2026-07-07 → 2c Админка ✅ 2026-07-14 · 3 Витрина ✅ 2026-07-15 · 4 Автоматика ✅ (GitHub Actions
вместо `pg_cron`; автозабор + GridBot) · 5 Telegram-бот ✅ 2026-07-21 · 6 Полировка — идёт (drift
chart ✅, сброс пароля ✅, GridBot ✅, README ✅; мобильная раскладка проверена в смоуке 2b).
**MVP достигнут 2026-07-20** — Бельгия (round 10) стала первой реально зачётной гонкой.

## Команды
- БД (cloud-direct, `cd scripts/db && npm install`):
  - `npm run rebuild` — накат всех `supabase/migrations/*.sql` на облако (⚠️ сносит и пересоздаёт
    все таблицы — не тестовая песочница).
  - `npm test` — базовый набор (формула, view, RLS); отдельные `test:*` на каждую область
    (`test:gridbot`, `test:security_grants`, `test:predicted_user_ids`...) — см. `scripts/db/README.md`.
- Импорт данных (`cd scripts/import && npm install`): `npm run all` — пилоты+календарь+результаты
  из Jolpica (идемпотентно); `npm run verify`.
- Автозабор результата (`cd scripts/autoresults && npm install`): `node fetch.js`.
- GridBot (`cd scripts/ai-player && npm install`): `npm run predict`, `npm test`.
- Telegram (`cd scripts/telegram && npm install`): `node notify.js <raceweek|deadline|results|remind>`.
- Экспорт в Sheets (`cd scripts/export && npm install`): `npm run export`.
- Подключение к облаку: transaction-пулер `:6543` (см. `.env`), у каждой папки свой `.env`-ридер.
- Фронтенд (корневой `package.json`): `npm run dev`, `npm run build` (`tsc -b && vite build`).

## Бэкенд Supabase
- Облако `konicaRu_f1` (ref `kolrwuhjjsclqalapfzt`, EU-West, FREE). Локальный Docker-стек НЕ
  используется (не работает на этой машине) → миграции/тесты идут напрямую через пулер, см. `scripts/db/`.
- `supabase/migrations/` (0001–0015): схема → формула очков (`score_prediction` + view `scores`)
  → RLS/гранты/`is_admin()` → валидация состава прогноза → инвайт/членство → `open_race()` →
  keep-alive RPC → занос/правка результата админом (`set_race_result`) → `driver_standing` →
  флаг анонса в Telegram → RPC для списка проголосовавших → отзыв публичного `execute` →
  аккаунт GridBot → уникальность `display_name` (закрывает захват аккаунта GridBot).
- Секреты — в `.env` (gitignored): `SUPABASE_DB_URL` (transaction pooler с паролем БД).

## Фронтенд
- Vite + React 18 + TypeScript + React Router + `@supabase/supabase-js` + `@dnd-kit`.
- Маршруты: `/login /signup /redeem /reset-password` (публичные), `/calendar /predict/:raceId
  /standings /results /rules` (по членству), `/admin /admin/result/:raceId` (админ, `AdminRoute`).
- Вход по инвайт-коду (миграция 0006), доступ к данным по членству (`is_member()`).
- Прогноз — tap/drag-to-assign через `@dnd-kit` (`PredictionSlots` + `DriverPool`), read-only после
  дедлайна, серверная валидация состава. Результаты — таблица очков + `DriftChart` (прогноз vs факт).
- Мобильная раскладка проверена вручную (`max-width:640px`), сетевые запросы — авто-ретрай с backoff
  (`db.ts`) из-за нестабильной сети РФ↔Supabase.

## Автоматика (GitHub Actions)
- `deploy.yml` — push в `main` собирает Vite и публикует на GitHub Pages.
- `keepalive.yml` — 2×/день дёргает RPC `keepalive_ping()` (SECURITY DEFINER, реальный UPDATE в
  обход RLS). Обычный `select` под RLS не считался активностью для Supabase — инцидент 2026-07-14
  (проект уснул при зелёном keepalive), с тех пор именно RPC.
- `telegram-notify.yml` — один workflow, режимы по cron: `raceweek`/`remind` (пн), `deadline`
  (ср/чт), `autoresults`+`results` (каждые 2ч), `aiplayer` (чт до дедлайна). Полное расписание и
  разбор каждого режима — `README.md` § Telegram-уведомления.

## GridBot (ИИ-игрок)
Обычный аккаунт `public.users` (не отдельный UI), ставит прогноз через Gemini API по тем же
правилам, что и люди; при сбое — фолбэк на сортировку по чемпионату. Полный разбор архитектуры,
промпта и настройки — `README.md` § GridBot, дизайн/план — `docs/superpowers/specs/2026-07-24-ai-player-design.md`.

## Changelog
### 2026-07-26
- `ARCHITECTURE.md` актуализирован: структура/стек/roadmap/команды приведены под факт (были
  заморожены на 2a), забэкфиллены пропущенные фазы в changelog. Причина отставания — changelog
  сюда обновлялся нерегулярно, вся история фактически осела только в `MEMORY.md`.
- В `project-starter.md` (обе копии) добавлено обязательное правило: `git save` обновляет ОБА
  файла — `MEMORY.md` И changelog `ARCHITECTURE.md`, второе не опционально и не дублирование.
- README: после сравнения традиционного и «нарядного» вариантов выбран нарядный как единственный
  `README.md` (badges, ToC, ASCII-схемы, разбор RLS/GridBot/Telegram-уведомлений на уровне
  объяснений «для джуна»); черновик `README_new.md` удалён.
### 2026-07-24
- GridBot (ИИ-игрок): ветка `ai-player` влита в `main`, финальное ревью закрыло уязвимость
  захвата аккаунта через дублирующийся `display_name` (миграция `0015`).
- Бэкап в Google Sheets: Task 4 (ручная настройка Google Cloud) пройден, ветка `sheets-export`
  влита в `main`.
### 2026-07-21
- Telegram-напоминания + автозабор результатов: ветка `telegram-notify` влита в `main` (14 задач
  суммарно, обе фичи на одной ветке).
- Drift chart: визуализация прогноз vs факт на экране «Результаты», влито в `main`.
### 2026-07-15
- Фаза 3 (витрина): Зачёт + Результаты в проде.
- Сброс пароля: штатный флоу Supabase Auth, влито в `main` вне очереди фаз (беклог-пункт, взят
  как самый важный после MVP).
### 2026-07-14
- Фаза 2c (Админка): `open_race`-кнопка, занос/правка результата (`set_race_result`), пул по
  чемпионату, таймаут сети.
### 2026-07-07
- Фаза 2b: Календарь + Прогноз (tap-to-assign), `open_race()`, флаги/шрифт/сетевой ретрай.
### 2026-06-30 (2a)
- Фаза 2a: React-каркас + auth по инвайт-коду. Миграция 0006 (invite/membership), RLS чтения по членству.
  e2e-смоук пройден. Прототип → `docs/prototype.html`.
### 2026-06-30
- Фаза 1 (данные): `scripts/import/` тянет Jolpica → 22 гонки, 22 пилота, 8 демо-результатов. Миграция
  `0005_is_sprint`. `verify` 7/7. Переход на transaction-пулер :6543 (лимит session-пулера).
### 2026-06-29
- Фаза 0 backend: миграции 0001–0004 применены к облаку, тесты зелёные (RLS 7/7 = критерий готовности).
- Пивот на cloud-direct (Docker недоступен): инструменты в `scripts/db/`, keep-alive workflow.
### 2026-06-26
- Разворот по project-starter: git init, .gitignore, контекстные файлы.
- План перемещён в `docs/plan.md`.
