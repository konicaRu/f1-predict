# MEMORY — журнал

## Статус проекта
Фаза 0 почти закрыта. **Все миграции (0001–0004) применены к облаку `konicaRu_f1` и тесты зелёные:**
формула 7/7, view 131/10, **RLS 7/7 = критерий готовности Фазы 0 выполнен.** Ветка `phase0-supabase`.
Скиллы: Superpowers активен, `karpathy-guidelines` в `~/.claude/skills/`.

**ВАЖНО — пивот на cloud-direct:** локальный Docker-стек Supabase на этой машине НЕ работает
(Docker не может тянуть образы из реестра — сетевой блок, даже hello-world виснет; containerd/прокси/
системный прокси проверены и ни при чём — проблема в сети Docker-VM). Поэтому отказались от
`supabase start`/pgTAP и пошли **напрямую против облака** через session pooler:
- Подключение: `.env` → `SUPABASE_DB_URL` = session pooler `aws-0-eu-west-1.pooler.supabase.com:5432`,
  user `postgres.kolrwuhjjsclqalapfzt` (direct-хост `db.<ref>.supabase.co` НЕ резолвится на free-тарифе).
  Пароль БД сброшен в дашборде, лежит в `.env` (URL-экранирован), `.env` в git НЕ идёт.
- Инструменты в репо: `scripts/db/` (runner.js + 3 теста, нужен `npm install` там; читают `.env`).
- Сеть до пулера флапает → раннер применяет миграции постейтментно с ретраем и проглатыванием
  дублей; тесты — одним запросом (DO-блок/CTE) в транзакции с откатом, облако чистое.

**Цель:** закрытая лига прогнозов F1 для компании друзей.
**Критерий MVP:** первая зачётная гонка играбельна = Фазы 0–3.

## Открытые вопросы / что осталось по Фазе 0
- **Проверить committed-харнесс:** `cd scripts/db && npm install && npm test` (вчера не успели запустить).
- **Обновить спеку и план** под cloud-direct (`docs/superpowers/specs|plans/...`) — они всё ещё описывают Docker/pgTAP.
- **Пользователю:** завести GitHub secrets `SUPABASE_URL` (`https://kolrwuhjjsclqalapfzt.supabase.co`) и
  `SUPABASE_ANON_KEY` (из дашборда) → запустить workflow `keepalive` вручную (зелёный = ок).
- Миграции применены напрямую раннером, БЕЗ supabase migration-трекинга. Если позже понадобится
  `supabase db push` — учесть, что в облаке нет записей в `supabase_migrations.schema_migrations`.
- Завершить ветку: merge `phase0-supabase` → `main` (finishing-a-development-branch).
- (опц.) Пользователь может вернуть галку containerd в Docker Desktop — мы её выключали зря.

## Лог сессий

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
