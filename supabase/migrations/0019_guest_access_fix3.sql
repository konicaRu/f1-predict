-- 0019_guest_access_fix3.sql — тот же класс проблемы, что 0017/0018, но на таблицах, которые
-- реально открывает гостевой доступ: anon по умолчанию имел табличные INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER на races/drivers/results/predictions/race_driver_pool. Сейчас
-- неэксплуатируемо (нет anon-политик на запись), отзываем на будущее.
revoke insert, update, delete, truncate, references, trigger
  on public.races, public.drivers, public.results, public.predictions, public.race_driver_pool
  from anon;
