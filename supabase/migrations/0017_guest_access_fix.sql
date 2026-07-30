-- 0017_guest_access_fix.sql — фикс 0016, найденный код-ревью: колоночный grant на users был
-- no-op (Supabase по умолчанию грантит anon SELECT на все колонки каждой новой таблицы), и
-- set_guest_access имела неявный EXECUTE для PUBLIC (тот же класс проблемы, что 0013).

revoke select on public.users from anon;
grant select (id, display_name) on public.users to anon;

revoke execute on function public.set_guest_access(boolean) from public;
