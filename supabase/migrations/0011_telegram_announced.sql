-- 0011_telegram_announced.sql — трекинг «результат уже объявлен в Telegram».
-- Нужен, чтобы override уже занесённого результата (правка через Admin) НЕ слал повторное
-- сообщение в чат — шлём только один раз на гонку, при первом переходе в resulted+scored.
alter table public.races add column if not exists telegram_announced_at timestamptz;
