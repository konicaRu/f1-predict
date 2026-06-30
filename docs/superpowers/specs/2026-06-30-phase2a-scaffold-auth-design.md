# Фаза 2a — Каркас + Auth. Дизайн

**Дата:** 2026-06-30
**Источник правды:** `docs/plan.md` (§2 авторизация, §6 RLS, §7 экраны, §16 дизайн).
**Предусловие:** Фазы 0–1 закрыты (схема+RLS+данные в облаке `konicaRu_f1`, cloud-direct, transaction-пулер :6543).

**Контекст:** Фаза 2 декомпозирована на под-проекты: **2a Каркас+Auth → 2b Календарь+Прогноз → 2c Админка →
backup-Sheets**. Это спека первого — **2a**.

**Цель 2a:** поднять React-фронтенд (Vite+TS), подключить Supabase, сделать вход по email+паролю с
регистрацией **по инвайт-коду** (серверная проверка + членство), защищённые роуты и оболочку приложения.

**Критерий готовности:** сборка/запуск без ошибок; auth e2e в браузере (регистрация по коду → профиль →
shell; невалидный код → отказ; вход/выход; ProtectedRoute); серверное членство (authenticated без профиля
не видит данные лиги); бутстрап (твой аккаунт админ + 1 активный инвайт-код).

---

## Решения сессии

| # | Вопрос | Решение |
|---|---|---|
| S1 | Регистрация | **По инвайт-коду**, проверяется на сервере (вариант A) |
| S2 | Enforcement | Серверный: `redeem_invite` + членство `is_member()`; RLS чтения по членству |
| S3 | Email-подтверждение | **Off** (closed-лига, меньше трения; `signUp` сразу даёт сессию) |
| S4 | Язык | **TypeScript** |
| S5 | Стек | Vite + React 18 + react-router + `@supabase/supabase-js` |
| S6 | Стили | Портировать CSS прототипа `index.html` (тёмная F1-тема), без Tailwind |
| S7 | Независимость от ПК | Сервис = GitHub Pages (статика) + Supabase (облако); ПК только для dev/деплоя |

## Независимость от ПК разработчика (констрейнт)

Сервис обязан работать без включённого компа разработчика:
- Фронтенд — статика на GitHub Pages (CDN). Бэкенд — Supabase (облако). Auth/прогнозы/чтение/`redeem_invite` —
  браузер↔облако напрямую. Занос результата (2c) — через веб-админку, не через скрипты с ПК.
- ПК нужен лишь для разработки и деплоя; ручной импорт/бэкап — временно, автоматизируется в Фазе 4.
- keep-alive (Фаза 0) не даёт облаку уснуть. В 2a ничего не должно требовать локального процесса в рантайме.

## 1. Стек и структура

```
f1-predict/
├── index.html              ← Vite entry (прототип сохраняем как референс стилей: docs/prototype.html)
├── package.json            ← корневой: Vite + React + TS
├── vite.config.ts          ← base: '/f1-predict/' (GitHub Pages)
├── tsconfig.json
├── .env.local              ← VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (публичны, НЕ в git)
├── .env.example            ← обновить: добавить VITE_*-переменные
└── src/
    ├── main.tsx, App.tsx           ← роутер
    ├── lib/supabase.ts             ← createClient(anon)
    ├── auth/AuthContext.tsx        ← session + isMember + isAdmin, onAuthStateChange
    ├── auth/ProtectedRoute.tsx
    ├── pages/Login.tsx
    ├── pages/Signup.tsx            ← email+пароль+display_name+инвайт-код
    ├── pages/RedeemInvite.tsx      ← если сессия есть, профиля нет
    ├── components/Shell.tsx        ← шапка + навигация + выход (из прототипа)
    └── styles/app.css              ← портированный CSS прототипа
```
- `index.html` прототип переносим в `docs/prototype.html` (референс), корневой `index.html` — Vite-entry.
- Деплой на GitHub Pages — настройку (Actions/`gh-pages`) добавим в 2a минимально (сборка проходит);
  боевой деплой — Фаза 6.

## 2. Миграция 0006 — инвайт + членство

```sql
-- 0006_invite_membership.sql
create table public.invite_codes (
  code text primary key, active boolean not null default true, note text,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;  -- без политик: обычным юзерам недоступна

-- членство = есть профиль в public.users
create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists(select 1 from public.users where id = auth.uid()) $$;

-- регистрация по коду: создаёт профиль ТОЛЬКО при валидном активном коде (обходит RLS как definer)
create or replace function public.redeem_invite(p_code text, p_display_name text)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(coalesce(trim(p_display_name),'')) = 0 then raise exception 'display_name required'; end if;
  if not exists(select 1 from public.invite_codes where code = p_code and active) then
    raise exception 'invalid invite code'; end if;
  insert into public.users(id, display_name) values (auth.uid(), trim(p_display_name))
    on conflict (id) do update set display_name = excluded.display_name;
end $$;

grant execute on function public.is_member(), public.redeem_invite(text,text) to authenticated;

-- закрыть чтение данных лиги по членству (было: using(true))
alter policy users_select            on public.users            using (public.is_member());
alter policy drivers_select          on public.drivers          using (public.is_member());
alter policy races_select            on public.races            using (public.is_member());
alter policy pool_select             on public.race_driver_pool using (public.is_member());
alter policy results_select          on public.results          using (public.is_member());
alter policy rc_select               on public.result_changes   using (public.is_member());
```
Применяется `scripts/db/runner.js applyfile` (без wipe). Примечание: `pred_select_*` не трогаем — владелец
прогноза по определению член; видимость чужих после дедлайна тоже подразумевает членство (читающий — член).

**Бутстрап-скрипт** (`scripts/db`, разовый dev): вставить 1 активный инвайт-код и после первой регистрации
выставить `is_admin=true` твоему аккаунту (по email из `auth.users`).

## 3. Auth-флоу

- **Регистрация:** форма → `supabase.auth.signUp({email,password})` → `supabase.rpc('redeem_invite',{p_code,p_display_name})`.
  Успех → членство, редирект в Shell. Ошибка кода → сообщение под формой; auth-юзер без профиля безвреден.
- **Вход:** `signInWithPassword` → проверка членства (`rpc('is_member')`); нет профиля → экран RedeemInvite.
- **ProtectedRoute:** требует сессию И членство, иначе → `/login`.
- **AuthContext:** `session`, `loading`, `isMember`, `isAdmin` (читается из `users` своей строки). Подписка
  `onAuthStateChange`; при логауте чистит состояние.
- **Shell:** шапка PRIVATE LEAGUE / F1 Predict (стили прототипа §16.3), навигация Календарь/Прогноз/Зачёт/
  Результаты (вкладки-заглушки, наполняются в 2b/3), кнопка «Выход».

## 4. Админ и бутстрап

- `is_admin` уже в схеме (default false). Первый админ — твой аккаунт, ставится разово бутстрап-скриптом
  по email. Управление инвайт-кодами и промоут юзеров — экран админки **2c**.
- В 2a приложение лишь читает свой `is_admin` (для будущей админ-вкладки).

## 5. Проверка (критерий готовности 2a)

- **Сборка:** `npm install`, `npm run build` (tsc+vite) и `npm run dev` — без ошибок.
- **Auth e2e (ручной смоук в браузере):** регистрация с валидным кодом → профиль → Shell; невалидный код →
  отказ, в Shell не пускает; вход существующим; выход; прямой переход на защищённый роут анонимом → на логин.
- **Членство на сервере (pg-тест нашим харнессом, транзакция+rollback):** создать auth-юзера без профиля,
  `set role authenticated` + claims → `select count(*) from drivers` = 0; затем создать профиль → > 0.
  (Добавить как `scripts/db/membership.test.js`.)
- **Бутстрап:** в облаке 1 активный `invite_codes`, твой `users.is_admin = true`.

## Вне скоупа 2a (следующие под-проекты)
- Экраны календаря и прогноза (drag-and-drop, снимок пула, серверная проверка дедлайна) — **2b**.
- Админка (ручной ввод топ-10, управление кодами, пометка scored) — **2c**.
- Витрина результатов и зачёта — Фаза 3. Бэкап в Google Sheets — после 2c.
- Боевой деплой на GitHub Pages — Фаза 6 (в 2a только проверяем, что сборка идёт).
