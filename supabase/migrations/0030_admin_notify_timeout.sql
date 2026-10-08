-- 0030_admin_notify_timeout.sql — таймаут pg_net для вызова admin-notify 5 с → 60 с.
--
-- Зачем (ревью 2026-10-08, №7): у net.http_post по умолчанию 5 с, а admin-notify на прогнозе ждёт
-- шутку от Gemini (15-30 с с ретраями). Каждый такой вызов ложился в net._http_response как
-- «Timeout of 5000 ms reached», хотя функция дорабатывала и сообщение доходило — настоящий сбой
-- в этом журнале было не отличить от ложного. Обрыв со стороны pg_net функцию не убивает, так что
-- поведение не меняется, только журнал становится правдивым. 60 с — как у сторожа (0028).
-- Тело функции — копия 0023, изменён только timeout_milliseconds.
create or replace function public.notify_admin_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_type text;
  v_payload jsonb;
begin
  if tg_table_name = 'users' then
    v_event_type := 'registration';
    v_payload := jsonb_build_object(
      'display_name', new.display_name,
      'telegram_username', new.telegram_username
    );
  elsif tg_table_name = 'predictions' then
    v_event_type := 'prediction';
    v_payload := jsonb_build_object('user_id', new.user_id, 'race_id', new.race_id);
  elsif tg_table_name = 'results' then
    v_event_type := 'result';
    v_payload := jsonb_build_object('race_id', new.race_id);
  else
    return new;
  end if;

  perform net.http_post(
    url := 'https://kolrwuhjjsclqalapfzt.supabase.co/functions/v1/admin-notify',
    body := jsonb_build_object('event_type', v_event_type, 'payload', v_payload),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_np2Ps_SprPC0hf9YdGEoSg_DL3UxlJA',
      'Authorization', 'Bearer sb_publishable_np2Ps_SprPC0hf9YdGEoSg_DL3UxlJA'
    ),
    timeout_milliseconds := 60000
  );
  return new;
end;
$$;

-- create or replace сохраняет гранты, но повторяем отзыв (конвенция 0023) — на случай пересборки.
revoke execute on function public.notify_admin_event() from public;
