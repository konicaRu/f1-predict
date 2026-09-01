-- 0024_raceweek_announced.sql — трекинг «анонс RACE WEEK уже отправлен».
-- Нужен, чтобы raceweek() стала идемпотентной и её можно было безопасно звать на КАЖДОМ запуске
-- notify.js (не только по понедельничному крону) — так анонс не теряется, если понедельничный
-- слот пропущен GitHub Actions (см. MEMORY.md, инцидент 2026-08-31/2026-09-01).
alter table public.races add column if not exists raceweek_announced_at timestamptz;
