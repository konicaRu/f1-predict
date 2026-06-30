-- 0005_is_sprint.sql — пометка спринт-уикендов (для тега SPRINT в UI).
alter table public.races add column if not exists is_sprint boolean not null default false;
