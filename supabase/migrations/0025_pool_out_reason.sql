-- 0025_pool_out_reason.sql — постоянная пометка «не участвует в этой гонке» (травма/замена) на
-- строке пула, без удаления самого пилота из пула (уже сделанные прогнозы не трогаем).
alter table public.race_driver_pool add column if not exists out_reason text;
