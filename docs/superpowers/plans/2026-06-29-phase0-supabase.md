# Фаза 0 — Фундамент Supabase. План реализации

> **Статус (2026-06-30): ВЫПОЛНЕНО, но не так, как написано ниже.** Локальный Docker не заработал →
> пивот на **cloud-direct**. Фактически: миграции `supabase/migrations/0001..0004` применены к облаку
> `konicaRu_f1` раннером `scripts/db/runner.js` (постейтментно, через session pooler); тесты — Node, а не
> pgTAP: `scripts/db/{scoring,view,rls}.test.js`. Результат: формула 7/7, view 131/10, RLS 7/7 (= критерий).
> Task 1 (Docker `supabase start`), Task 5 (seed.sql) и Task 10 (`supabase db push`) НЕ применялись —
> заменены cloud-direct подходом. Task 9 (keep-alive) — сделан, ждёт GitHub secrets от пользователя.
> Детали — `scripts/db/README.md` и `MEMORY.md`. SQL миграций ниже актуален.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять схему БД, RLS, валидацию прогноза, функцию/view очков и keep-alive — локально на Docker, с зелёными pgTAP-тестами, готовые к пушу в облако `konicaRu_f1`.

**Architecture:** Supabase CLI (`npx supabase`), миграции в `supabase/migrations/`. Вся закрытость лиги — на RLS (anon-ключ публичен). Дедлайн+владелец прогноза → RLS-политики; состав прогноза → BEFORE-триггер; очки → SQL-функция + view (`security_invoker`). Тесты — pgTAP (`npx supabase test db`).

**Tech Stack:** PostgreSQL 15+ (Supabase), pgTAP, Supabase CLI через npx, Docker, GitHub Actions.

**Источник правды:** `docs/superpowers/specs/2026-06-29-phase0-supabase-design.md` (решения W1–W4, D1–D5).

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| `supabase/config.toml` | конфиг проекта (генерит `supabase init`) |
| `supabase/migrations/0001_schema.sql` | таблицы, FK, индексы, CHECK |
| `supabase/migrations/0002_scoring.sql` | функция `score_prediction` + view `scores` |
| `supabase/migrations/0003_rls.sql` | grants, helper `is_admin()`, RLS-политики |
| `supabase/migrations/0004_validation.sql` | триггер `validate_prediction` |
| `supabase/seed.sql` | фикстуры для локальных тестов (2 юзера, гонка, пул, результат) |
| `supabase/tests/scoring_test.sql` | pgTAP: 7 примеров формулы из plan §3 |
| `supabase/tests/rls_test.sql` | pgTAP: 5 «красных» RLS-сценариев |
| `.github/workflows/keepalive.yml` | keep-alive пинг ×2/нед |
| `.env.example` | шаблон переменных (без секретов) |

Порядок миграций: схема → scoring → RLS → validation. Scoring до RLS, т.к. view `scores` существует независимо от политик; validation последней, т.к. опирается на готовую `race_driver_pool`.

---

## Task 1: Скаффолд Supabase, локальный стек

**Files:**
- Create: `supabase/config.toml` (через CLI), `.env.example`
- Modify: `.gitignore` (добавить supabase-временное)

- [ ] **Step 1: Инициализировать проект Supabase**

Run: `npx supabase init`
Expected: создаётся `supabase/config.toml`, `supabase/.gitignore`. На вопрос про VS Code settings — `N`.

- [ ] **Step 2: Поднять локальный стек**

Run: `npx supabase start`
Expected: тянет Docker-образы (первый раз — несколько минут), затем печатает `API URL`, `DB URL`, `anon key`, `service_role key`, `Studio URL`. Стек запущен.

- [ ] **Step 3: Создать `.env.example`** (в корне репо)

```
# Локальные значения печатает `npx supabase start`. Реальные облачные — в .env (НЕ в git).
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<anon key из вывода supabase start>
```

- [ ] **Step 4: Дополнить `.gitignore`**

Добавить строки (если их нет):
```
# Supabase
supabase/.branches
supabase/.temp
```

- [ ] **Step 5: Commit**

```bash
git add supabase/config.toml supabase/.gitignore .env.example .gitignore
git commit -m "chore(phase0): инициализация Supabase, локальный стек"
```

---

## Task 2: Миграция схемы (0001)

**Files:**
- Create: `supabase/migrations/0001_schema.sql`

- [ ] **Step 1: Написать миграцию схемы**

```sql
-- 0001_schema.sql — таблицы Фазы 0 (см. spec §2)

-- Профиль поверх auth.users
create table public.users (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text not null,
  telegram_username text,
  telegram_user_id  bigint,
  is_admin          boolean not null default false,
  created_at        timestamptz not null default now()
);

-- Справочник пилотов (автосинк в Фазе 4)
create table public.drivers (
  id         text primary key,            -- Jolpica driverId-слаг (D1)
  code       text not null unique,        -- VER, NOR — для UI
  name       text not null,
  team       text,
  team_color text,
  active     boolean not null default true
);

-- Календарь
create table public.races (
  id                bigint generated always as identity primary key,
  season            int not null default 2026,
  round             int not null,
  name              text not null,
  race_datetime_utc timestamptz,
  deadline_utc      timestamptz not null,
  status            text not null default 'demo'
                    check (status in ('demo','open','closed','resulted')),
  scored            boolean not null default false,
  unique (season, round)
);

-- Снимок пула на дедлайн (§9 плана)
create table public.race_driver_pool (
  race_id   bigint not null references public.races(id) on delete cascade,
  driver_id text   not null references public.drivers(id),
  primary key (race_id, driver_id)
);

-- Прогнозы: positions = jsonb-массив из 10 driver_id (индекс 0..9 = слот 1..10), D2
create table public.predictions (
  id         bigint generated always as identity primary key,
  user_id    uuid   not null references public.users(id) on delete cascade,
  race_id    bigint not null references public.races(id) on delete cascade,
  positions  jsonb  not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, race_id)
);
create index predictions_race_idx on public.predictions(race_id);

-- Факт результата
create table public.results (
  race_id    bigint primary key references public.races(id) on delete cascade,
  positions  jsonb  not null,             -- массив топ-10 driver_id
  status     text   not null default 'provisional'
             check (status in ('provisional','final')),
  fetched_at timestamptz not null default now()
);

-- Журнал правок результата (§8 плана)
create table public.result_changes (
  id         bigint generated always as identity primary key,
  race_id    bigint not null references public.races(id) on delete cascade,
  before     jsonb,
  after      jsonb,
  changed_at timestamptz not null default now(),
  reason     text
);
```

- [ ] **Step 2: Применить миграцию начисто**

Run: `npx supabase db reset`
Expected: `Applying migration 0001_schema.sql...` без ошибок, заканчивается `Finished supabase db reset`.

- [ ] **Step 3: Проверить, что таблицы созданы**

Run:
```bash
npx supabase db reset && echo "\dt public.*" | npx supabase db psql 2>/dev/null || \
  docker exec supabase_db_f1_predict psql -U postgres -c "\dt public.*"
```
Expected: в списке 7 таблиц — `users, drivers, races, race_driver_pool, predictions, results, result_changes`.
(Если имя контейнера иное — взять из `docker ps`. Достаточно убедиться, что 7 таблиц на месте.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_schema.sql
git commit -m "feat(phase0): схема таблиц (users, drivers, races, predictions, results...)"
```

---

## Task 3: Функция очков `score_prediction` — TDD (0002, часть 1)

Чистая логика — пишем тест первым. 7 примеров из plan §3.

**Files:**
- Create: `supabase/tests/scoring_test.sql`
- Create: `supabase/migrations/0002_scoring.sql`

- [ ] **Step 1: Написать падающий pgTAP-тест** (`supabase/tests/scoring_test.sql`)

```sql
begin;
select plan(8);

-- Хелпер не существует ещё → тесты упадут. Кейсы — из plan §3.
-- positions: массив 10 кодов; actual: реальный топ-10.

-- Пример 1: точное попадание NOR на P1 (actual P1=NOR) → вклад 25+3=28.
select is(
  (select points from score_prediction(
     '["NOR","x2","x3","x4","x5","x6","x7","x8","x9","x10"]'::jsonb,
     '["NOR","a2","a3","a4","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  28, 'P1 точно = 28');

-- exact_hits для примера 1 = 1
select is(
  (select exact_hits from score_prediction(
     '["NOR","x2","x3","x4","x5","x6","x7","x8","x9","x10"]'::jsonb,
     '["NOR","a2","a3","a4","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  1, 'P1 точно → 1 точное попадание');

-- Пример 2: LEC на P2, приехал P3 → 18 - 2*1 = 16.
select is(
  (select points from score_prediction(
     '["z1","LEC","z3","z4","z5","z6","z7","z8","z9","z10"]'::jsonb,
     '["a1","a2","LEC","a4","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  16, 'P2 при ошибке 1 = 16');

-- Пример 3: RUS на P5, приехал P2 → 10 - 2*3 = 4.
select is(
  (select points from score_prediction(
     '["z1","z2","z3","z4","RUS","z6","z7","z8","z9","z10"]'::jsonb,
     '["a1","RUS","a3","a4","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  4, 'P5, приехал выше (P2) = 4');

-- Пример 4: VER на P1, скатился P4 → 25 - 2*3 = 19.
select is(
  (select points from score_prediction(
     '["VER","z2","z3","z4","z5","z6","z7","z8","z9","z10"]'::jsonb,
     '["a1","a2","a3","VER","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  19, 'P1, скатился P4 = 19');

-- Пример 5: GAS на P3, финиш P9 → 15 - 2*6 = 3.
select is(
  (select points from score_prediction(
     '["z1","z2","GAS","z4","z5","z6","z7","z8","z9","z10"]'::jsonb,
     '["a1","a2","a3","a4","a5","a6","a7","a8","GAS","a10"]'::jsonb)),
  3, 'P3, финиш P9 = 3');

-- Пример 6: BOT на P8, вне топ-10 → 0.
select is(
  (select points from score_prediction(
     '["z1","z2","z3","z4","z5","z6","z7","BOT","z9","z10"]'::jsonb,
     '["a1","a2","a3","a4","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  0, 'вне топ-10 = 0');

-- Пример 7: ALO на P10, приехал P3 → 1 - 2*7 = -13 → обрезка до 0.
select is(
  (select points from score_prediction(
     '["z1","z2","z3","z4","z5","z6","z7","z8","z9","ALO"]'::jsonb,
     '["a1","a2","ALO","a4","a5","a6","a7","a8","a9","a10"]'::jsonb)),
  0, 'ниже нуля → обрезка до 0');

select * from finish();
rollback;
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx supabase test db`
Expected: FAIL — `function score_prediction(jsonb, jsonb) does not exist`.

- [ ] **Step 3: Написать функцию** (`supabase/migrations/0002_scoring.sql`)

```sql
-- 0002_scoring.sql — формула очков (plan §3, D5). Дубль TS-версии scoring.ts.

create or replace function public.score_prediction(prediction jsonb, actual jsonb)
returns table (points int, exact_hits int)
language plpgsql immutable as $$
declare
  weights int[] := array[25,18,15,12,10,8,6,4,2,1];
  y int; i int; x int; p int;
  code text;
begin
  points := 0;
  exact_hits := 0;
  for y in 1..10 loop
    code := prediction->>(y-1);                 -- пилот в слоте Y
    if code is null then continue; end if;
    x := null;                                  -- реальная позиция (1-based)
    for i in 0..(jsonb_array_length(actual)-1) loop
      if actual->>i = code then x := i+1; exit; end if;
    end loop;
    if x is null then continue; end if;         -- вне реального топ-10
    p := greatest(0, weights[y] - 2*abs(x - y));
    if x = y then
      p := p + 3;
      exact_hits := exact_hits + 1;
    end if;
    points := points + p;
  end loop;
  return next;
end;
$$;
```

- [ ] **Step 4: Применить и прогнать тест**

Run: `npx supabase db reset && npx supabase test db`
Expected: PASS — `scoring_test.sql ... ok`, 8/8.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_scoring.sql supabase/tests/scoring_test.sql
git commit -m "feat(phase0): функция score_prediction + pgTAP-тесты формулы"
```

---

## Task 4: View `scores` (0002, часть 2)

**Files:**
- Modify: `supabase/migrations/0002_scoring.sql` (дописать в конец)

- [ ] **Step 1: Дописать view в конец `0002_scoring.sql`**

```sql
-- View очков: считается из predictions ⋈ results. security_invoker → уважает RLS
-- (до дедлайна чужие прогнозы не утекают и через view).
create view public.scores
  with (security_invoker = true) as
select p.user_id, p.race_id, s.points, s.exact_hits
from public.predictions p
join public.results r on r.race_id = p.race_id
cross join lateral public.score_prediction(p.positions, r.positions) s;
```

- [ ] **Step 2: Применить миграцию начисто**

Run: `npx supabase db reset`
Expected: без ошибок; view `scores` создан.

- [ ] **Step 3: Проверить view smoke-запросом**

Run:
```bash
docker exec -i $(docker ps -qf name=supabase_db) psql -U postgres -c \
"insert into drivers(id,code,name) select 'd'||g, 'D'||g, 'Drv'||g from generate_series(1,10) g;
 insert into races(round,name,deadline_utc) values (1,'Test', now()-interval '1 day') returning id \gset
 insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','a@t.io');
 insert into users(id,display_name) values ('00000000-0000-0000-0000-000000000001','A');
 insert into results(race_id,positions) values (:id, (select jsonb_agg('d'||g) from generate_series(1,10) g));
 insert into predictions(user_id,race_id,positions) values ('00000000-0000-0000-0000-000000000001', :id, (select jsonb_agg('d'||g) from generate_series(1,10) g));
 select points, exact_hits from scores;"
```
Expected: одна строка — `points=131, exact_hits=10` (идеальный прогноз = потолок за гонку).
Затем `npx supabase db reset` (очистить ручную вставку).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_scoring.sql
git commit -m "feat(phase0): view scores (security_invoker) поверх score_prediction"
```

---

## Task 5: Сид-фикстуры для тестов

**Files:**
- Create: `supabase/seed.sql`

- [ ] **Step 1: Написать сид** (`supabase/seed.sql`)

Сид грузится автоматически при `npx supabase db reset`. Две гонки (открытая и закрытая), 2 юзера (обычный + второй), пул, результат закрытой гонки.

```sql
-- seed.sql — фикстуры для локальной разработки и pgTAP-тестов.
-- UUID фиксированы, чтобы тесты на них ссылались.

-- auth.users (минимум: id + email; остальное — дефолты локального стека)
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'user_a@test.io'),
  ('22222222-2222-2222-2222-222222222222', 'user_b@test.io'),
  ('33333333-3333-3333-3333-333333333333', 'admin@test.io');

insert into public.users (id, display_name, is_admin) values
  ('11111111-1111-1111-1111-111111111111', 'User A', false),
  ('22222222-2222-2222-2222-222222222222', 'User B', false),
  ('33333333-3333-3333-3333-333333333333', 'Admin',  true);

insert into public.drivers (id, code, name) values
  ('ver','VER','Verstappen'), ('nor','NOR','Norris'), ('lec','LEC','Leclerc'),
  ('ham','HAM','Hamilton'),   ('rus','RUS','Russell'),('pia','PIA','Piastri'),
  ('alo','ALO','Alonso'),     ('sai','SAI','Sainz'),  ('gas','GAS','Gasly'),
  ('oco','OCO','Ocon'),       ('alb','ALB','Albon');

-- Гонка 1: ОТКРЫТАЯ (дедлайн в будущем)
insert into public.races (id, season, round, name, deadline_utc, status)
  overriding system value values
  (1, 2026, 1, 'Open GP', now() + interval '2 days', 'open');

-- Гонка 2: ЗАКРЫТАЯ (дедлайн в прошлом, есть результат)
insert into public.races (id, season, round, name, deadline_utc, status)
  overriding system value values
  (2, 2026, 2, 'Closed GP', now() - interval '1 day', 'resulted');

-- Пул для обеих гонок: первые 10 пилотов (ver..oco)
insert into public.race_driver_pool (race_id, driver_id)
select r.id, d.id
from (values (1),(2)) r(id)
cross join (values ('ver'),('nor'),('lec'),('ham'),('rus'),('pia'),('alo'),('sai'),('gas'),('oco')) d(id);

-- Результат закрытой гонки 2
insert into public.results (race_id, positions, status) values
  (2, '["ver","nor","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb, 'final');

-- Прогноз User B на закрытую гонку 2 (для теста видимости после дедлайна)
insert into public.predictions (user_id, race_id, positions) values
  ('22222222-2222-2222-2222-222222222222', 2,
   '["ver","nor","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb);

-- Сброс sequence races на следующий id
select setval(pg_get_serial_sequence('public.races','id'), 2, true);
```

- [ ] **Step 2: Применить с сидом**

Run: `npx supabase db reset`
Expected: `Seeding data from supabase/seed.sql...` без ошибок.

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql
git commit -m "test(phase0): сид-фикстуры (юзеры, гонки, пул, результат)"
```

---

## Task 6: Grants, helper и RLS-политики (0003)

**Files:**
- Create: `supabase/migrations/0003_rls.sql`

- [ ] **Step 1: Написать RLS-миграцию** (spec §3)

```sql
-- 0003_rls.sql — закрытость лиги. service_role обходит RLS (bypassrls), политики — для authenticated.

-- Helper: текущий пользователь админ? SECURITY DEFINER, чтобы не рекурсировать по RLS users.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.users where id = auth.uid()), false);
$$;

-- Грант-база: анон ничего не видит; authenticated — read, плюс точечная запись (гейтится RLS).
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant select on public.scores to authenticated;
grant insert, update on public.predictions to authenticated;
grant insert, update, delete on
  public.drivers, public.races, public.race_driver_pool,
  public.results, public.result_changes to authenticated;
-- users: менять можно только свои безопасные колонки (is_admin недоступен для UPDATE)
grant update (display_name, telegram_username, telegram_user_id) on public.users to authenticated;

-- Включить RLS
alter table public.users            enable row level security;
alter table public.drivers          enable row level security;
alter table public.races            enable row level security;
alter table public.race_driver_pool enable row level security;
alter table public.predictions      enable row level security;
alter table public.results          enable row level security;
alter table public.result_changes   enable row level security;

-- users: видно всем аутентиф.; UPDATE только своей строки (is_admin защищён грантом колонок)
create policy users_select on public.users
  for select to authenticated using (true);
create policy users_update_own on public.users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- drivers / races / pool: read all; write — админ (или service_role в обход RLS)
create policy drivers_select on public.drivers for select to authenticated using (true);
create policy drivers_write  on public.drivers for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy races_select on public.races for select to authenticated using (true);
create policy races_write  on public.races for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy pool_select on public.race_driver_pool for select to authenticated using (true);
create policy pool_write  on public.race_driver_pool for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- predictions: своя видна всегда; чужая — только после дедлайна
create policy pred_select_own on public.predictions
  for select to authenticated using (user_id = auth.uid());
create policy pred_select_after_deadline on public.predictions
  for select to authenticated
  using (exists (select 1 from public.races r
                 where r.id = race_id and now() > r.deadline_utc));
-- запись только своя и только до дедлайна; DELETE-политики нет → удаление запрещено
create policy pred_insert_own on public.predictions
  for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.races r
                          where r.id = race_id and now() <= r.deadline_utc));
create policy pred_update_own on public.predictions
  for update to authenticated
  using (user_id = auth.uid()
         and exists (select 1 from public.races r
                     where r.id = race_id and now() <= r.deadline_utc))
  with check (user_id = auth.uid());

-- results / result_changes: read all; write — админ/service_role
create policy results_select on public.results for select to authenticated using (true);
create policy results_write  on public.results for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy rc_select on public.result_changes for select to authenticated using (true);
create policy rc_write  on public.result_changes for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());
```

- [ ] **Step 2: Применить начисто**

Run: `npx supabase db reset`
Expected: миграция применяется без ошибок (политики и гранты созданы).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_rls.sql
git commit -m "feat(phase0): RLS-политики, гранты, helper is_admin"
```

---

## Task 7: Триггер валидации прогноза (0004)

**Files:**
- Create: `supabase/migrations/0004_validation.sql`

- [ ] **Step 1: Написать триггер** (spec §4)

```sql
-- 0004_validation.sql — состав прогноза: ровно 10 разных пилотов из пула гонки.

create or replace function public.validate_prediction()
returns trigger language plpgsql as $$
declare
  ids text[];
begin
  if jsonb_typeof(new.positions) <> 'array'
     or jsonb_array_length(new.positions) <> 10 then
    raise exception 'prediction must be an array of exactly 10 drivers';
  end if;

  select array_agg(value) into ids
  from jsonb_array_elements_text(new.positions);

  if (select count(distinct e) from unnest(ids) e) <> 10 then
    raise exception 'prediction must contain 10 distinct drivers';
  end if;

  if exists (
    select 1 from unnest(ids) e
    where not exists (
      select 1 from public.race_driver_pool p
      where p.race_id = new.race_id and p.driver_id = e)
  ) then
    raise exception 'all drivers must be in the race pool';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger predictions_validate
  before insert or update on public.predictions
  for each row execute function public.validate_prediction();
```

- [ ] **Step 2: Применить начисто**

Run: `npx supabase db reset`
Expected: триггер создан, ошибок нет.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0004_validation.sql
git commit -m "feat(phase0): BEFORE-триггер валидации состава прогноза"
```

---

## Task 8: RLS pgTAP-тесты — критерий готовности (spec §7)

**Files:**
- Create: `supabase/tests/rls_test.sql`

Хелпер подмены пользователя: `set local role authenticated` + `request.jwt.claims` с `sub`.

- [ ] **Step 1: Написать pgTAP-тест** (`supabase/tests/rls_test.sql`)

```sql
begin;
select plan(7);

-- Утилита: войти как пользователь uuid (роль authenticated + jwt claim sub)
create or replace function tests.login(uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', uid::text, 'role','authenticated')::text, true);
end $$;

-- Сценарий 1: User A НЕ видит прогноз User B на ОТКРЫТУЮ гонку (1).
-- (B ещё не ставил на гонку 1 → сначала вставим от лица B, проверим невидимость для A.)
select tests.login('22222222-2222-2222-2222-222222222222');  -- B
insert into public.predictions (user_id, race_id, positions) values
  ('22222222-2222-2222-2222-222222222222', 1,
   '["ver","nor","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb);

select tests.login('11111111-1111-1111-1111-111111111111');  -- A
select is(
  (select count(*) from public.predictions where race_id = 1 and user_id <> '11111111-1111-1111-1111-111111111111')::int,
  0, '1. A не видит чужой прогноз на открытую гонку (до дедлайна)');

-- Сценарий 1b: А ВИДИТ прогноз B на ЗАКРЫТУЮ гонку 2 (дедлайн прошёл; B-прогноз есть в сиде).
select is(
  (select count(*) from public.predictions where race_id = 2 and user_id = '22222222-2222-2222-2222-222222222222')::int,
  1, '1b. A видит чужой прогноз после дедлайна');

-- Сценарий 2: запись прогноза ПОСЛЕ дедлайна (гонка 2) — отказ (RLS insert check).
select throws_ok($$
  insert into public.predictions (user_id, race_id, positions) values
    ('11111111-1111-1111-1111-111111111111', 2,
     '["ver","nor","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb)
$$, NULL, '2. запись прогноза после дедлайна отклонена');

-- Сценарий 3a: дубль пилота (триггер) на открытую гонку 1 — отказ.
select throws_ok($$
  insert into public.predictions (user_id, race_id, positions) values
    ('11111111-1111-1111-1111-111111111111', 1,
     '["ver","ver","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb)
$$, 'prediction must contain 10 distinct drivers', '3a. дубль пилота отклонён');

-- Сценарий 3b: пилот не из пула ('alb' в пул гонки 1 не входит) — отказ.
select throws_ok($$
  insert into public.predictions (user_id, race_id, positions) values
    ('11111111-1111-1111-1111-111111111111', 1,
     '["alb","nor","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb)
$$, 'all drivers must be in the race pool', '3b. пилот не из пула отклонён');

-- Сценарий 4: обычный юзер пишет в results — отказ (RLS, не админ).
select throws_ok($$
  insert into public.results (race_id, positions) values
    (1, '["ver","nor","lec","ham","rus","pia","alo","sai","gas","oco"]'::jsonb)
$$, NULL, '4. обычный юзер не может писать results');

-- Сценарий 5: обычный юзер меняет свой is_admin — изменение не проходит (грант колонки).
select throws_ok($$
  update public.users set is_admin = true where id = '11111111-1111-1111-1111-111111111111'
$$, NULL, '5. обычный юзер не может выдать себе is_admin');

select * from finish();
rollback;
```

- [ ] **Step 2: Прогнать ВСЕ тесты начисто**

Run: `npx supabase db reset && npx supabase test db`
Expected: PASS — `scoring_test.sql ... ok` (8/8) и `rls_test.sql ... ok` (7/7). Это зелёный критерий готовности Фазы 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/rls_test.sql
git commit -m "test(phase0): RLS pgTAP — 5 красных сценариев (критерий готовности)"
```

---

## Task 9: Keep-alive workflow (spec §6)

**Files:**
- Create: `.github/workflows/keepalive.yml`

- [ ] **Step 1: Написать workflow**

```yaml
name: keepalive
on:
  schedule:
    - cron: '17 6 * * 1'   # Пн 06:17 UTC
    - cron: '17 6 * * 4'   # Чт 06:17 UTC
  workflow_dispatch:

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase REST (resets idle timer)
        run: |
          code=$(curl -s -o /dev/null -w "%{http_code}" \
            "${SUPABASE_URL}/rest/v1/drivers?select=id&limit=1" \
            -H "apikey: ${SUPABASE_ANON_KEY}")
          echo "HTTP $code"
          test "$code" = "200"
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/keepalive.yml
git commit -m "feat(phase0): keep-alive workflow (пинг Supabase ×2/нед)"
```

- [ ] **Step 3 (ПОЛЬЗОВАТЕЛЬ): завести GitHub secrets**

В `github.com/konicaRu/f1-predict` → Settings → Secrets and variables → Actions добавить:
- `SUPABASE_URL` = `https://kolrwuhjjsclqalapfzt.supabase.co`
- `SUPABASE_ANON_KEY` = anon-ключ из дашборда (Project Settings → API).

Затем вручную запустить workflow (`Actions → keepalive → Run workflow`) и убедиться, что job зелёный (HTTP 200). На пустой таблице `drivers` ответ `200` с `[]` — это норма.

---

## Task 10: Линк и пуш в облако (ПОЛЬЗОВАТЕЛЬ)

Команды с ключами выполняет пользователь — агенту ключи не передаются.

- [ ] **Step 1: Залинковать облачный проект**

Run: `npx supabase link --project-ref kolrwuhjjsclqalapfzt`
(Запросит пароль БД — из дашборда.)

- [ ] **Step 2: Запушить миграции**

Run: `npx supabase db push`
Expected: применяются 0001–0004 в облако `konicaRu_f1`. Сид (`seed.sql`) в облако НЕ пушится — он только для локали.

- [ ] **Step 3: Проверить в дашборде**

Открыть Table Editor — 7 таблиц на месте; в Database → Migrations видны 4 миграции (`Last migration` больше не «No migrations»).

- [ ] **Step 4: Финальный пуш в git**

```bash
git push
```

---

## Самопроверка плана (выполнена при написании)

- **Покрытие спеки:** §1 структура → Task 1; §2 схема → Task 2; §3 RLS → Task 6; §4 валидация → Task 7; §5 scores → Tasks 3–4; §6 keep-alive → Task 9; §7 RLS-тесты → Task 8. Решения D1 (слаг id), D2 (jsonb-массив), D3 (is_admin флаг), D4 (view), D5 (дубль формулы) — отражены. W3/W4 (локаль→облако) → Task 10.
- **Плейсхолдеры:** нет — весь SQL/YAML конкретный.
- **Согласованность типов:** `positions` везде jsonb-массив из 10; `score_prediction(jsonb,jsonb)→(points,exact_hits)` одинаково в Tasks 3/4 и в smoke-тесте; имена политик/функций совпадают между 0003/0004 и тестами.

**Открытый риск (для исполнителя):** точные тексты исключений в RLS (`throws_ok` с `NULL` где ожидается любой отказ) и имя Docker-контейнера БД могут отличаться в среде — корректировать по факту первого прогона, поведение (отказ/пропуск) важнее текста.
