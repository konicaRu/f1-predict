-- 0023_admin_notify.sql — событийные admin-уведомления в Telegram (спека
-- docs/superpowers/specs/2026-08-05-admin-notify-design.md). AFTER-триггеры на регистрацию/
-- прогноз/результат асинхронно (pg_net, без блокировки записи) шлют событие в Edge Function
-- admin-notify, которая решает — слать сразу в Telegram или положить в очередь на утро.
create extension if not exists pg_net;

create table public.admin_notification_queue (
  id bigint generated always as identity primary key,
  text text not null,
  created_at timestamptz not null default now()
);
alter table public.admin_notification_queue enable row level security;  -- без политик: только service-role
revoke all on public.admin_notification_queue from anon, authenticated;

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
    )
  );
  return new;
end;
$$;

create trigger notify_admin_on_registration
  after insert on public.users
  for each row execute function public.notify_admin_event();

create trigger notify_admin_on_prediction
  after insert on public.predictions
  for each row execute function public.notify_admin_event();

create trigger notify_admin_on_result
  after insert or update on public.results
  for each row execute function public.notify_admin_event();
