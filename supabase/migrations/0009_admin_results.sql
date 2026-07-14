-- 0009_admin_results.sql — ручной занос результата гонки админом (spec 2c §5).
create or replace function public.set_race_result(
  p_race_id bigint, p_positions jsonb, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  ids text[];
begin
  -- Гейт: залогиненный обязан быть админом; прямое подключение (service/bootstrap) проходит.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'set_race_result: admin only';
  end if;

  -- Валидация состава (как validate_prediction): ровно 10 разных из пула гонки.
  if jsonb_typeof(p_positions) <> 'array' or jsonb_array_length(p_positions) <> 10 then
    raise exception 'result must be an array of exactly 10 drivers';
  end if;
  select array_agg(value) into ids from jsonb_array_elements_text(p_positions);
  if (select count(distinct e) from unnest(ids) e) <> 10 then
    raise exception 'result must contain 10 distinct drivers';
  end if;
  if exists (
    select 1 from unnest(ids) e
    where not exists (select 1 from public.race_driver_pool p
                      where p.race_id = p_race_id and p.driver_id = e)
  ) then
    raise exception 'all drivers must be in the race pool';
  end if;

  -- Журнал (before -> after).
  select positions into v_before from public.results where race_id = p_race_id;
  insert into public.result_changes(race_id, before, after, reason)
    values (p_race_id, v_before, p_positions, p_reason);

  -- Занос результата (final).
  insert into public.results(race_id, positions, status, fetched_at)
    values (p_race_id, p_positions, 'final', now())
  on conflict (race_id) do update
    set positions = excluded.positions, status = 'final', fetched_at = now();

  -- Зачёт гонки.
  update public.races set status = 'resulted', scored = true where id = p_race_id;
end;
$$;

grant execute on function public.set_race_result(bigint, jsonb, text) to authenticated;
