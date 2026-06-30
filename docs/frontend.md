# Фронтенд (Vite + React + TS)

## Запуск
- `npm install` (в корне), заполнить `.env.local`:
  ```
  VITE_SUPABASE_URL=https://kolrwuhjjsclqalapfzt.supabase.co
  VITE_SUPABASE_ANON_KEY=<publishable-ключ sb_publishable_... из Dashboard → Settings → API Keys>
  ```
- `npm run dev` — dev-сервер (`/f1-predict/`). При коллизии портов: `npm run dev -- --host`.
- `npm run build` — прод-сборка в `dist/`.

## Auth (под-проект 2a)
- Регистрация по **инвайт-коду**: `signUp` → RPC `redeem_invite(p_code, p_display_name)` создаёт профиль
  `public.users` только при валидном активном коде → членство. Email-подтверждение в Supabase **выключено**;
  регистрация по email должна быть **включена** (Authentication → Providers → Email).
- Чтение данных лиги закрыто RLS по `is_member()` (миграция 0006): auth-юзер без профиля не видит ничего.
- Первый админ ставится разово: `scripts/db/runner.js sql "update public.users set is_admin=true where id=(select id from auth.users where email='...')"`.
- Стартовый инвайт-код: `F1-2026-LEAGUE` (в таблице `invite_codes`, меняется админом).

## Структура
- `src/lib/supabase.ts` — клиент. `src/auth/` — AuthContext + ProtectedRoute.
- `src/pages/` — Login / Signup / RedeemInvite. `src/components/Shell.tsx` — шапка+навигация.
- `src/styles/app.css` — тёмная F1-тема. Прототип-референс — `docs/prototype.html`.
- Экраны Календарь/Прогноз/Зачёт/Результаты/Админ — пока заглушки (под-проекты 2b/2c/Фаза 3).

## Деплой
- Цель — GitHub Pages (`base: '/f1-predict/'` в vite.config). Боевой деплой — Фаза 6.
- Сервис работает без ПК разработчика: статика (Pages) + Supabase (облако).
