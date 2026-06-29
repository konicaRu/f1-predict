-- 0001_schema.sql — таблицы Фазы 0 (см. docs/superpowers/specs/2026-06-29-phase0-supabase-design.md §2)

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
