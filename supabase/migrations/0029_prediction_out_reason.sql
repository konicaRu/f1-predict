-- 0029_prediction_out_reason.sql — пилот с пометкой «не участвует» (race_driver_pool.out_reason, 0025)
-- отклоняется и на сервере, а не только в UI (DriverPool блокирует клик). Конституция: «один пилот =
-- один слот, валидация и в UI, и в БД» — ревью 2026-10-08 нашло, что out_reason проверялся только в UI.
--
-- Правило то же, что в UI: нельзя ДОБАВИТЬ выбывшего пилота. Уже сделанный прогноз, где он стоял до
-- пометки, не ломаем — при правке (update) пилот, уже бывший в old.positions, остаётся допустимым,
-- иначе участник не смог бы поменять другие слоты, не убрав сперва выбывшего.
create or replace function public.validate_prediction()
returns trigger language plpgsql as $$
declare
  ids text[];
  bad text;
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

  select p.driver_id into bad
  from unnest(ids) e
  join public.race_driver_pool p on p.race_id = new.race_id and p.driver_id = e
  where p.out_reason is not null
    and not (tg_op = 'UPDATE' and old.race_id = new.race_id and old.positions ? e)
  limit 1;
  if bad is not null then
    raise exception 'driver % is out of this race', bad;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
