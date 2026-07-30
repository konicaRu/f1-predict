-- 0016_guest_access.sql — гостевой read-only доступ без регистрации (спека
-- docs/superpowers/specs/2026-07-27-guest-read-access-design.md). Третий уровень доступа
-- поверх anon(ничего)/member(всё): анонимное чтение подмножества данных, только пока включён
-- кил-свитч. Существующие политики authenticated/is_member() не трогаем.

-- Кил-свитч: одна строка настроек, дефолт OFF (fail closed — включает явно админ).
create table public.app_settings (
  key   text primary key,
  value boolean not null
);
alter table public.app_settings enable row level security;  -- без политик: доступ только через функции ниже
insert into public.app_settings (key, value) values ('guest_access_enabled', false);

create or replace function public.guest_access_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_settings where key = 'guest_access_enabled'), false);
$$;

create or replace function public.set_guest_access(p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'set_guest_access: admin only';
  end if;
  update public.app_settings set value = p_enabled where key = 'guest_access_enabled';
end $$;

grant execute on function public.guest_access_enabled() to anon, authenticated;
grant execute on function public.set_guest_access(boolean) to authenticated;

-- Базовый доступ анониму (сейчас у anon нет вообще ничего — grant-база 0003_rls.sql).
grant usage on schema public to anon;

-- races/drivers/results — полностью, только пока включён свитч.
grant select on public.races, public.drivers, public.results to anon;
create policy races_select_guest   on public.races   for select to anon using (public.guest_access_enabled());
create policy drivers_select_guest on public.drivers for select to anon using (public.guest_access_enabled());
create policy results_select_guest on public.results for select to anon using (public.guest_access_enabled());

-- race_driver_pool сознательно НЕ открываем анониму — гостевые страницы (Календарь/Результаты/
-- Зачёт/Правила) его не используют; не выдаём права сверх реально нужного.

-- predictions — только после дедлайна гонки (тот же гейт по времени, что уже есть для authenticated).
grant select on public.predictions to anon;
create policy pred_select_guest on public.predictions
  for select to anon
  using (
    public.guest_access_enabled()
    and exists (select 1 from public.races r where r.id = race_id and now() > r.deadline_utc)
  );

-- users — только id+display_name анониму; telegram_username/telegram_user_id не публикуем никогда.
grant select (id, display_name) on public.users to anon;
create policy users_select_guest on public.users for select to anon using (public.guest_access_enabled());

-- scores — view с security_invoker=true (0002_scoring.sql), сама уважает RLS predictions/results
-- вызывающей роли -> достаточно грантнуть select на саму view, отдельная политика не нужна.
grant select on public.scores to anon;
