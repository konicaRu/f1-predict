-- 0008_keepalive.sql — надёжный keep-alive через РЕАЛЬНУЮ запись в БД.
-- Прежний REST-SELECT под RLS возвращал 0 строк (анон не член лиги) и НЕ считался
-- активностью → проект уснул 2026-07-14. Теперь keepalive дёргает RPC, который делает
-- UPDATE (однозначная активность БД), обходя RLS через SECURITY DEFINER.

-- Однострочная таблица (без роста): singleton id=1.
create table public.keepalive (
  id        int primary key default 1,
  pinged_at timestamptz not null default now(),
  constraint keepalive_singleton check (id = 1)
);
insert into public.keepalive (id) values (1) on conflict do nothing;

-- RLS включена, политик нет: прямой доступ анону/authenticated закрыт, только через RPC.
alter table public.keepalive enable row level security;

-- RPC: обновляет метку времени и возвращает её. SECURITY DEFINER -> пишет в обход RLS.
create or replace function public.keepalive_ping()
returns timestamptz
language sql security definer set search_path = public as $$
  update public.keepalive set pinged_at = now() where id = 1 returning pinged_at;
$$;

-- Дёргает анонимный ключ (без входа) -> роль anon; и залогиненные тоже.
grant execute on function public.keepalive_ping() to anon, authenticated;
