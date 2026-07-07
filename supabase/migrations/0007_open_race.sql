-- 0007_open_race.sql — перевод гонки в 'open' со снимком пула активных пилотов (spec 2b §7).
create or replace function public.open_race(p_race_id bigint)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_count  int;
begin
  -- Гейт прав: залогиненный пользователь обязан быть админом. Прямое подключение
  -- (bootstrap / service_role) не имеет auth.uid() -> проходит.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'open_race: admin only';
  end if;

  select status into v_status from races where id = p_race_id;
  if v_status is null then
    raise exception 'open_race: race % not found', p_race_id;
  end if;
  if v_status not in ('demo','open') then
    raise exception 'open_race: race % is % (only demo can be opened)', p_race_id, v_status;
  end if;

  -- Снимок пула: все активные пилоты, идемпотентно.
  insert into race_driver_pool (race_id, driver_id)
    select p_race_id, id from drivers where active
  on conflict do nothing;

  update races set status = 'open' where id = p_race_id and status = 'demo';

  select count(*) into v_count from race_driver_pool where race_id = p_race_id;
  return v_count;
end;
$$;

grant execute on function public.open_race(bigint) to authenticated;
