# ARCHITECTURE

## Назначение
Лига прогнозов на топ-10 гонок Формулы-1: участник до дедлайна расставляет прогноз
(drag-and-drop), после гонки очки считаются автоматически, по сезону — общий зачёт.
Играет и ИИ-участник (GridBot). Полная спецификация — `docs/plan.md` (единый источник правды).

**Снимок этой карты в двух форматах:** `architecture-map.html` (визуально, для человека) и
`architecture-map.json` (машиночитаемо, вкладывать в промпт свежему сабагенту перед новой
фичей). **НЕ обновлять автоматически на каждом `git save`** — только когда меняется
структура/схема/автоматика (тот же повод, что требует правки этого файла), и только
**спросив пользователя**, нужно ли обновление (экономия токенов на пустых пересборках).

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
│   ├── telegram-guide.txt — гайд для участников (регистрация/прогноз/навигация/очки),
│   │                        копируется как есть в Telegram-чат
│   └── superpowers/       — spec/plan по каждой фиче (brainstorming → writing-plans → subagent-driven)
├── src/                  — React-приложение
│   ├── App.tsx, main.tsx
│   ├── auth/               — AuthContext (+ Telegram Mini App bootstrap), ProtectedRoute, AdminRoute,
│   │                          RootRedirect (сессия -> кабинет или гостевой /g/*)
│   ├── pages/               — Login/Signup/RedeemInvite/ResetPassword, Calendar/Predict/Standings/
│   │                          Results/Rules, Admin/AdminResult/AdminPool (состав пилотов гонки),
│   │                          GuestCalendar (гостевой, read-only)
│   ├── components/           — Shell, GuestShell (гостевой layout), PasswordInput, DriverChip/
│   │                            DriverPool/PredictionSlots/RaceCard/Flag/DriftChart
│   ├── lib/                   — supabase.ts, db.ts, scoring.ts(+test), types.ts, countdown.ts,
│   │                            standings.ts, flags.ts, telegram.ts (start_param диплинк Mini App)
│   └── styles/
├── supabase/migrations/  — 0001–0026 на `main`: схема → очки → RLS → валидация → invite/membership →
│                           open_race → keepalive → admin-результаты → driver_standing →
│                           telegram_announced → predicted_user_ids → revoke_public_execute →
│                           GridBot-аккаунт → display_name unique → гостевой read-only доступ
│                           (кил-свитч `app_settings` + RLS для anon, 0016) → 4 раунда доотзыва
│                           избыточных default-грантов Supabase (0017-0020, тот же класс, что 0013) →
│                           Telegram Mini App identity-линковка (0021 `telegram_links` + 0022 revoke) →
│                           admin-уведомления: очередь + триггеры + `pg_net` (0023) →
│                           raceweek_announced (0024) → пул гонки: `out_reason`/`added_reason`
│                           (0025/0026 — DNF-пометка и пометка «добавлен позже снимка»)
├── supabase/functions/   — Edge Functions (Deno)
│   ├── admin-notify/        — приём событий от Postgres-триггеров (`pg_net`) И от фронта напрямую
│   │                          (anon-ключ, `event_type: 'pool_change'` из АдминPool); тексты
│   │                          уведомлений + отправка/очередь по тихим часам (`format.ts`+`index.ts`)
│   └── telegram-auth/        — обмен подписанных Telegram Mini App `initData` на настоящую
│                                Supabase-сессию (`verify.ts`+`index.ts`)
├── scripts/              — самостоятельные cloud-direct пакеты (свой `package.json` в каждом)
│   ├── db/                  — миграции + тесты (RLS, формула очков, view, security grants, GridBot...)
│   ├── import/                — импорт пилотов/календаря/результатов из Jolpica (Фаза 1)
│   ├── autoresults/             — автозабор результата гонки (Jolpica → OpenF1 фолбэк)
│   ├── ai-player/                — GridBot: сбор данных, промпт Gemini, валидация/фолбэк, сохранение
│   ├── telegram/                   — напоминания/итоги в общий чат + `adminflush` (разгрузка
│   │                                  ночной очереди admin-уведомлений)
│   ├── export/                       — бэкап в Google Sheets
│   └── dev/                            — разовые dev-бутстрап скрипты
└── .github/workflows/
    ├── deploy.yml           — сборка + публикация на GitHub Pages
    ├── keepalive.yml         — 2×/день, реальный RPC против Supabase (free-tier не засыпает)
    └── telegram-notify.yml    — cron: raceweek/deadline/remind/autoresults/results/aiplayer/adminflush
```

## Roadmap (фазы)
0 Supabase ✅ · 1 Данные ✅ · 2 Ядро: 2a Каркас+Auth ✅ 2026-06-30 → 2b Календарь+Прогноз ✅
2026-07-07 → 2c Админка ✅ 2026-07-14 · 3 Витрина ✅ 2026-07-15 · 4 Автоматика ✅ (GitHub Actions
вместо `pg_cron`; автозабор + GridBot) · 5 Telegram-бот ✅ 2026-07-21 · 6 Полировка — идёт (drift
chart ✅, сброс пароля ✅, GridBot ✅, README ✅, гостевой read-only доступ ✅ 2026-08-01,
admin-уведомления в Telegram ✅ 2026-08-06; мобильная раскладка проверена в смоуке 2b). Telegram
Mini App влита в `main` 2026-09-03 (Task 1-9 готовы, **Task 10 — сквозной живой смоук так и не
прогнан**, см. MEMORY.md «Открытые вопросы»). Автопроверка состава пилотов + Админка без SQL ✅
2026-09-03.
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
- `supabase/migrations/` (0001–0026 на `main`): схема → формула очков (`score_prediction` +
  view `scores`) → RLS/гранты/`is_admin()` → валидация состава прогноза → инвайт/членство →
  `open_race()` → keep-alive RPC → занос/правка результата админом (`set_race_result`) →
  `driver_standing` → флаг анонса в Telegram → RPC для списка проголосовавших → отзыв публичного
  `execute` → аккаунт GridBot → уникальность `display_name` (закрывает захват аккаунта GridBot) →
  гостевой read-only доступ: кил-свитч `app_settings`/`guest_access_enabled()`/`set_guest_access()`
  + RLS-политики для `anon` на `races/drivers/results/predictions(после дедлайна)/
  users(id+display_name)/scores` (0016) → 4 раунда доотзыва избыточных default-грантов Supabase
  на новых и старых таблицах (0017-0020, тот же класс проблемы, что инцидент 0013) →
  Telegram Mini App: таблица связи `telegram_links`+revoke дефолтных грантов (0021/0022) →
  admin-уведомления: `admin_notification_queue` + триггеры `notify_admin_event()` на
  `users`/`predictions`/`results` + `pg_net` (0023) → `races.raceweek_announced_at` (0024) →
  `race_driver_pool.out_reason`/`added_reason` (0025/0026 — DNF-пометка «не участвует» и пометка
  «добавлен в пул позже исходного снимка», обе с причиной в тексте).
- Edge Functions (Deno, `supabase/functions/`):
  - `admin-notify` — принимает событие от pg_net-триггера ИЛИ напрямую от фронта (anon-ключ,
    `event_type: 'pool_change'` из Админки состава пилотов), строит текст, шлёт сразу в Telegram
    (админ-чат — 10:00-22:00 МСК, общий чат для `pool_change` — всегда сразу без задержки) или
    кладёт в очередь (`auth: 'publishable'`, без вторичной авторизации — осознанно принятый риск,
    см. MEMORY.md 2026-08-06). Для `pool_change` `action`/`reason` берутся из реального состояния
    `race_driver_pool` в БД, а не из тела запроса — иначе anon-ключ позволил бы разослать в общий
    чат лиги произвольную дезинформацию (найдено code-review 2026-09-03). `verify_jwt=false` в
    `config.toml` (вызывающий — своя же БД или фронт с anon-ключом, не пользовательская сессия).
  - `telegram-auth` — обменивает подписанный Telegram Mini App `initData` (HMAC-проверка) на
    настоящую Supabase-сессию через identity в `telegram_links`; `verify_jwt=false`.
- Секреты — в `.env` (gitignored): `SUPABASE_DB_URL` (transaction pooler с паролем БД).

## Фронтенд
- Vite + React 18 + TypeScript + React Router + `@supabase/supabase-js` + `@dnd-kit`.
- Маршруты: `/login /signup /redeem /reset-password` (публичные), `/calendar /predict/:raceId
  /standings /results /rules` (по членству), `/admin /admin/result/:raceId` (админ, `AdminRoute`),
  `/g/calendar /g/standings /g/results /g/rules` (гостевой read-only просмотр без аккаунта, под
  `guest_access_enabled()`-свитчем; `Standings/Results/Rules` смонтированы на обоих деревьях
  маршрутов без изменений в самих компонентах — гейтятся не собственной логикой, а RLS). Корень
  `/` — `RootRedirect`: есть сессия → `/calendar`, нет → `/g/calendar`.
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
  (ср/чт), `autoresults`+`results` (каждые 2ч), `aiplayer` (чт до дедлайна), `adminflush` (10:05
  МСК ежедневно — разгрузка ночной очереди admin-уведомлений). Полное расписание и разбор каждого
  режима — `README.md` § Telegram-уведомления. Открытие очередной гонки (`status: demo -> open`)
  больше не ручное — `ensureCurrentWeekOpen()` в `notify.js` вызывается на каждом запуске
  (`main()`, любой режим), сама находит гонку этой недели и открывает.
- На режимах `raceweek`/`deadline` дополнительно (best-effort, не рвёт основной режим при сбое)
  запускается `checkDriverPool()`: подтягивает `drivers` из Jolpica, сверяет с составом ближайшей
  сессии OpenF1, расширяет `race_driver_pool` открытых гонок и шлёт уведомление в оба чата, если
  что-то реально добавилось. Подстраховка на случай замены пилота между открытием гонки и
  дедлайном — основной путь починки живьём остаётся ручным через Админку `/admin/pool/:raceId`.
- `deadline()` шлёт баннер (`sendTelegramPhoto`, `lib.js`) как multipart-загрузку файла, а не
  URL-ссылкой — Telegram живьём нестабильно докачивал картинку с GitHub Pages по URL (400 "failed
  to get HTTP URL content", см. Changelog 2026-09-10), скрипт теперь сам скачивает файл и грузит
  его байты.
- **Известный риск (не решён, 2 случая — 2026-08-31 и 2026-09-10):** scheduled-прогоны GitHub
  Actions иногда полностью пропадают на много часов сразу у нескольких воркфлоу репозитория
  (`keepalive.yml` и `telegram-notify.yml`), без объяснения на стороне GitHub (Actions permissions
  в порядке, github status — operational). Причина не найдена. Детали и непроверенная гипотеза —
  `MEMORY.md` § Открытые вопросы.

## GridBot (ИИ-игрок)
Обычный аккаунт `public.users` (не отдельный UI), ставит прогноз через Gemini API по тем же
правилам, что и люди; при сбое — фолбэк на сортировку по чемпионату. Полный разбор архитектуры,
промпта и настройки — `README.md` § GridBot, дизайн/план — `docs/superpowers/specs/2026-07-24-ai-player-design.md`.

## Changelog
### 2026-09-10 (пропавшее утреннее напоминание — баг sendTelegramPhoto + повторный провал GitHub Actions scheduler)
- **Root cause №1 (исправлен):** `sendTelegramPhoto()` слала Telegram голый URL баннера и просила
  скачать его самостоятельно — живьём стабильно ловили `400 "failed to get HTTP URL content"`,
  хотя файл на GitHub Pages отдаётся нормально (известная нестабильность фетчера Telegram по URL).
  Фикс: скрипт сам скачивает файл и грузит как multipart (`FormData`+`Blob`). Подтверждено рабочим
  повторным прогоном (напоминание дошло).
- **Root cause №2 (НЕ решён):** независимо от бага с баннером, все scheduled-прогоны сразу у
  `keepalive.yml` и `telegram-notify.yml` пропали на 6.5+ часов, без единого queued/in_progress.
  Второй такой случай (первый — 2026-08-31). Подробности и непроверенная гипотеза —
  `MEMORY.md` § Открытые вопросы.
- Мелкая правка: кнопка «Поставить прогноз» → «Сделать прогноз» (отставала от `370c7ee`).
- Коммиты `6f78c73`, `c91f4c9` на `main`+`telegram-mini-app`.

### 2026-09-03 (живой инцидент Аджар/Цунода → автопроверка состава пилотов + Админка без SQL; telegram-mini-app влита в main)
- Живой инцидент: Аджар травмирован, замена — Цунода, которого вообще не было в `drivers`.
  Найдено: `race_driver_pool` — разовый снимок при `open_race()`, никогда не обновляется, и
  `set_race_result` тоже валидирует состав против пула (сломался бы и автозанос результата).
  Почин вручную через SQL прямо во время гонки, смержено сразу в `main` отдельной веткой
  `fix/dnf-out-badge`: `race_driver_pool.out_reason` (`0025`) + бейдж DNF на `DriverChip`.
- Полный цикл brainstorming → spec → plan → subagent-driven-development (13 задач в изолированном
  worktree) на постоянное решение: `checkDriverPool()` (`scripts/telegram/notify.js`, крон
  raceweek/deadline) — Jolpica+OpenF1 сверка, автодополнение пула, уведомление в оба чата;
  Админка `/admin/pool/:raceId` (`src/pages/AdminPool.tsx`) — ручное добавление/пометка «не
  участвует» без SQL; `admin-notify` расширен `event_type: 'pool_change'`.
- **Security-находка code-review (Critical), исправлена до мержа:** `pool_change` изначально
  доверял `action`/`reason` из тела запроса — публично достижимый anon-ключом эндпоинт позволял
  разослать в общий чат лиги произвольную дезинформацию под видом реальной замены пилота. Почин:
  `action`/`reason` теперь читаются из `race_driver_pool` в БД, а не из payload.
- Три внеплановых бага найдены и починены по ходу (два — живым тестированием, не код-ревью):
  `require()` чужого модуля без `require.main === module` убивал бы процесс; простаивающее
  DB-соединение в `scripts/telegram/lib.js` рвалось пулером Supabase без обработчика `error`
  (процесс падал целиком); `checkDriverPool()` в `main()` без своего try/catch могла утопить
  настоящее deadline-напоминание того же крон-слота.
- Симметричный бейдж «ЗАМЕНА» (`race_driver_pool.added_reason`, `0026`) — `NULL` значит «в
  исходном снимке», заполнено — «добавлен позже» (вручную с причиной или автопроверкой). DNF
  теперь нельзя выбрать в новом прогнозе (уже сделанные прогнозы не трогаются).
- Ветка `telegram-mini-app` целиком влита в `main` и запушена (осознанный выбор — вычленять
  только правки про пул было бы рискованно конфликтами из-за пересекающихся файлов). **Task 10
  Mini App (сквозной живой смоук) при этом НЕ прогнан** — см. MEMORY.md «Открытые вопросы».
### 2026-09-01 (автооткрытие гонки — root cause пропавшего напоминания raceweek)
- Открытие гонки (`open_race()`) всегда было ручным (кнопка в Админке) — на round 13 (Italian GP)
  на этой неделе никто не нажал, `raceweek`/`deadline` в `notify.js` фильтруют `status='open'` и
  корректно ничего не отправили (пусто — не сбой). Побочно найдена и не связана напрямую: дыра в
  8ч в расписании GitHub Actions утром 2026-08-31 (5 пропущенных прогонов подряд).
- `ensureCurrentWeekOpen()` (`scripts/telegram/notify.js`) вызывается на каждом запуске `main()` —
  находит гонки `status='demo'` этой недели (МСК) и сама открывает через `open_race()` (прямой
  DB-коннект, гейт админ-проверки пропускает). Работает на самом частом кроне (раз в 2ч), переживает
  пропуск отдельных cron-слотов. Кнопка в Админке осталась как ручной способ вмешаться.
- `raceweek()` тоже стала идемпотентной (`races.raceweek_announced_at`, миграция
  `0024_raceweek_announced.sql`, тот же паттерн, что `telegram_announced_at` у `results()`) и
  вызывается на каждом запуске `main()`, а не только по понедельничному крону — анонс «🏁 RACE
  WEEK» гарантированно уходит, даже если понедельничный слот пропадёт (максимум с опозданием до
  следующего прогона).
### 2026-08-07 (Telegram Mini App — ветка `telegram-mini-app`, Task 10: root cause сетевого зависания найден)
- Диагностика через WebView Inspector в Telegram Desktop подтвердила root cause зависания из
  сессии 2026-08-06: включённое в Windows автообнаружение прокси (WPAD) — WebView-подпроцесс Mini
  App проходит его заново на каждое соединение, теряя 10-30+с (иногда без завершения) ДО начала
  самого TCP/TLS-подключения, которое само по себе быстрое. Backend/RLS ни при чём.
- Добавлена устойчивость в коде на случай похожих задержек у любого участника: `redeemInvite()`
  (`src/lib/db.ts`) — та же обёртка `withRetry` (таймаут+ретрай транзиентных сбоев), что и у
  остальных мутаций; `RedeemInvite.tsx` больше не дёргает `supabase.rpc` напрямую без таймаута
  (это и был точный код-путь зависшей кнопки «Вступить»). `AuthContext.tsx`: вызов `telegram-auth`
  получил `timeout: 10000` (раньше не имел таймаута вовсе).
- Добавлен `PasswordInput` (`src/components/PasswordInput.tsx`) — переключатель видимости пароля
  (SVG-иконка глаза, toggle `type="password"`/`"text"`), подключён в `Login`, `Signup`,
  `ResetPassword`.
- Напоминания о дедлайне (`deadline()` в `scripts/telegram/notify.js`) переведены с `sendMessage`
  на `sendPhoto`: баннер `public/telegram-banner.png` (1200×400, стиль проекта — #0B0E14, циан/
  малиновый, Titillium Web + Inter, слоган «Лига пророков») + подпись + кнопка «Поставить прогноз».
  `sendTelegramPhoto()` добавлена в `scripts/telegram/lib.js`. Инлайн-кнопки Telegram Bot API не
  поддерживают кастомный цвет (тема клиента), поэтому визуальный акцент — через картинку, не кнопку.
### 2026-08-06 (Telegram Mini App — ветка `telegram-mini-app`, Task 10 в работе)
- `predictButton()` (`scripts/telegram/notify.js`) переведён на полный формат ссылки Mini App:
  `t.me/che_f1_predict_bot/predict?startapp=predict_<raceId>` вместо `t.me/<bot>?startapp=...` —
  старый формат давал `BOT_INVALID` на Telegram Desktop (задокументированный platform-баг,
  работал только на мобильных). Требует зарегистрированного через BotFather `/newapp` Mini App с
  коротким именем `predict`. Тест обновлён, 16/16.
- Найдено, не решено: зависание сети внутри Telegram Mini App WebView (моб.+десктоп) при
  обращении к Supabase, backend при этом здоров — см. MEMORY.md, «Открытые вопросы» и заметку в
  плане (Task 10).
### 2026-08-03 (Telegram Mini App — ветка `telegram-mini-app`, Task 8-9 из 10)
- Task 8: `RedeemInvite.tsx` предзаполняет имя из Telegram-профиля (UX-подсказка, редактируемо).
- Task 9: кнопка «Поставить прогноз» (`url`-диплинк `t.me/<bot>?startapp=predict_<id>`) в живом
  cron-напоминании о дедлайне (`scripts/telegram/notify.js`), `sendTelegram()` — опциональный
  `reply_markup`, обратно совместимо. 16/16 тестов.
- Осталась Task 10 (ручная настройка + сквозной смоук) и финальное ревью ветки.
### 2026-08-03 (Telegram Mini App — ветка `telegram-mini-app`, Task 4-7 из 10)
- Task 4: `supabase/functions/telegram-auth/verify.ts` — проверка HMAC-подписи Telegram `initData`
  (TDD, 5/5). Review-фиксы: `deno.json` скоупит функцию (лок-файл больше не тянет npm-граф
  фронтенда), `crypto.subtle.verify` вместо ручного сравнения хешей.
- Task 5: `index.ts` — обмен `initData` на настоящую Supabase-сессию
  (`generateLink`+`createUser`-фолбэк+`verifyOtp`). Code-review нашёл Critical: детерминированный
  email позволял захват аккаунта через обычную `/signup` до первого захода жертвы в Mini App —
  унаследовано из плана дословно, не ошибка реализации. Исправлено: identity резолвится через
  `telegram_links` СНАЧАЛА, конфликт email → 409 вместо молчаливой выдачи чужой сессии. Независимо
  перепроверено трассировкой кода.
- Task 6: функция задеплоена в прод (`supabase functions deploy --use-api`, без Docker),
  `verify_jwt=false`, секрет заведён. Смоук: 401 + ожидаемое тело ошибки.
- Task 7: `AuthContext` — bootstrap Telegram-сессии при старте; `src/lib/telegram.ts` +
  `RootRedirect.tsx` — диплинк на конкретную гонку через `start_param` (см. правку Task 1 ниже).
### 2026-08-03 (Telegram Mini App — ветка `telegram-mini-app`, Task 1-3 из 10)
- Task 1 (ручная проверка): `web_app`-кнопки — platform-ограничение Telegram, работают только в
  личке с ботом, не в группах (`BUTTON_TYPE_INVALID` эмпирически). Спека и план (Task 7/9)
  исправлены до реализации: кнопка напоминания в общий чат — `url` на
  `t.me/<bot>?startapp=predict_<raceId>`, фронт читает `start_param` и редиректит на гонку.
  Проверка блокировки GitHub Pages внутри WebView — неубедительна (VPN пользователя нужен для
  самого Telegram, тест не изолирует поведение Mini App).
- Task 2: миграция `0021_telegram_links.sql` (+ `0022` — revoke дефолтных грантов anon/
  authenticated, тот же класс бага, что 0013/0017-0020). Spec+code review пройдены без правок.
- Task 3 (частично): Deno и Supabase CLI 2.111.0 поставлены на машину разработки (не в код проекта).
### 2026-08-06
- Admin-уведомления в Telegram (ЗАКРЫТО, ветка `admin-notify` влита в `main`): миграция
  `0023_admin_notify.sql` (таблица `admin_notification_queue`, триггеры `notify_admin_event()` на
  `users`/`predictions`/`results`, расширение `pg_net`); новая Edge Function
  `supabase/functions/admin-notify/` (`format.ts` — текст события + граница тихих часов 22:00-10:00
  МСК, `index.ts` — обработчик, шлёт сразу или кладёт в очередь); режим `adminflush` в
  `scripts/telegram/notify.js` (разгрузка очереди, новый крон-пункт 10:05 МСК). Событийная
  архитектура (Postgres-триггер → `pg_net.http_post` асинхронно → Edge Function), не polling —
  осознанный выбор дизайна. Эндпоинт без вторичной авторизации сверх publishable-ключа — принятый
  риск (детали в MEMORY.md). Подробности реализации, находки ревью и смоук — см. MEMORY.md.
### 2026-08-03
- `docs/telegram-guide.txt` — пользовательский гайд для участников лиги (регистрация, как ставить
  прогноз, где что смотреть на сайте, краткая формула очков), написан для прямого копирования в
  Telegram-чат. Инвайт-код (`F1-2026-LEAGUE`) проверен прямым запросом к облачной БД перед тем, как
  вписать в текст, а не взят из памяти. Не привязан к коду — чисто справочный документ, roadmap не
  затронут.
### 2026-08-01
- **Telegram Mini App (голосование в чате) — brainstorm+spec+plan готовы, реализация НЕ начата.**
  Спека `docs/superpowers/specs/2026-08-01-telegram-mini-app-design.md`, план (10 задач)
  `docs/superpowers/plans/2026-08-01-telegram-mini-app.md`. Архитектура: новая Edge Function
  `telegram-auth` (первый в проекте компонент такого типа — раньше всё было cloud-direct Postgres
  RPC + фронт) обменивает подписанные Telegram-данные на настоящую Supabase-сессию, дальше весь
  существующий UI работает без изменений. Остановлено на Task 1 (нет `TELEGRAM_BOT_TOKEN` в
  локальном `.env`) — структура/стек ещё не менялись по факту, обновить эти разделы, когда
  появится `supabase/functions/`.
- **Гостевой read-only доступ ЗАКРЫТ, ветка `guest-read-access` влита в `main` (fast-forward) и
  запушена**, локальная и удалённая feature-ветка удалены. Все 8 задач плана сделаны subagent-driven
  (implementer + spec-review + code-review на каждую), смоук пройден пользователем в браузере,
  финальное ревью всей ветки (14 коммитов) закрыто. DB: кил-свитч `app_settings` + RLS для `anon`
  (0016), 4 раунда доотзыва избыточных default-грантов Supabase (0017-0020, тот же класс, что
  инцидент 0013 — код-ревью каждый раз находило новый экземпляр). Frontend: `db.ts`-хелперы,
  переключатель в Админке, `GuestShell`/`GuestCalendar`, роутинг `/g/*` с сессия-зависимым корнем
  (`RootRedirect`). Попутно ревью нашло и закрыло два внеплановых бага: `Results.tsx` не показывал
  drift chart гостю по умолчанию, `view.test.js` коллидировал с реальным Australian GP.
  `guest_access.test.js`: 21→23 проверки. Тесты на смёрженном `main` перепроверены зелёными
  перед пушем.
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
