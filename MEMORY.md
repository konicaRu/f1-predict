# MEMORY — журнал

## Статус проекта
**ФАЗА 0 закрыта** (в `main`). **ФАЗА 1 (данные) реализована на ветке `phase1-data`** — ждёт влития в `main`.
В облаке `konicaRu_f1`: 22 гонки, 22 пилота с командами/цветами, 8 демо-результатов (`scored=false`),
колонка `races.is_sprint`. `scripts/import/verify.js` — 7/7 PASS, идемпотентно. keepalive зелёный.
Следующее после merge — **Фаза 2** (ядро: календарь, экран прогноза, админка). Скиллы: Superpowers + `karpathy-guidelines`.

**ВАЖНО — пивот на cloud-direct:** локальный Docker-стек Supabase на этой машине НЕ работает
(Docker не может тянуть образы из реестра — сетевой блок, даже hello-world виснет; containerd/прокси/
системный прокси проверены и ни при чём — проблема в сети Docker-VM). Поэтому отказались от
`supabase start`/pgTAP и пошли **напрямую против облака** через session pooler:
- Подключение: `.env` → `SUPABASE_DB_URL` = **transaction-пулер** `aws-0-eu-west-1.pooler.supabase.com:6543`,
  user `postgres.kolrwuhjjsclqalapfzt` (раньше был session-пулер :5432, но он упирался в лимит 15 клиентов
  при множестве коротких CLI-запусков → перешли на transaction :6543). Direct-хост `db.<ref>.supabase.co`
  НЕ резолвится на free-тарифе. Пароль в `.env` (URL-экранирован), `.env` в git НЕ идёт.
- Инструменты в репо: `scripts/db/` (runner + тесты Фазы 0), `scripts/import/` (импорт Jolpica, Фаза 1).
  В каждой папке нужен свой `npm install`; читают `.env` из корня.
- Сеть до пулера флапает → раннер применяет миграции постейтментно с ретраем и проглатыванием
  дублей; тесты — одним запросом (DO-блок/CTE) в транзакции с откатом, облако чистое.

**Цель:** закрытая лига прогнозов F1 для компании друзей.
**Критерий MVP:** первая зачётная гонка играбельна = Фазы 0–3.

## Открытые вопросы / на будущее
- **Влить `phase1-data` → `main`** (finishing-a-development-branch).
- **Старт Фазы 2** (ядро): экран календаря, экран прогноза (drag-and-drop / tap-to-assign, снимок пула,
  серверная проверка дедлайна), админка (ручной ввод топ-10). Перед началом — `brainstorming`.
  Тут начинается React-фронтенд (Vite) — появится корневой `package.json`.
- Миграции применяются раннером напрямую, БЕЗ supabase migration-трекинга — если позже понадобится
  `supabase db push`, в облаке нет записей `supabase_migrations.schema_migrations`.
- Реальный грид 2026 берём из Jolpica (источник истины), хардкод §16.10 в плане — спекулятивный, игнор.
- (опц.) Пользователь может вернуть галку containerd в Docker Desktop — выключали зря, на причину не влияло.

## Лог сессий

### 2026-06-30 (Фаза 1 — данные)
- Brainstorming → спека (`docs/superpowers/specs/2026-06-30-phase1-data-design.md`) → план
  (`.../plans/2026-06-30-phase1-data.md`). Решения P1–P8.
- Реализован `scripts/import/` (cloud-direct, fetch Jolpica → UPSERT): пилоты, календарь 22 гонки,
  результаты 8 прошедших раундов. Миграция `0005_is_sprint`. `deadlineUtc` по TDD.
- `verify.js` 7/7 PASS, повторный прогон идемпотентен.
- Фиксы по ходу: пропуск безкодовых резервистов (схема требует code NOT NULL); переход на
  **transaction-пулер :6543** (session :5432 упёрся в лимит 15 клиентов).
- Ветка `phase1-data` (ещё не влита).

### 2026-06-30 (Фаза 0 — финал)
- Перепроверен committed-харнесс (`scripts/db`): score 7/7, view 131/10, RLS 7/7. Фикс view-теста
  (заполнял `race_driver_pool` — триггер валидации требует пул).
- Спека и план дополнены поправкой про cloud-direct.
- Ветка `phase0-supabase` влита в `main` (finishing-a-development-branch), удалена локально и на origin.
- keepalive: заведены GitHub secrets `SUPABASE_URL`+`SUPABASE_ANON_KEY`, ручной запуск зелёный.
  (Первый запуск был красный — забыли `SUPABASE_URL`; добавили, перезапустили.)
- **Фаза 0 закрыта.**

### 2026-06-29 (Фаза 0 — backend, cloud-direct)
- Brainstorming → спека (`docs/superpowers/specs/2026-06-29-phase0-supabase-design.md`) → план
  (`docs/superpowers/plans/2026-06-29-phase0-supabase.md`). Решения W1–W4/D1–D5.
- Карпатого поставлен ручным клонированием (в project-starter добавлен раздел про установку без `/plugin`).
- Долгая борьба с Docker: образы не качаются (сетевой блок Docker-VM) → **пивот на cloud-direct**.
- Написаны и применены к облаку миграции `supabase/migrations/0001_schema..0004_validation.sql`.
  Тесты (через `scripts/db`): score 7/7, view 131/10, RLS 7/7. Фикс: `revoke update on users` (Supabase
  по дефолту грантит ALL роли authenticated → перекрывал column-grant на is_admin).
- Заведён `.github/workflows/keepalive.yml` (нужны GitHub secrets, см. открытые вопросы).
- Коммиты на ветке `phase0-supabase`: 5e9ea76, f08cbe6, b1ece00, b17cb60, 7e8b6ba, 57c97bd + этот save.

### 2026-06-26 (разворот по project-starter)
- Прошли стартовый чек-лист. Решения: контекстные файлы — да; git — да; скиллы Карпатого — да (ставит пользователь); Superpowers — да (уже установлен); накопительные правила — нет; humanizer — нет.
- Язык: общение/доки русские, код английский.
- `git init`, заведён `.gitignore` (секреты Supabase service_role / Telegram-токен исключены).
- План перемещён `f1-prediction-league-plan.md` → `docs/plan.md` (так ссылается CLAUDE.md).
- Заведены `MEMORY.md`, `ARCHITECTURE.md`, `README.md`.
