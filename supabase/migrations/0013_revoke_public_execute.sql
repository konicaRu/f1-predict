-- 0013_revoke_public_execute.sql — критический security-фикс. НЕ ПРИМЕНЕНО К БД —
-- см. журнал/память сессии 2026-07-22, требует ещё раунд эмпирической проверки
-- перед applyfile (проверялось только в откатываемых транзакциях).
--
-- Найдено ревью-агентом при работе над 0012_predicted_user_ids: анонимный (anon)
-- вызывающий мог вызвать open_race()/set_race_result()/predicted_user_ids() без
-- логина. Причина — ДВА независимых механизма одновременно, оба нужно закрывать:
--   1) Postgres при CREATE FUNCTION по умолчанию грантит EXECUTE роли PUBLIC,
--      если явно не отозвано ("grant execute ... to authenticated" — ДОПОЛНИТЕЛЬНЫЙ
--      грант, не единственный источник прав).
--   2) У этого Supabase-проекта уже настроены ALTER DEFAULT PRIVILEGES (владельцы
--      postgres/supabase_admin), которые автоматически грантят EXECUTE напрямую
--      роли anon на КАЖДУЮ новую функцию в public — независимо от PUBLIC.
-- Подтверждено эмпирически (rolled-back транзакции на реальной БД): revoke только
-- от PUBLIC не помогает (у anon свой прямой грант), revoke только от anon тоже не
-- помогает (PUBLIC-грант остаётся). Нужны ОБА revoke на каждую функцию сразу.
--
-- Подтверждено и другое: анонимный вызов open_race()/set_race_result() реально
-- проходил внутреннюю проверку ("auth.uid() is not null and not is_admin()") —
-- у анонимного PostgREST-вызова auth.uid() тоже null, как и у легитимного
-- service/bootstrap-подключения, проверка их не различала. Фикс на уровне
-- грантов закрывает это полностью: если у anon нет EXECUTE вообще, вызов
-- отклоняется Postgres ДО начала тела функции, внутренняя логика уже не важна.
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_member() from public, anon;
revoke execute on function public.redeem_invite(text, text) from public, anon;
revoke execute on function public.open_race(bigint) from public, anon;
revoke execute on function public.set_race_result(bigint, jsonb, text) from public, anon;
revoke execute on function public.predicted_user_ids(bigint) from public, anon;

-- На будущее: закрывает автогрант anon (механизм 2) для НОВЫХ функций. Грант
-- PUBLIC при CREATE FUNCTION (механизм 1) это не отменяет — каждая новая
-- security definer функция всё равно должна сама делать
-- "revoke execute ... from public" явно, ALTER DEFAULT PRIVILEGES на это не
-- влияет (не тот механизм). Стоит добавить памятку в scripts/db/README.md.
alter default privileges for role postgres in schema public revoke execute on functions from anon;
