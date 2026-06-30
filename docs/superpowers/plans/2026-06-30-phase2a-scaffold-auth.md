# Фаза 2a — Каркас + Auth. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять React-фронтенд (Vite+TS) с входом по email+паролю и регистрацией по инвайт-коду (серверная проверка + членство), защищёнными роутами и оболочкой приложения.

**Architecture:** Статика (GitHub Pages) ↔ Supabase (облако), без зависимости от ПК в рантайме. Auth — `@supabase/supabase-js` напрямую. Закрытость лиги — серверная: миграция `0006` (`redeem_invite` + `is_member`), RLS чтения по членству. UI-стили портируются из прототипа `index.html`.

**Tech Stack:** Vite, React 18, TypeScript, react-router-dom, @supabase/supabase-js. Cloud-direct применение миграций — `scripts/db/runner.js`.

**Источник правды:** `docs/superpowers/specs/2026-06-30-phase2a-scaffold-auth-design.md`.

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| `supabase/migrations/0006_invite_membership.sql` | invite_codes, redeem_invite, is_member, RLS по членству |
| `scripts/db/membership.test.js` | pg-тест: не-член не видит данные, член видит |
| `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json` | каркас Vite+TS |
| `index.html` | Vite-entry (прототип → `docs/prototype.html`) |
| `.env.local` (не в git), `.env.example` | VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY |
| `src/main.tsx`, `src/App.tsx` | bootstrap + роутер |
| `src/lib/supabase.ts` | клиент Supabase |
| `src/auth/AuthContext.tsx`, `src/auth/ProtectedRoute.tsx` | сессия/членство/админ, защита роутов |
| `src/pages/Login.tsx`, `src/pages/Signup.tsx`, `src/pages/RedeemInvite.tsx` | экраны входа |
| `src/components/Shell.tsx` | шапка + навигация + выход |
| `src/styles/app.css` | портированный CSS прототипа |

---

## Task 1: Миграция 0006 + pg-тест членства (TDD)

**Files:**
- Create: `supabase/migrations/0006_invite_membership.sql`, `scripts/db/membership.test.js`

- [ ] **Step 1: Написать падающий тест** (`scripts/db/membership.test.js`)

Тест: auth-юзер БЕЗ профиля видит 0 строк `drivers`; С профилем — >0. Всё в транзакции с rollback.
(Структура — как `scripts/db/rls.test.js`: читает `.env`, ретраи, DO-блок.)

```js
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const U='44444444-4444-4444-4444-444444444444';
const SQL=`
begin;
set local statement_timeout='25s';
do $$
declare non_member int; member int;
begin
  insert into auth.users(id,email) values('${U}','member-test@t.io');
  -- как authenticated БЕЗ профиля
  perform set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into non_member from drivers;
  execute 'reset role';
  -- создаём профиль (членство) и снова читаем как authenticated
  insert into public.users(id,display_name) values('${U}','Member');
  perform set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into member from drivers;
  execute 'reset role';
  create temp table _m(non_member int, member int) on commit drop;
  insert into _m values(non_member, member);
end $$;
select non_member, member from _m;
rollback;`;
function pick(r){const a=Array.isArray(r)?r:[r];const x=a.reverse().find(y=>y.rows&&y.rows.length);return x?x.rows:[];}
async function killOrphans(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false}});c.on('error',()=>{});try{await c.connect();await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}finally{try{await c.end();}catch(_){}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function once(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});c.on('error',()=>{});await c.connect();try{return pick(await c.query(SQL));}finally{try{await c.end();}catch(_){}}}
(async()=>{let rows;for(let a=1;a<=5;a++){try{rows=await once();break;}catch(e){console.error(`attempt ${a}/5: ${e.message}`);if(a===5){process.exit(1);}await killOrphans();await sleep(2000*a);}}
  const r=rows[0];const ok=Number(r.non_member)===0 && Number(r.member)>0;
  console.log(`${ok?'PASS':'FAIL'}  не-член видит ${r.non_member} (ждали 0), член видит ${r.member} (>0)`);
  process.exit(ok?0:1);
})();
```

- [ ] **Step 2: Запустить — упадёт** (членства ещё нет, `is_member` не существует)

Run: `cd scripts/db && node membership.test.js`
Expected: FAIL — функция/гейтинг отсутствуют, не-член видит все 22 (или ошибка).

- [ ] **Step 3: Миграция** (`supabase/migrations/0006_invite_membership.sql`)

```sql
-- 0006_invite_membership.sql — регистрация по инвайт-коду + членство.
create table public.invite_codes (
  code text primary key, active boolean not null default true, note text,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;  -- без политик: обычным юзерам недоступна

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists(select 1 from public.users where id = auth.uid()) $$;

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

grant execute on function public.is_member() to authenticated;
grant execute on function public.redeem_invite(text,text) to authenticated;

-- закрыть чтение данных лиги по членству (было using(true))
alter policy users_select   on public.users            using (public.is_member());
alter policy drivers_select on public.drivers          using (public.is_member());
alter policy races_select   on public.races            using (public.is_member());
alter policy pool_select    on public.race_driver_pool using (public.is_member());
alter policy results_select on public.results          using (public.is_member());
alter policy rc_select      on public.result_changes   using (public.is_member());
```

- [ ] **Step 4: Применить к облаку (без wipe)**

Run: `cd scripts/db && node runner.js applyfile "$(cd ../../ && pwd)/supabase/migrations/0006_invite_membership.sql"`
Expected: `applied: 0006_invite_membership.sql (N stmts)`.

- [ ] **Step 5: Тест членства — PASS, и регрессия Фазы 0**

Run: `cd scripts/db && node membership.test.js && node rls.test.js`
Expected: membership PASS (не-член 0, член >0); `rls.test.js` всё ещё 7/7 (член A видит данные).

- [ ] **Step 6: Бутстрап — стартовый инвайт-код**

Run: `cd scripts/db && node runner.js sql "insert into invite_codes(code,note) values('F1-2026-LEAGUE','стартовый') on conflict (code) do nothing returning code"`
Expected: строка `F1-2026-LEAGUE` (или пусто, если уже есть). Этот код раздаёшь друзьям; сменить можно позже.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0006_invite_membership.sql scripts/db/membership.test.js
git commit -m "feat(phase2a): миграция 0006 (invite/membership) + pg-тест членства"
```

---

## Task 2: Каркас Vite + React + TS

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`
- Modify/Move: `index.html` (прототип → `docs/prototype.html`)

- [ ] **Step 1: Сохранить прототип и сделать Vite-entry index.html**

```bash
git mv index.html docs/prototype.html
```
Создать новый `index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>F1 Predict</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: package.json (корневой)**

```json
{
  "name": "f1-predict",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 3: vite.config.ts / tsconfig**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: '/f1-predict/',            // GitHub Pages
  plugins: [react()],
});
```
`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020", "useDefineForClassFields": true, "lib": ["ES2020","DOM","DOM.Iterable"],
    "module": "ESNext", "skipLibCheck": true, "moduleResolution": "bundler",
    "resolveJsonModule": true, "isolatedModules": true, "noEmit": true, "jsx": "react-jsx",
    "strict": true, "noUnusedLocals": true, "noUnusedParameters": true, "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```
`tsconfig.node.json`:
```json
{ "compilerOptions": { "composite": true, "skipLibCheck": true, "module": "ESNext", "moduleResolution": "bundler", "allowSyntheticDefaultImports": true }, "include": ["vite.config.ts"] }
```

- [ ] **Step 4: src/main.tsx, App.tsx, vite-env**

`src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_SUPABASE_URL: string; readonly VITE_SUPABASE_ANON_KEY: string; }
interface ImportMeta { readonly env: ImportMetaEnv; }
```
`src/App.tsx` (минимальный — расширим в Task 5):
```tsx
export default function App() {
  return <div style={{padding:24,color:'#fff'}}>F1 Predict — каркас работает</div>;
}
```
`src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

- [ ] **Step 5: Обновить .gitignore (node_modules, dist, .env.local)**

Добавить в корневой `.gitignore` (если ещё нет):
```
dist/
.env.local
```
(node_modules уже игнорируется.)

- [ ] **Step 6: Установка и сборка**

Run: `npm install && npm run build`
Expected: `tsc` без ошибок, `vite build` создаёт `dist/`. (dev-сервер проверим в Task 7.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json tsconfig.node.json index.html docs/prototype.html src/main.tsx src/App.tsx src/vite-env.d.ts .gitignore
git commit -m "feat(phase2a): каркас Vite+React+TS (прототип -> docs/prototype.html)"
```

---

## Task 3: Клиент Supabase + .env

**Files:**
- Create: `src/lib/supabase.ts`
- Modify: `.env.example`; Create: `.env.local` (не в git)

- [ ] **Step 1: src/lib/supabase.ts**

```ts
import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY не заданы (.env.local)');
export const supabase = createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } });
```

- [ ] **Step 2: .env.example — добавить VITE-переменные**

Дописать в `.env.example`:
```
# Фронтенд (Vite). anon/publishable-ключ публичен. Реальные — в .env.local (НЕ в git).
VITE_SUPABASE_URL=https://kolrwuhjjsclqalapfzt.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-ключ из Dashboard -> Settings -> API Keys>
```

- [ ] **Step 3 (ПОЛЬЗОВАТЕЛЬ): создать .env.local**

Создать `.env.local` в корне:
```
VITE_SUPABASE_URL=https://kolrwuhjjsclqalapfzt.supabase.co
VITE_SUPABASE_ANON_KEY=<вставь publishable-ключ sb_publishable_... из дашборда>
```
Проверка: `git check-ignore .env.local` → должно вернуть `.env.local` (игнорируется).

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase.ts .env.example
git commit -m "feat(phase2a): клиент Supabase + VITE-переменные в .env.example"
```

---

## Task 4: AuthContext + ProtectedRoute

**Files:**
- Create: `src/auth/AuthContext.tsx`, `src/auth/ProtectedRoute.tsx`

- [ ] **Step 1: src/auth/AuthContext.tsx**

```tsx
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type AuthState = {
  session: Session | null;
  loading: boolean;
  isMember: boolean;
  isAdmin: boolean;
  refreshMembership: () => Promise<void>;
  signOut: () => Promise<void>;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMember, setIsMember] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  async function loadMembership(s: Session | null) {
    if (!s) { setIsMember(false); setIsAdmin(false); return; }
    const { data } = await supabase.from('users').select('is_admin').eq('id', s.user.id).maybeSingle();
    setIsMember(!!data);
    setIsAdmin(!!data?.is_admin);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session); await loadMembership(data.session); setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s); await loadMembership(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    session, loading, isMember, isAdmin,
    refreshMembership: () => loadMembership(session),
    signOut: async () => { await supabase.auth.signOut(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth вне AuthProvider');
  return v;
}
```

- [ ] **Step 2: src/auth/ProtectedRoute.tsx**

```tsx
import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, isMember, loading } = useAuth();
  if (loading) return <div style={{padding:24,color:'#fff'}}>Загрузка…</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (!isMember) return <Navigate to="/redeem" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 3: Сборка проходит**

Run: `npm run build`
Expected: tsc без ошибок (компоненты типизированы).

- [ ] **Step 4: Commit**

```bash
git add src/auth/AuthContext.tsx src/auth/ProtectedRoute.tsx
git commit -m "feat(phase2a): AuthContext (сессия/членство/админ) + ProtectedRoute"
```

---

## Task 5: Экраны Login / Signup / RedeemInvite

**Files:**
- Create: `src/pages/Login.tsx`, `src/pages/Signup.tsx`, `src/pages/RedeemInvite.tsx`

- [ ] **Step 1: src/pages/Login.tsx**

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

export default function Login() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const nav = useNavigate(); const { refreshMembership } = useAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refreshMembership(); nav('/');
  }
  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Вход</h1>
      <input type="email" placeholder="email" value={email} onChange={e=>setEmail(e.target.value)} required />
      <input type="password" placeholder="пароль" value={password} onChange={e=>setPassword(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy?'…':'Войти'}</button>
      <p>Нет аккаунта? <Link to="/signup">Регистрация</Link></p>
    </form>
  );
}
```

- [ ] **Step 2: src/pages/Signup.tsx**

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

export default function Signup() {
  const [email,setEmail]=useState(''); const [password,setPassword]=useState('');
  const [name,setName]=useState(''); const [code,setCode]=useState('');
  const [err,setErr]=useState(''); const [busy,setBusy]=useState(false);
  const nav=useNavigate(); const { refreshMembership }=useAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    const { error: e1 } = await supabase.auth.signUp({ email, password });
    if (e1) { setBusy(false); setErr(e1.message); return; }
    const { error: e2 } = await supabase.rpc('redeem_invite', { p_code: code, p_display_name: name });
    setBusy(false);
    if (e2) { setErr('Код неверный или регистрация не завершена: ' + e2.message); return; }
    await refreshMembership(); nav('/');
  }
  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Регистрация</h1>
      <input placeholder="имя в лиге" value={name} onChange={e=>setName(e.target.value)} required />
      <input type="email" placeholder="email" value={email} onChange={e=>setEmail(e.target.value)} required />
      <input type="password" placeholder="пароль (мин. 6)" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} />
      <input placeholder="инвайт-код лиги" value={code} onChange={e=>setCode(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy?'…':'Создать аккаунт'}</button>
      <p>Уже есть аккаунт? <Link to="/login">Вход</Link></p>
    </form>
  );
}
```

- [ ] **Step 3: src/pages/RedeemInvite.tsx** (вошёл, но профиля нет)

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

export default function RedeemInvite() {
  const [name,setName]=useState(''); const [code,setCode]=useState('');
  const [err,setErr]=useState(''); const [busy,setBusy]=useState(false);
  const nav=useNavigate(); const { refreshMembership, signOut }=useAuth();

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    const { error } = await supabase.rpc('redeem_invite', { p_code: code, p_display_name: name });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refreshMembership(); nav('/');
  }
  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Вступление в лигу</h1>
      <p>Аккаунт есть, но ты ещё не в лиге — введи инвайт-код.</p>
      <input placeholder="имя в лиге" value={name} onChange={e=>setName(e.target.value)} required />
      <input placeholder="инвайт-код" value={code} onChange={e=>setCode(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy?'…':'Вступить'}</button>
      <p><a href="#" onClick={()=>signOut()}>Выйти</a></p>
    </form>
  );
}
```

- [ ] **Step 4: Сборка**

Run: `npm run build`
Expected: tsc без ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Login.tsx src/pages/Signup.tsx src/pages/RedeemInvite.tsx
git commit -m "feat(phase2a): экраны Login / Signup (инвайт) / RedeemInvite"
```

---

## Task 6: Shell + стили + роутер

**Files:**
- Create: `src/components/Shell.tsx`, `src/styles/app.css`
- Modify: `src/App.tsx`, `src/main.tsx`

- [ ] **Step 1: src/components/Shell.tsx** (шапка+навигация из прототипа §16.3–16.4)

```tsx
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const tabs = [
  { to: '/calendar', label: 'Календарь' },
  { to: '/predict', label: 'Прогноз' },
  { to: '/standings', label: 'Зачёт' },
  { to: '/results', label: 'Результаты' },
];
export default function Shell() {
  const { isAdmin, signOut } = useAuth();
  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-left">
          <span className="hdr-label">PRIVATE LEAGUE</span>
          <span className="hdr-title">F1 Predict</span>
          <span className="hdr-sub">Лига прогнозов · сезон 2026</span>
        </div>
        <button className="hdr-logout" onClick={()=>signOut()}>Выход</button>
      </header>
      <nav className="nav">
        {tabs.map(t => (
          <NavLink key={t.to} to={t.to} className={({isActive})=>'nav-tab'+(isActive?' active':'')}>{t.label}</NavLink>
        ))}
        {isAdmin && <NavLink to="/admin" className={({isActive})=>'nav-tab'+(isActive?' active':'')}>Админ</NavLink>}
      </nav>
      <main className="main"><Outlet /></main>
    </div>
  );
}
```

- [ ] **Step 2: src/styles/app.css** (база темы из прототипа `docs/prototype.html`)

Портировать ключевые стили темы (фон #0B0E14, акценты volt #00E5FF / hot #FF2E63, шрифты Saira Condensed+Inter)
и классы `hdr*`, `nav*`, `auth-card`, `auth-err`, `app`, `main`. Минимально достаточный CSS:

```css
@import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@700;800&family=Inter:wght@400;500;600&display=swap');
:root{ --bg:#0B0E14; --panel:#121826; --panel2:#1A2233; --line:#23304A; --volt:#00E5FF; --hot:#FF2E63; --txt:#E6EAF2; --muted:#8A93A6; }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font-family:Inter,system-ui,sans-serif}
.app{max-width:1100px;margin:0 auto;padding:16px}
.hdr{display:flex;justify-content:space-between;align-items:center;background:var(--panel);border-radius:14px;padding:14px 18px;border-left:4px solid var(--volt)}
.hdr-label{font-family:'Saira Condensed';color:var(--volt);text-transform:uppercase;letter-spacing:.08em;font-size:12px;display:block}
.hdr-title{font-family:'Saira Condensed';font-weight:800;font-size:24px;display:block}
.hdr-sub{color:var(--muted);font-size:12px}
.hdr-logout{background:transparent;border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 14px;cursor:pointer}
.nav{display:flex;gap:6px;background:var(--panel);border-radius:12px;padding:6px;margin:12px 0}
.nav-tab{font-family:'Saira Condensed';font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);text-decoration:none;padding:10px 14px;border-radius:9px}
.nav-tab.active{background:var(--panel2);color:#fff}
.main{margin-top:12px}
.auth-card{max-width:360px;margin:48px auto;display:flex;flex-direction:column;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px}
.auth-card h1{font-family:'Saira Condensed';font-weight:800;margin:0 0 8px}
.auth-card input{background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:11px 12px;font-size:14px}
.auth-card button{background:linear-gradient(90deg,var(--hot),#c01f4a);color:#fff;border:0;border-radius:9px;padding:12px;font-weight:600;cursor:pointer}
.auth-card button:disabled{opacity:.6;cursor:not-allowed}
.auth-err{color:var(--hot);font-size:13px;margin:0}
.stub{padding:32px;color:var(--muted);text-align:center;border:1px dashed var(--line);border-radius:12px}
```

- [ ] **Step 3: src/App.tsx — роутер с защитой**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import Shell from './components/Shell';
import Login from './pages/Login';
import Signup from './pages/Signup';
import RedeemInvite from './pages/RedeemInvite';

const Stub = ({ name }: { name: string }) => <div className="stub">Экран «{name}» — в следующих под-проектах</div>;

export default function App() {
  return (
    <BrowserRouter basename="/f1-predict">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/redeem" element={<RedeemInvite />} />
          <Route element={<ProtectedRoute><Shell /></ProtectedRoute>}>
            <Route index element={<Navigate to="/calendar" replace />} />
            <Route path="/calendar" element={<Stub name="Календарь" />} />
            <Route path="/predict" element={<Stub name="Прогноз" />} />
            <Route path="/standings" element={<Stub name="Зачёт" />} />
            <Route path="/results" element={<Stub name="Результаты" />} />
            <Route path="/admin" element={<Stub name="Админка" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: src/main.tsx — подключить стили**

Добавить импорт в начало `src/main.tsx`:
```tsx
import './styles/app.css';
```

- [ ] **Step 5: Сборка**

Run: `npm run build`
Expected: tsc+vite без ошибок.

- [ ] **Step 6: Commit**

```bash
git add src/components/Shell.tsx src/styles/app.css src/App.tsx src/main.tsx
git commit -m "feat(phase2a): Shell (шапка/навигация), стили темы, защищённый роутер"
```

---

## Task 7: E2E-смоук в браузере + бутстрап админа

**Files:** (нет новых; ручная проверка + бутстрап)

- [ ] **Step 1: Запустить dev-сервер**

Run: `npm run dev`
Expected: Vite печатает `Local: http://localhost:5173/f1-predict/`. Открыть в браузере.
(Требуется заполненный `.env.local` из Task 3 Step 3.)

- [ ] **Step 2: Смоук регистрации/входа (ручной)**

Проверить в браузере:
1. Аноним открывает `/calendar` → редирект на `/login`. ✅
2. Регистрация с **неверным** кодом (напр. `WRONG`) → ошибка под формой, в приложение НЕ пускает. ✅
3. Регистрация с верным кодом `F1-2026-LEAGUE`, именем и email → попал в Shell, видна навигация. ✅
4. Выход → снова логин. Вход тем же email/паролем → Shell. ✅
Зафиксировать результат (все 4 пункта проходят).

- [ ] **Step 3 (ПОЛЬЗОВАТЕЛЬ/dev): сделать твой аккаунт админом**

После регистрации твоего аккаунта:
Run: `cd scripts/db && node runner.js sql "update public.users set is_admin=true where id=(select id from auth.users where email='prokol35@gmail.com') returning display_name, is_admin"`
Expected: строка с `is_admin=true`. После релогина в навигации появится вкладка «Админ».

- [ ] **Step 4: Commit (если были правки по итогам смоука)**

```bash
git commit -am "test(phase2a): e2e-смоук auth пройден; бутстрап админа" --allow-empty
```

---

## Task 8: README + git save

**Files:**
- Create: `docs/frontend.md`
- Modify: `MEMORY.md`, `ARCHITECTURE.md`

- [ ] **Step 1: docs/frontend.md**

```markdown
# Фронтенд (Vite + React + TS)

## Запуск
- `npm install` (в корне), заполнить `.env.local` (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
- `npm run dev` — dev-сервер (`/f1-predict/`). `npm run build` — прод-сборка в `dist/`.

## Auth
- Регистрация по инвайт-коду (`redeem_invite` на сервере) → профиль `public.users` → членство.
- Чтение данных лиги закрыто RLS по `is_member()`. Первый админ — через `scripts/db` (см. план 2a).

Прототип-референс стилей — `docs/prototype.html`.
```

- [ ] **Step 2: Обновить MEMORY.md (статус + лог) и ARCHITECTURE.md (структура+changelog)**

MEMORY «Статус»: 2a сделана (каркас+auth, инвайт/членство, миграция 0006). «Лог»: запись 2026-06-30 про 2a.
ARCHITECTURE: добавить фронтенд-структуру `src/`, команды `npm run dev/build`, changelog 2a.

- [ ] **Step 3: Commit (git save)**

```bash
git add docs/frontend.md MEMORY.md ARCHITECTURE.md
git commit -m "docs(phase2a): frontend.md + git save (каркас+auth готовы)"
```

---

## Самопроверка плана (выполнена)

- **Покрытие спеки:** §1 стек→T2/T3; §2 миграция 0006→T1; §3 auth-флоу→T4(контекст)/T5(экраны)/T6(роутер); §4 админ→T7; §5 критерий→ membership-тест (T1) + сборка (T2,4,5,6) + e2e-смоук (T7). Констрейнт «без ПК»: фронт статика + Supabase, ничего локального в рантайме — соблюдён.
- **Плейсхолдеров нет:** весь код/SQL/конфиги конкретные.
- **Согласованность:** `useAuth()` (session/isMember/isAdmin/refreshMembership/signOut) определён в T4 и используется в T5/T6; `redeem_invite(p_code,p_display_name)` и `is_member()` из T1 вызываются в T5; имена классов CSS (T6) совпадают с разметкой Shell/экранов.

**Риски исполнителю:** (1) `.env.local` должен быть заполнен до `npm run dev` (Task 3 Step 3 — действие пользователя); (2) Supabase «Confirm email» должно быть выkey (Dashboard → Auth → Providers → Email → выключить «Confirm email»), иначе `signUp` не даст сессию сразу — добавить как первый шаг смоука/настройки; (3) e2e-смоук ручной (браузер) — не автоматизирован.
