-- 0004_validation.sql — состав прогноза: ровно 10 разных пилотов из пула гонки (spec §4).

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
