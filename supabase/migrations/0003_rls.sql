-- 0003_rls.sql — закрытость лиги (spec §3). service_role обходит RLS; политики для authenticated.

-- Helper: текущий пользователь админ? SECURITY DEFINER, чтобы не рекурсировать по RLS users.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.users where id = auth.uid()), false);
$$;

-- Грант-база: анон ничего; authenticated — read + точечная запись (гейтится RLS).
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
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
-- запись только своя и только до дедлайна; DELETE-политики нет -> удаление запрещено
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
