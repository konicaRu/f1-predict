-- 0014_gridbot_user.sql — аккаунт GridBot (ИИ-игрок лиги), играет как обычный участник.
-- Прямая вставка в auth.users в обход штатного Supabase Auth signup — обоснованно и проверено
-- эмпирически (rolled-back транзакция, сессия 2026-07-24): единственная NOT NULL без дефолта
-- колонка — id; собственных триггеров на auth.users в этом проекте нет.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '8093e42f-cc5e-4c18-8aa8-2dfa50e972c1',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'gridbot@f1-predict.local', '',
  now(), '{"provider":"none","providers":[]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do nothing;

insert into public.users (id, display_name, is_admin) values
  ('8093e42f-cc5e-4c18-8aa8-2dfa50e972c1', 'GridBot', false)
on conflict (id) do nothing;
