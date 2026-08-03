-- 0021_telegram_links.sql — связь Telegram-аккаунта с Supabase-пользователем для входа через
-- Mini App (спека docs/superpowers/specs/2026-08-01-telegram-mini-app-design.md). Отдельно от
-- public.users: связь должна существовать ещё ДО того, как появляется строка в public.users (та
-- создаётся только после redeem_invite) — иначе повторное открытие Mini App человеком, который не
-- долистал онбординг, будет распознаваться заново как новый пользователь.
create table public.telegram_links (
  telegram_user_id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.telegram_links enable row level security;  -- без политик: доступ только из Edge Function (service-role)
