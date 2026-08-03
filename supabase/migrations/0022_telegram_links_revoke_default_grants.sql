-- 0022_telegram_links_revoke_default_grants.sql — вслед за 0021: Supabase по умолчанию грантит
-- anon и authenticated все права на новую таблицу (INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER).
-- telegram_links должна быть доступна ТОЛЬКО из Edge Functions (service-role), отзываем все права.
revoke insert, select, update, delete, truncate, references, trigger on public.telegram_links from anon, authenticated;
