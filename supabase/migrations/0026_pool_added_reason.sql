-- 0026_pool_added_reason.sql — пометка «добавлен в пул после первоначального снимка» (замена), по
-- образцу out_reason (0025): NULL означает «в снимке open_race() с самого начала», не NULL — «добавлен
-- позже, вручную из Админки или автопроверкой checkDriverPool()».
alter table public.race_driver_pool add column if not exists added_reason text;
