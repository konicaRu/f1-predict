-- 0012_predicted_user_ids.sql — узкий обход RLS для списка "кто уже сделал прогноз"
-- на вкладке "Прогноз" (стимул/соревновательный элемент). Отдаёт ТОЛЬКО user_id,
-- НЕ positions — содержимое прогноза до дедлайна остаётся скрытым как раньше.
-- security definer по прецеденту keepalive_ping() (0008_keepalive.sql).
create or replace function public.predicted_user_ids(p_race_id bigint)
returns setof uuid
language sql security definer set search_path = public as $$
  select user_id from public.predictions where race_id = p_race_id;
$$;

grant execute on function public.predicted_user_ids(bigint) to authenticated;
