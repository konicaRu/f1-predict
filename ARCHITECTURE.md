# ARCHITECTURE

## Назначение
Лига прогнозов на топ-10 гонок Формулы-1: участник до дедлайна расставляет прогноз
(drag-and-drop), после гонки очки считаются автоматически, по сезону — общий зачёт.
Полная спецификация — `docs/plan.md` (единый источник правды).

## Стек
- Фронтенд: React + @dnd-kit, хостинг GitHub Pages (github.com/konicaRu/f1-predict)
- Бэкенд: Supabase (Postgres + Auth + Edge Functions + pg_cron)
- Данные F1: Jolpica API (основной), OpenF1 (фолбэк)
- Напоминания: Telegram Bot API; Keep-alive: GitHub Actions

## Структура (текущая)
```
f1_predict/
├── CLAUDE.md       — инструкции проекта для агента
├── docs/plan.md    — полный план (v2): решения, формула очков, БД, RLS, дизайн, roadmap
├── index.html      — рабочий статический прототип (без React)
├── MEMORY.md       — журнал сессий
├── ARCHITECTURE.md — этот файл
└── README.md       — как пользоваться
```
Целевая структура (`src/`, `supabase/`, `.github/workflows/`, `package.json`) — см. CLAUDE.md / plan.md, создаётся по фазам.

## Roadmap (фазы)
0 Supabase (схема, RLS, Auth, keep-alive) · 1 Данные (импорт пилотов/календаря, демо-гонки)
· 2 Ядро (календарь, прогноз, админка, scores) · 3 Витрина (результаты, drift chart, зачёт)
· 4 Автоматика (pg_cron, Edge Functions) · 5 Telegram-бот · 6 Полировка.
MVP = Фазы 0–3.

## Команды
- БД (cloud-direct, нужен `cd scripts/db && npm install`):
  - `npm run rebuild` — накат всех `supabase/migrations/*.sql` на облако.
  - `npm test` — тесты Фазы 0 (формула, view, RLS). Подробности — `scripts/db/README.md`.
- Импорт данных (`cd scripts/import && npm install`):
  - `npm run all` — пилоты+календарь+результаты из Jolpica (идемпотентно). `npm run verify` — критерий Фазы 1.
- Подключение к облаку: transaction-пулер `:6543` (см. `.env` / `scripts/import/README.md`).
- (фронтенд-команды появятся с корневым `package.json` на этапе React-каркаса, Фаза 2)

## Бэкенд Supabase (Фаза 0)
- Облако `konicaRu_f1` (ref `kolrwuhjjsclqalapfzt`, EU-West, FREE). Локальный Docker-стек НЕ используется
  (не работает на этой машине) → миграции/тесты идут напрямую через session pooler, см. `scripts/db/`.
- `supabase/migrations/`: `0001_schema` (7 таблиц) · `0002_scoring` (функция score_prediction + view scores)
  · `0003_rls` (RLS-политики, гранты, is_admin) · `0004_validation` (триггер состава прогноза).
- Секреты — в `.env` (gitignored): `SUPABASE_DB_URL` (session pooler с паролем БД).

## Фронтенд (Фаза 2a)
- Vite + React 18 + TypeScript + react-router + `@supabase/supabase-js`. Корневой `package.json`.
- `src/`: `lib/supabase.ts`, `auth/` (AuthContext, ProtectedRoute), `pages/` (Login/Signup/RedeemInvite),
  `components/Shell.tsx`, `styles/app.css`. Прототип-референс — `docs/prototype.html`. Подробности — `docs/frontend.md`.
- Вход по инвайт-коду (миграция 0006), доступ к данным по членству (`is_member()`). Команды: `npm run dev`, `npm run build`.

## Changelog
### 2026-07-24
- GridBot (ИИ-игрок): ветка `ai-player` влита в `main`, финальное ревью закрыло уязвимость
  захвата аккаунта через дублирующийся `display_name` (миграция `0015`).
- README: два файла на выбор — `README.md` (традиционный) и `README_new.md` (нарядный, с
  разбором RLS/GridBot/Telegram-уведомлений на уровне объяснений «для джуна»).
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
