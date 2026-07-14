# MEMORY — журнал

## Статус проекта
**ФАЗА 0 и ФАЗА 1 закрыты** (в `main`). В облаке `konicaRu_f1`: 22 гонки, 22 пилота с командами/цветами,
8 демо-результатов (`scored=false`), `races.is_sprint`.
**⚠️ ИНЦИДЕНТ 2026-07-14: проект уснул, хотя keepalive был ЗЕЛЁНЫЙ.** Настоящая причина: прежний
keepalive-запрос `SELECT drivers` под RLS с анон-ключом возвращал 0 строк (анон — не член лиги) и
Supabase НЕ считал это активностью. Фикс: миграция `0008_keepalive` — таблица `keepalive` + RPC
`keepalive_ping()` (SECURITY DEFINER → реальный UPDATE в обход RLS); workflow дёргает RPC ×2/день.
Проверено: анон `POST /rpc/keepalive_ping` → HTTP 200 + строка обновилась. Разбудили вручную из дэшборда
(данные целы: 22/22/22, 1 прогноз, Бельгия open). После пуша — прогнать keepalive руками (Actions), убедиться зелёный.
**Принята `docs/constitution.md`** — свод незыблемых принципов (по мотивам spec-kit); прокидывать её пункты
в промпты сабагентов-исполнителей и ревьюеров начиная с 2c.
**ФАЗА 2 (ядро) декомпозирована:** 2a Каркас+Auth → 2b Календарь+Прогноз → 2c Админка → backup-Sheets.
**2a ЗАКРЫТА (влита в `main`, ветка удалена):** React+Vite+TS фронтенд, вход по инвайт-коду (миграция
0006: `redeem_invite`+`is_member`, RLS чтения по членству), AuthContext/ProtectedRoute, экраны Login/Signup/
Redeem, Shell. e2e-смоук в браузере пройден (рег по коду `F1-2026-LEAGUE`→членство→вход; админ-вкладка).
Аккаунт `prokol35@gmail.com` (Dima_k) = админ. Скиллы: Superpowers + `karpathy-guidelines`.
**2b ЗАКРЫТА (влита в `main` merge-commit'ом, ветка `phase2b` удалена):** миграция `0007_open_race()` (снимок пула активных +
status='open', гейт: залогиненный=админ, прямое подключение=пропуск; pg-тест 6/6). Dev-бутстрап
`scripts/dev/bootstrap-open-belgium.js` → Бельгия (round 10, race id 11) открыта, пул 22. Фронт (подход A):
`src/lib/{types,db,countdown}.ts`, компоненты `DriverChip/PredictionSlots/DriverPool/RaceCard`, экраны
`Calendar` (группы open/soon/past, подсветка ближайшей, метка прогноза) и `Predict` (tap-to-assign: быстрый+
прицельный, save с серверной валидацией, read-only после дедлайна), маршруты `/predict` + `/predict/:raceId`,
стили + мобильная боковая раскладка (`max-width:640px`). Все 9 задач через subagent-driven (impl+spec+quality
ревью), `npm run build` зелёный на каждом шаге. **e2e-смоук в браузере ПРОЙДЕН** (Календарь, tap-to-assign,
сохранение прогноза, мобильная раскладка на iPhone SE). Доп. правки по ходу смоука (влиты в ту же ветку):
шрифт Titillium Web вместо Saira Condensed (читаемее), SVG-флаги стран в календаре (`country-flag-icons`,
т.к. Windows не рисует emoji-флаги), авто-ретрай сети в `db.ts` (3× backoff на транзиентных fetch-сбоях) +
кнопка «Повторить» (сеть до Supabase из РФ флапает). **Осталось: финальное ревью ветки → merge в `main`.**
Supabase Auth: «Confirm email» OFF, email-сигнапы ON.

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
- **ТРЕБОВАНИЕ (принято 2026-07-07): сброс пароля.** Сейчас НЕТ восстановления пароля (в 2a не входило) —
  забывший пароль войти не сможет (только ручной сброс через дэшборд). Сделать позже: ссылка «Забыли пароль?»
  на логине → экран запроса (`resetPasswordForEmail(email, {redirectTo: …/reset})`) → новый маршрут `/reset`
  (recovery-сессия → `updateUser({password})`). Требует в Supabase: Redirect URLs += `…/f1-predict/reset`,
  Site URL = Pages-URL. Нюанс: free-SMTP лимитирован/спам (позже свой SMTP при необходимости). Мини-подпроект.
- **ТРЕБОВАНИЕ для 2b (принято 2026-06-30): мобильный экран «Прогноз» — боковая раскладка** (пул гонщиков
  слева, слоты-места справа, не в столбик) для одноэкранного tap-to-assign; карточки пула на мобиле
  компактные (код + полоса команды). Детали — `docs/plan.md` §16.11. Учесть при дизайне 2b.
- **ТРЕБОВАНИЕ (принято 2026-06-30): итоги гонки в Telegram-чат.** После финала гонки (статус `final` + очки)
  бот шлёт в общий чат сообщение: топ-10 + зачёт за гонку + очки. Часть Фазы 5 (pg_cron + Edge Function),
  детали в `docs/plan.md` §10. Триггер на финале, не на provisional.
- **ТРЕБОВАНИЕ (принято 2026-06-30): резервный бэкап в Google Sheets.** Источник истины — Supabase;
  таблица — зеркальная копия прогнозов + результатов гонок + очков (надёжность, free Supabase без автобэкапа).
  Отдельный под-проект ПОСЛЕ 2c (нужно, чтобы сначала появились прогнозы/очки). Старт — ручной экспорт-скрипт
  (`scripts/export/`, cloud-direct Node → Sheets API, сервис-аккаунт Google + расшаренная таблица = секрет-JSON);
  автосинк при заносе результата — позже (Фаза 4, Edge Function).
- Фаза 2 нарезана: 2a Каркас+Auth → 2b Календарь+Прогноз → 2c Админка → backup-Sheets. Каждый под-проект
  проходит brainstorming → spec → plan → impl. Auth обязателен в 2a (RLS требует `auth.uid()`).
- Миграции применяются раннером напрямую, БЕЗ supabase migration-трекинга — если позже понадобится
  `supabase db push`, в облаке нет записей `supabase_migrations.schema_migrations`.
- Реальный грид 2026 берём из Jolpica (источник истины), хардкод §16.10 в плане — спекулятивный, игнор.
- (опц.) Пользователь может вернуть галку containerd в Docker Desktop — выключали зря, на причину не влияло.

## Лог сессий

### 2026-07-14 (Фаза 2c — Админка, В ПРОЦЕССЕ, ветка `phase2c` не влита)
- Brainstorm → спека (`docs/superpowers/specs/2026-07-14-phase2c-admin-design.md`) → план
  (`.../plans/2026-07-14-phase2c-admin.md`, 6 задач). Сверено с конституцией. Подход A: серверный RPC.
- Исполнение subagent-driven **с блоком конституции в промптах** (первый раз по новой практике).
- **Task 1–5 готовы и отревьюены** (spec+quality+конституция): миграция `0009_admin_results` — RPC
  `set_race_result()` (гейт админа, валидация 10-из-пула, журнал `result_changes`, upsert, `resulted+scored`);
  pg-тест **11/11 PASS** вкл. сквозной скоринг 131. Фронт: `db.ts` (openRace/getResult/setRaceResult),
  `AdminRoute` (гейт), экран `Admin` (список + действия по `races.status`), `AdminResult` (tap-to-assign
  занос/правка + причина), стили. `npm run build` зелёный.
- **Фикс по ходу смоука:** таймаут 10с в `withRetry` (`db.ts`) — supabase-js без таймаута, зависший fetch
  висел вечно («Загрузка…» на Админке); теперь через 10с → transient → ретрай → иначе «Повторить». Чинит все экраны.
- **Осталось: Task 6 e2e-смоук** (под админом; отложен — у юзера скакала латентность RU→EU до Supabase).
  Смоук делать на дальней гонке R22 (Abu Dhabi), НЕ на Бельгии (она открыта для друзей), потом откатить R22
  в demo через SQL. Затем финальное ревью ветки + merge в `main`.
- Коммиты `phase2c`: 97d1c86, 9141824, 9169fba, a0f87a7, 310de2d, be36873 (+спека/план).

### 2026-07-07…14 (деплой, конституция, keepalive-инцидент, spec-kit)
- **Деплой на GitHub Pages** настроен с нуля (`.github/workflows/deploy.yml`, Actions: push main →
  build → Pages, VITE из секретов, SPA-фолбэк) и выполнен. Сайт живой: https://konicaru.github.io/f1-predict/
  (проверено curl: наш бандл, верные Supabase URL+ключ, deep-link через 404.html).
- **Конституция проекта** `docs/constitution.md` — свод незыблемых принципов (по мотивам github/spec-kit;
  сам CLI не ставим). Указатель в `CLAUDE.md`. С 2c прокидывать её пункты сабагентам-исполнителям/ревьюерам.
- **Изучен spec-kit** → в `project-starter` добавлен модуль «конституция + coverage-check» (пункт 9 чек-листа
  + раздел 12), синхронизированы обе копии (хаб + `~/.claude`).
- **⚠️ keepalive-инцидент 2026-07-14:** проект уснул, ХОТЯ keepalive был зелёный. Причина: `SELECT drivers`
  под RLS с анон-ключом → 0 строк → Supabase не считал активностью. Фикс: миграция `0008_keepalive`
  (таблица + RPC `keepalive_ping()` = реальный UPDATE через SECURITY DEFINER), workflow дёргает RPC ×2/день.
  Проверено (анон POST → 200 + запись). Проект разбужен вручную, данные целы (22/22/22, 1 прогноз, Бельгия open).
- Бэклог пополнен: **сброс пароля** (мини-подпроект).

### 2026-07-05 (Фаза 2b — Календарь + Прогноз)
- Brainstorming → спека (`docs/superpowers/specs/2026-07-05-phase2b-calendar-prediction-design.md`) → план
  (`.../plans/2026-07-05-phase2b-calendar-prediction.md`, 9 задач). Решения: календарь=точка входа,
  tap-to-assign, `open_race()`+dev-бутстрап, upcoming некликабельны, locked=read-only.
- Исполнение через **subagent-driven-development**: свежий сабагент на задачу + spec-ревью + code-quality-ревью.
  Фиксы по ревью: `.catch()` на IIFE бутстрапа (`2e5698c`), try/catch в редирект-эффекте Прогноза (`b6e9831`).
- Миграция `0007_open_race` применена к облаку, pg-тест 6/6 PASS. Бельгия (round 10) открыта бутстрапом.
- e2e-смоук в браузере ПРОЙДЕН (десктоп + iPhone SE 375px). По ходу смоука доработано и влито в ветку:
  Titillium Web (шрифт), SVG-флаги стран (`country-flag-icons`, emoji-флаги не рисуются на Windows),
  авто-ретрай сети в `db.ts` + кнопка «Повторить» (флап сети до Supabase из РФ).
- Финальное ревью ветки → «Ready to merge». Влито в `main` (merge-commit, --no-ff), ветка `phase2b` удалена.
  Синхронизирован шрифт в `plan.md` §16 и `CLAUDE.md`. **2b ЗАКРЫТА.**
- **ДЕПЛОЙ НАСТРОЕН И ВЫПОЛНЕН:** `.github/workflows/deploy.yml` (Actions: push main → npm ci → build →
  Pages; VITE_* из секретов `SUPABASE_URL`/`SUPABASE_ANON_KEY`; SPA-фолбэк `index.html`→`404.html`).
  Pages Source в GitHub переключён на «GitHub Actions» (вручную юзером). Запушено в origin, сайт ЖИВОЙ:
  **https://konicaru.github.io/f1-predict/** (проверено curl: HTTP 200, наш бандл, верные Supabase URL+anon-ключ
  в бандле, SPA-фолбэк работает). Друзья могут регистрироваться (код `F1-2026-LEAGUE`) и ставить прогноз на Бельгию.
  Дальше: 2c Админка (ручной ввод результатов + UI-кнопка open_race).

### 2026-06-30 (Фаза 2a — каркас + auth)
- Brainstorming → спека+план 2a. Решения S1–S7 (инвайт-код серверный, email-подтверждение off, TS, порт CSS).
- Миграция 0006 (invite_codes/redeem_invite/is_member, RLS чтения по членству); pg-тест членства PASS.
  `rls.test` изолирован высокими id/round (после импорта Фазы 1 был конфликт ключей).
- React-каркас Vite+TS: supabase-клиент, AuthContext, ProtectedRoute, Login/Signup/RedeemInvite, Shell, тема из прототипа.
  Прототип → `docs/prototype.html`. `.env.local` (gitignored) с VITE-переменными.
- e2e-смоук в браузере (dev `npm run dev -- --host`, порт 5173): рег по коду → членство → вход; бутстрап админа.
- Нюансы окружения: Vite default слушает IPv6 → `--host`; Supabase «Email signups» надо было включить, «Confirm email» выключить.
- Ветка `phase2a` (не влита).

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
