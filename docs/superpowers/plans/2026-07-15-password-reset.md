# Сброс пароля — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать участнику лиги восстановить доступ через штатный флоу Supabase Auth: ссылка «Забыли пароль?» на `/login` → письмо → `/reset` → новый пароль → автовход.

**Architecture:** Инлайн-форма на `Login.tsx` вызывает `supabase.auth.resetPasswordForEmail()`. Новый публичный маршрут `/reset` (`ResetPassword.tsx`) читает recovery-сессию, которую Supabase SDK сам поднимает из ссылки письма (`detectSessionInUrl` включён по умолчанию), и вызывает `supabase.auth.updateUser({password})`. Без бэкенд-кода — только фронт + ручная настройка Redirect URL в дэшборде Supabase.

**Tech Stack:** React + TS, `@supabase/supabase-js` (`resetPasswordForEmail`, `getSession`, `updateUser`), react-router-dom.

---

## Task 1: Инлайн-форма «Забыли пароль» на Login

**Files:**
- Modify: `src/pages/Login.tsx`

- [ ] **Step 1: Добавить состояние и обработчик**

Modify `src/pages/Login.tsx` — заменить весь файл на:

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const { refreshMembership } = useAuth();

  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    await refreshMembership();
    nav('/');
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotBusy(true);
    await supabase.auth.resetPasswordForEmail(forgotEmail, {
      redirectTo: `${window.location.origin}/f1-predict/reset`,
    });
    setForgotBusy(false);
    setForgotMsg('Если такой email зарегистрирован, письмо со ссылкой на сброс отправлено.');
  }

  if (forgotOpen) {
    return (
      <form onSubmit={submitForgot} className="auth-card">
        <h1>Забыли пароль?</h1>
        <input
          type="email"
          placeholder="email"
          value={forgotEmail}
          onChange={(e) => setForgotEmail(e.target.value)}
          required
        />
        {forgotMsg && <p>{forgotMsg}</p>}
        <button disabled={forgotBusy} type="submit">{forgotBusy ? '…' : 'Отправить ссылку'}</button>
        <p>
          <button type="button" className="link-btn" onClick={() => { setForgotOpen(false); setForgotMsg(''); }}>
            Назад ко входу
          </button>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Вход</h1>
      <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="пароль" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Войти'}</button>
      <p>
        <button type="button" className="link-btn" onClick={() => { setForgotOpen(true); setForgotEmail(email); }}>
          Забыли пароль?
        </button>
      </p>
      <p>Нет аккаунта? <Link to="/signup">Регистрация</Link></p>
    </form>
  );
}
```

Примечания:
- `forgotEmail` инициализируется значением уже введённого `email` при открытии формы (меньше перепечатывания).
- `redirectTo` собирается из `window.location.origin` + захардкоженный путь `/f1-predict/reset` (совпадает с `basename="/f1-predict"` в `App.tsx` и путём деплоя на GitHub Pages) — работает и на dev-сервере (`localhost:5173`), и в проде.
- Результат `resetPasswordForEmail` (успех/ошибка) сознательно игнорируется в ветвлении — единый текст всегда, чтобы не выдавать существование email (спека §5).

- [ ] **Step 2: Собрать проект**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Login.tsx
git commit -m "feat(reset): инлайн-форма «забыли пароль» на Login"
```

## Context (Task 1)
- `.link-btn` и `.auth-card`/`.auth-err` — уже существующие классы (`src/styles/app.css:29-36`), новых стилей не требуется.
- `useAuth().refreshMembership` не нужен в forgot-ветке — сессия там не создаётся (только письмо отправляется).

---

## Task 2: Экран `/reset` — установка нового пароля

**Files:**
- Create: `src/pages/ResetPassword.tsx`

- [ ] **Step 1: Создать экран**

Create `src/pages/ResetPassword.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function ResetPassword() {
  const [status, setStatus] = useState<'checking' | 'ready' | 'invalid'>('checking');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setStatus(data.session ? 'ready' : 'invalid');
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (password !== password2) {
      setErr('Пароли не совпадают');
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    nav('/calendar');
  }

  if (status === 'checking') return <div className="stub">Загрузка…</div>;

  if (status === 'invalid')
    return (
      <div className="auth-card">
        <h1>Ссылка недействительна</h1>
        <p>Ссылка для сброса пароля недействительна или уже была использована.</p>
        <p><Link to="/login">Ко входу</Link></p>
      </div>
    );

  return (
    <form onSubmit={submit} className="auth-card">
      <h1>Новый пароль</h1>
      <input
        type="password"
        placeholder="новый пароль"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="повторите пароль"
        value={password2}
        onChange={(e) => setPassword2(e.target.value)}
        required
      />
      {err && <p className="auth-err">{err}</p>}
      <button disabled={busy} type="submit">{busy ? '…' : 'Сохранить пароль'}</button>
    </form>
  );
}
```

Примечания:
- `getSession()` (не `getUser()`) — именно локальная recovery-сессия, которую SDK поднял из URL-фрагмента
  письма при загрузке страницы; сетевого запроса к Supabase почти не требует.
- Совпадение паролей проверяется на клиенте до отправки — сообщение через тот же `.auth-err`, что и
  остальные формы проекта.
- После `updateUser` recovery-сессия становится обычной сессией — `AuthProvider` подхватит её через уже
  существующий `onAuthStateChange` (без дополнительного кода), поэтому редирект на `/calendar` сразу
  попадёт в залогиненное состояние.

- [ ] **Step 2: Собрать проект**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/pages/ResetPassword.tsx
git commit -m "feat(reset): экран /reset — установка нового пароля по recovery-ссылке"
```

## Context (Task 2)
- `.stub` класс — уже существует (`src/styles/app.css:38`), используется для состояния загрузки.
- Маршрут для этого экрана подключается в Task 3.

---

## Task 3: Маршрут `/reset` в App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Добавить импорт и публичный маршрут**

Modify `src/App.tsx`:

(a) Добавить импорт после `import RedeemInvite from './pages/RedeemInvite';`:

```tsx
import ResetPassword from './pages/ResetPassword';
```

(b) Добавить маршрут после `<Route path="/redeem" element={<RedeemInvite />} />` (ВНЕ `ProtectedRoute`,
рядом с остальными публичными маршрутами):

```tsx
          <Route path="/reset" element={<ResetPassword />} />
```

Итоговый порядок публичных маршрутов должен быть:

```tsx
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/redeem" element={<RedeemInvite />} />
          <Route path="/reset" element={<ResetPassword />} />
```

- [ ] **Step 2: Собрать проект**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(reset): маршрут /reset подключён"
```

## Context (Task 3)
- `/reset` — публичный маршрут (не под `ProtectedRoute`) по той же причине, что `/login`/`/signup`/`/redeem`:
  обычной auth-сессии здесь ещё нет, только специальная recovery-сессия.

---

## Task 4: Ручная настройка Supabase + деплой

Этот таск не про код — про конфигурацию внешнего сервиса и финальную выкладку. Выполняется после того,
как Task 1-3 смержены (или на той же ветке перед мержем — не блокирует код-ревью).

- [ ] **Step 1: Redirect URL в Supabase**

В дэшборде Supabase (Authentication → URL Configuration → Redirect URLs) добавить:
```
https://konicaru.github.io/f1-predict/reset
```
Site URL сверить — должен уже указывать на `https://konicaru.github.io/f1-predict` (настроено в Фазе 2b
при деплое; если не так — поправить на месте).

Это ручной шаг в веб-интерфейсе — не автоматизируется скриптом (в отличие от миграций через
`scripts/db/runner.js`, у Supabase Auth-настроек нет прямого SQL/RPC доступа с anon-ключом).

- [ ] **Step 2: Финальная сборка**

Run: `npm run build`
Expected: без ошибок (уже проверялось в Task 1-3, финальная проверка на объединённом состоянии).

## Context (Task 4)
- Без этого шага письмо со ссылкой будет вести на URL, который Supabase отклонит как невалидный redirect
  (Auth блокирует redirect на домены/пути, не занесённые в allow-list) — фронт-код без этого не заработает.
- Проверка вживую (реальная отправка письма и переход по ссылке) — по договорённости с пользователем,
  делается на бою после деплоя, не как часть этого плана.

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:**
- §5 Login инлайн-форма → Task 1.
- §6 экран `/reset` (валидная/невалидная сессия, смена пароля, автовход) → Task 2.
- §4 маршрут → Task 3.
- §4 Supabase Redirect URL → Task 4.
- §7 тестирование — по договорённости с пользователем перенесено на «проверку на бою» после деплоя,
  не выполняется как часть этого плана субагентами (нет доступа к реальному email/ссылке из письма).
- §8 «вне скоупа» — ничего из этого списка в план не попало (свой SMTP, rate-limit UI, аудит-журнал).

**Плейсхолдеры:** нет — весь код приведён целиком.

**Согласованность типов:** `ResetPassword.tsx` использует `supabase.auth.getSession()`/`updateUser()`
из уже существующего клиента `src/lib/supabase.ts` (без изменений сигнатур); `Login.tsx` использует
`resetPasswordForEmail()` — все три метода стандартные из `@supabase/supabase-js`, сигнатуры не
переопределяются нигде в проекте.
