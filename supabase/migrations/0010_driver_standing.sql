-- 0010_driver_standing.sql — позиция пилота в чемпионате (для порядка пула, UX).
-- Заполняется импортом из Jolpica driverStandings. Nullable: у безкодовых/новых может не быть.
alter table public.drivers add column if not exists standing int;
