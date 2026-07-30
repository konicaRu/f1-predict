# Гостевой read-only доступ без регистрации — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать гостям (без регистрации и без аккаунта) read-only доступ к Календарю, Результатам,
Общему зачёту и Правилам реальной лиги — под кил-свитчем, который включает/выключает админ.

**Architecture:** Третий уровень доступа поверх существующих двух (`anon`=ничего,
`member`=всё через `is_member()`) — новые RLS-политики для роли `anon` на `races/drivers/
results/predictions(после дедлайна)/users(только id+display_name)`, гейтятся функцией
`guest_access_enabled()` (читает булев флаг из новой таблицы `app_settings`). View `scores` уже
`security_invoker=true` (`0002_scoring.sql`) — уважает RLS `predictions`/`results` вызывающей
роли, отдельная политика не нужна, только `grant select`. На фронтенде — отдельный маршрут
`/g/*` с гостевым Shell'ом; корень сайта (`/`) сам решает, куда вести, по наличию сессии.
Существующие защищённые маршруты `/calendar`, `/predict`, `/admin` и т.д. не меняются вообще.

**Tech Stack:** Postgres RLS (Supabase), React Router (новый вложенный роут `/g`), существующие
`src/lib/db.ts`-хелперы.

---

### Task 1: Миграция 0016 — кил-свитч + RLS-политики для `anon`

**Files:**
- Create: `supabase/migrations/0016_guest_access.sql`

- [ ] **Step 1: Написать миграцию**

```sql
-- 0016_guest_access.sql — гостевой read-only доступ без регистрации (спека
-- docs/superpowers/specs/2026-07-27-guest-read-access-design.md). Третий уровень доступа
-- поверх anon(ничего)/member(всё): анонимное чтение подмножества данных, только пока включён
-- кил-свитч. Существующие политики authenticated/is_member() не трогаем.

-- Кил-свитч: одна строка настроек, дефолт OFF (fail closed — включает явно админ).
create table public.app_settings (
  key   text primary key,
  value boolean not null
);
alter table public.app_settings enable row level security;  -- без политик: доступ только через функции ниже
insert into public.app_settings (key, value) values ('guest_access_enabled', false);

create or replace function public.guest_access_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_settings where key = 'guest_access_enabled'), false);
$$;

create or replace function public.set_guest_access(p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'set_guest_access: admin only';
  end if;
  update public.app_settings set value = p_enabled where key = 'guest_access_enabled';
end $$;

grant execute on function public.guest_access_enabled() to anon, authenticated;
grant execute on function public.set_guest_access(boolean) to authenticated;

-- Базовый доступ анониму (сейчас у anon нет вообще ничего — grant-база 0003_rls.sql).
grant usage on schema public to anon;

-- races/drivers/results — полностью, только пока включён свитч.
grant select on public.races, public.drivers, public.results to anon;
create policy races_select_guest   on public.races   for select to anon using (public.guest_access_enabled());
create policy drivers_select_guest on public.drivers for select to anon using (public.guest_access_enabled());
create policy results_select_guest on public.results for select to anon using (public.guest_access_enabled());

-- race_driver_pool сознательно НЕ открываем анониму — гостевые страницы (Календарь/Результаты/
-- Зачёт/Правила) его не используют; не выдаём права сверх реально нужного.

-- predictions — только после дедлайна гонки (тот же гейт по времени, что уже есть для authenticated).
grant select on public.predictions to anon;
create policy pred_select_guest on public.predictions
  for select to anon
  using (
    public.guest_access_enabled()
    and exists (select 1 from public.races r where r.id = race_id and now() > r.deadline_utc)
  );

-- users — только id+display_name анониму; telegram_username/telegram_user_id не публикуем никогда.
grant select (id, display_name) on public.users to anon;
create policy users_select_guest on public.users for select to anon using (public.guest_access_enabled());

-- scores — view с security_invoker=true (0002_scoring.sql), сама уважает RLS predictions/results
-- вызывающей роли -> достаточно грантнуть select на саму view, отдельная политика не нужна.
grant select on public.scores to anon;
```

- [ ] **Step 2: Применить к облаку**

```bash
cd scripts/db
node runner.js applyfile ../../supabase/migrations/0016_guest_access.sql
```
Expected: без ошибок, последняя строка вывода подтверждает применение файла.

- [ ] **Step 3: Быстрая ручная проверка**

```bash
node runner.js sql "select guest_access_enabled()"
```
Expected: `false` (дефолт).

- [ ] **Step 4: Коммит**

```bash
git add supabase/migrations/0016_guest_access.sql
git commit -m "feat(db): гостевой read-only доступ — кил-свитч + RLS-политики для anon"
```

---

### Task 2: Regression-тест `scripts/db/guest_access.test.js`

**Files:**
- Create: `scripts/db/guest_access.test.js`
- Modify: `scripts/db/package.json`

- [ ] **Step 1: Написать тест (rolled-back транзакция, по образцу `rls.test.js`/`security_grants.test.js`)**

```js
// Регресс-тест на 0016_guest_access: при выключенном свитче anon не видит ничего нового; при
// включённом — видит races/drivers/results/scores/users(id,display_name)/predictions только
// после дедлайна гонки, но НЕ до дедлайна и НЕ полные колонки users; anon нигде не может писать.
// Всё внутри begin...rollback, продакшн не меняется.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const A = '88888888-8888-8888-8888-888888888888';
const ADMIN = '99999999-9999-9999-9999-999999999999';
const R1 = 900000401; // open, дедлайн в будущем -> прогноз должен остаться скрыт даже при свитче ON
const R2 = 900000402; // resulted, дедлайн в прошлом -> прогноз виден при свитче ON
const perfect = JSON.stringify(Array.from({length:10},(_,i)=>`d${i+1}`));

function tryThrow(name, stmt){ return `
  begin ${stmt};
    names:=array_append(names,'${name}'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ упало');
  exception when others then
    names:=array_append(names,'${name}'); passed:=array_append(passed,true); infos:=array_append(infos,'отказ '||sqlstate);
  end;`;
}

const SQL = `
begin;
set local statement_timeout='25s';
do $$
declare n int; names text[]:='{}'; passed boolean[]:='{}'; infos text[]:='{}';
begin
  create temp table _guest(name text, passed boolean, info text) on commit drop;

  insert into drivers(id,code,name) select 'd'||g,'D'||g,'Drv'||g from generate_series(1,10) g;
  insert into auth.users(id,email) values('${A}','guest-a@t.io'),('${ADMIN}','guest-admin@t.io');
  insert into users(id,display_name,telegram_username,is_admin) values
    ('${A}','GuestTestUser','secret_tg_handle',false),
    ('${ADMIN}','GuestTestAdmin',null,true);
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R1},9401,'GuestOpen', now()+interval '2 days','open'),
    (${R2},9402,'GuestClosed', now()-interval '1 day','resulted');
  insert into race_driver_pool(race_id,driver_id)
    select r,'d'||g from (values(${R1}),(${R2})) v(r) cross join generate_series(1,10) g;
  insert into results(race_id,positions,status) values(${R2},'${perfect}'::jsonb,'final');
  insert into predictions(user_id,race_id,positions) values
    ('${A}',${R1},'${perfect}'::jsonb),('${A}',${R2},'${perfect}'::jsonb);

  -- ===== Свитч OFF =====
  update app_settings set value=false where key='guest_access_enabled';
  perform set_config('request.jwt.claims', null, true);
  execute 'set local role anon';

  select count(*) into n from races where id in (${R1},${R2});
  names:=array_append(names,'off: races hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from drivers where id in ('d1','d2','d3','d4','d5','d6','d7','d8','d9','d10');
  names:=array_append(names,'off: drivers hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from results where race_id=${R2};
  names:=array_append(names,'off: results hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from predictions where race_id=${R2};
  names:=array_append(names,'off: predictions hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from users where id='${A}';
  names:=array_append(names,'off: users hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from scores where race_id=${R2};
  names:=array_append(names,'off: scores hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);

  reset role;

  -- ===== Свитч ON =====
  update app_settings set value=true where key='guest_access_enabled';
  perform set_config('request.jwt.claims', null, true);
  execute 'set local role anon';

  select count(*) into n from races where id in (${R1},${R2});
  names:=array_append(names,'on: races visible'); passed:=array_append(passed,(n=2)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from drivers where id in ('d1','d2','d3','d4','d5','d6','d7','d8','d9','d10');
  names:=array_append(names,'on: drivers visible'); passed:=array_append(passed,(n=10)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from results where race_id=${R2};
  names:=array_append(names,'on: results visible'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from predictions where race_id=${R2} and user_id='${A}';
  names:=array_append(names,'on: predictions after deadline visible'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from predictions where race_id=${R1} and user_id='${A}';
  names:=array_append(names,'on: predictions before deadline still hidden'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from users where id='${A}';
  names:=array_append(names,'on: users id+display_name visible'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from scores where race_id=${R2} and user_id='${A}';
  names:=array_append(names,'on: scores after-deadline visible via view'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  select count(*) into n from scores where race_id=${R1} and user_id='${A}';
  names:=array_append(names,'on: scores before-deadline hidden via view'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно='||n);

  ${tryThrow('on: users telegram_username column blocked', `select telegram_username from users where id='${A}'`)}
  ${tryThrow('on: anon insert races blocked', `insert into races(round,name,deadline_utc) values(9999,'x',now())`)}
  ${tryThrow('on: anon insert predictions blocked', `insert into predictions(user_id,race_id,positions) values('${A}',${R2},'${perfect}'::jsonb)`)}
  ${tryThrow('on: anon update users blocked', `update users set display_name='hack' where id='${A}'`)}

  reset role;

  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin
    perform public.set_guest_access(false);
    names:=array_append(names,'set_guest_access: non-admin blocked'); passed:=array_append(passed,false); infos:=array_append(infos,'НЕ отклонено — выполнилось!');
  exception when others then
    names:=array_append(names,'set_guest_access: non-admin blocked');
    passed:=array_append(passed, sqlerrm like '%admin only%');
    infos:=array_append(infos, sqlerrm);
  end;
  reset role;

  perform set_config('request.jwt.claims','{"sub":"${ADMIN}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  begin
    perform public.set_guest_access(false);
    names:=array_append(names,'set_guest_access: admin succeeds'); passed:=array_append(passed,true); infos:=array_append(infos,'ok');
  exception when others then
    names:=array_append(names,'set_guest_access: admin succeeds'); passed:=array_append(passed,false); infos:=array_append(infos,sqlerrm);
  end;
  reset role;

  -- ===== Регрессия: участник по-прежнему видит свой прогноз до дедлайна =====
  update app_settings set value=true where key='guest_access_enabled';
  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';
  select count(*) into n from predictions where race_id=${R1} and user_id='${A}';
  names:=array_append(names,'regression: member still sees own pre-deadline prediction'); passed:=array_append(passed,(n=1)); infos:=array_append(infos,'видно='||n);
  reset role;

  insert into _guest select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _guest order by name;
rollback;
`;

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function pickRows(res){ const arr=Array.isArray(res)?res:[res]; const r=arr.reverse().find(x=>x.rows&&x.rows.length); return r?r.rows:[]; }
async function killOrphans(){
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000}); c.on('error',()=>{});
  try{await c.connect(); await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}
  finally{try{await c.end();}catch(_){}}
}
async function once(){
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true}); c.on('error',()=>{});
  await c.connect();
  try{ return pickRows(await c.query(SQL)); } finally{ try{await c.end();}catch(_){} }
}
(async()=>{
  let rows;
  for(let a=1;a<=6;a++){
    try{ rows=await once(); break; }
    catch(e){ console.error(`attempt ${a}/6: ${e.code||''} ${e.message}`); if(a===6){console.error('сдаюсь');process.exit(1);} await killOrphans(); await sleep(2000*a); }
  }
  let pass=0,fail=0;
  for(const r of rows){ const ok=r.passed===true; ok?pass++:fail++; console.log(`${ok?'PASS':'FAIL'}  ${r.name}  — ${r.info}`); }
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/21) ===`);
  process.exit(fail===0&&rows.length===21?0:1);
})();
```

- [ ] **Step 2: Добавить npm-скрипт**

В `scripts/db/package.json`, в блок `"scripts"`, добавить строку (после `"test:gridbot"`):
```json
    "test:guest_access": "node guest_access.test.js",
```

- [ ] **Step 3: Прогнать тест**

```bash
cd scripts/db
npm run test:guest_access
```
Expected: `=== ИТОГ: 21 PASS, 0 FAIL (строк 21/21) ===`, код выхода 0.

- [ ] **Step 4: Прогнать полную регрессию, что ничего старого не сломалось**

```bash
npm run test:rls
npm run test:security_grants
npm run test:predicted_user_ids
npm run test:gridbot
```
Expected: все зелёные, без изменений в поведении (новые anon-политики не должны задевать старые).

- [ ] **Step 5: Коммит**

```bash
git add scripts/db/guest_access.test.js scripts/db/package.json
git commit -m "test(db): regression-тест на гостевой read-only доступ (21/21 PASS)"
```

---

### Task 3: `src/lib/db.ts` — хелперы для кил-свитча

**Files:**
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Добавить функции в конец файла**

```ts
// ===== Гостевой доступ (read-only без аккаунта, Фаза 6) =====

export async function getGuestAccessEnabled(): Promise<boolean> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('guest_access_enabled');
    if (error) throw error;
    return data as boolean;
  });
}

// Без ретрая — мутирующий вызов, как setRaceResult (повтор при флапе не идемпотентен по смыслу UX).
export async function setGuestAccessEnabled(enabled: boolean): Promise<void> {
  const { error } = await withTimeout(
    (async () => supabase.rpc('set_guest_access', { p_enabled: enabled }))(),
    10000,
  );
  if (error) throw error;
}
```

- [ ] **Step 2: Проверить типы**

```bash
npx tsc -b --noEmit
```
Expected: без ошибок.

- [ ] **Step 3: Коммит**

```bash
git add src/lib/db.ts
git commit -m "feat(frontend): хелперы db.ts для гостевого кил-свитча"
```

---

### Task 4: Переключатель в Админке

**Files:**
- Modify: `src/pages/Admin.tsx`

- [ ] **Step 1: Добавить импорт**

Заменить строку:
```ts
import { listRaces, openRace } from '../lib/db';
```
на:
```ts
import { listRaces, openRace, getGuestAccessEnabled, setGuestAccessEnabled } from '../lib/db';
```

- [ ] **Step 2: Добавить состояние и загрузку**

После строки `const [busyId, setBusyId] = useState<number | null>(null);` добавить:
```ts
  const [guestOn, setGuestOn] = useState<boolean | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
```

Изменить `load`, добавив параллельную загрузку статуса свитча:
```ts
  const load = useCallback(async () => {
    setErr('');
    setRaces(null);
    try {
      const [rs, g] = await Promise.all([listRaces(), getGuestAccessEnabled()]);
      setRaces(rs);
      setGuestOn(g);
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    }
  }, []);
```

- [ ] **Step 3: Добавить обработчик переключения**

После функции `onOpen` добавить:
```ts
  async function onToggleGuest() {
    if (guestOn === null) return;
    setGuestBusy(true);
    setErr('');
    try {
      await setGuestAccessEnabled(!guestOn);
      setGuestOn(!guestOn);
    } catch (e: any) {
      setErr(e.message || 'Не удалось переключить гостевой доступ');
    } finally {
      setGuestBusy(false);
    }
  }
```

- [ ] **Step 4: Добавить блок в разметку**

После строки `{err && <p className="auth-err">{err}</p>}` добавить:
```tsx
      <div className="admin-row">
        <div className="admin-race">
          <span className="race-name">Гостевой доступ (read-only, без аккаунта)</span>
        </div>
        <div className="admin-actions">
          <button disabled={guestOn === null || guestBusy} onClick={onToggleGuest}>
            {guestBusy ? '…' : guestOn ? 'Выключить' : 'Включить'}
          </button>
          <span className="admin-badge">{guestOn === null ? '…' : guestOn ? 'включён' : 'выключен'}</span>
        </div>
      </div>
```

- [ ] **Step 5: Проверить типы и собрать**

```bash
npx tsc -b --noEmit
npm run build
```
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add src/pages/Admin.tsx
git commit -m "feat(admin): переключатель гостевого read-only доступа"
```

---

### Task 5: `GuestShell` — гостевой layout

**Files:**
- Create: `src/components/GuestShell.tsx`

- [ ] **Step 1: Создать компонент**

```tsx
import { NavLink, Link, Outlet } from 'react-router-dom';

const tabs = [
  { to: '/g/calendar', label: 'Календарь' },
  { to: '/g/standings', label: 'Зачёт' },
  { to: '/g/results', label: 'Результаты' },
  { to: '/g/rules', label: 'Правила' },
];

export default function GuestShell() {
  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-left">
          <span className="hdr-label">ГОСТЕВОЙ ПРОСМОТР</span>
          <span className="hdr-title">F1 Predict</span>
          <span className="hdr-sub">Лига прогнозов · сезон 2026</span>
        </div>
        <Link className="hdr-logout" to="/login">Войти</Link>
      </header>
      <nav className="nav">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
```

Переиспользует существующие CSS-классы `.app/.hdr/.hdr-left/.hdr-label/.hdr-title/.hdr-sub/
.hdr-logout/.nav/.nav-tab/.main` из `src/styles/app.css` — новых стилей не требуется.

- [ ] **Step 2: Коммит**

```bash
git add src/components/GuestShell.tsx
git commit -m "feat(frontend): GuestShell — layout гостевого просмотра"
```

---

### Task 6: `GuestCalendar` — гостевой календарь

**Files:**
- Create: `src/pages/GuestCalendar.tsx`

- [ ] **Step 1: Создать компонент**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { listRaces } from '../lib/db';
import type { Race } from '../lib/types';
import { RaceCard, classifyRace, type RaceView } from '../components/RaceCard';

export default function GuestCalendar() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    setRaces(null);
    try {
      setRaces(await listRaces());
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (err)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (!races) return <div className="stub">Загрузка…</div>;

  const byView = (v: RaceView | RaceView[]) => {
    const set = Array.isArray(v) ? v : [v];
    return races.filter((r) => set.includes(classifyRace(r)));
  };
  const open = byView('open');
  const soon = byView('soon');
  const past = byView(['locked', 'past']);

  const section = (title: string, list: Race[]) =>
    list.length > 0 && (
      <section className="cal-sec" key={title}>
        <h2 className="cal-h">{title}</h2>
        {list.map((r) => (
          <RaceCard key={r.id} race={r} hasPrediction={false} />
        ))}
      </section>
    );

  return (
    <div className="calendar">
      {section('Активные', open)}
      {section('Ближайшие', soon)}
      {section('Прошедшие', past)}
    </div>
  );
}
```

Без `onClick` карточки некликабельны (см. `RaceCard`: `onClick={clickable ? onClick : undefined}`) —
гость не попадает на `/predict`, которого для него не существует. Без «✓ прогноз» — концепция
«мой прогноз» гостю не применима, `hasPrediction` всегда `false`.

- [ ] **Step 2: Коммит**

```bash
git add src/pages/GuestCalendar.tsx
git commit -m "feat(frontend): GuestCalendar — календарь без учёта личного прогноза"
```

---

### Task 7: Роутинг — `/g/*` + сессия-зависимый корень

**Files:**
- Create: `src/auth/RootRedirect.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Создать `RootRedirect`**

```tsx
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Корень сайта: есть сессия -> обычный кабинет участника, нет сессии -> гостевой просмотр.
export function RootRedirect() {
  const { session, loading } = useAuth();
  if (loading) return <div style={{ padding: 24, color: '#fff' }}>Загрузка…</div>;
  return <Navigate to={session ? '/calendar' : '/g/calendar'} replace />;
}
```

- [ ] **Step 2: Переписать `src/App.tsx` целиком**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminRoute } from './auth/AdminRoute';
import { RootRedirect } from './auth/RootRedirect';
import Shell from './components/Shell';
import GuestShell from './components/GuestShell';
import Login from './pages/Login';
import Signup from './pages/Signup';
import RedeemInvite from './pages/RedeemInvite';
import ResetPassword from './pages/ResetPassword';
import Calendar from './pages/Calendar';
import GuestCalendar from './pages/GuestCalendar';
import Predict from './pages/Predict';
import Admin from './pages/Admin';
import AdminResult from './pages/AdminResult';
import Standings from './pages/Standings';
import Results from './pages/Results';
import Rules from './pages/Rules';

export default function App() {
  return (
    <BrowserRouter basename="/f1-predict">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/redeem" element={<RedeemInvite />} />
          <Route path="/reset" element={<ResetPassword />} />

          <Route path="/g" element={<GuestShell />}>
            <Route index element={<Navigate to="/g/calendar" replace />} />
            <Route path="calendar" element={<GuestCalendar />} />
            <Route path="standings" element={<Standings />} />
            <Route path="results" element={<Results />} />
            <Route path="rules" element={<Rules />} />
          </Route>

          <Route element={<ProtectedRoute><Shell /></ProtectedRoute>}>
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/predict" element={<Predict />} />
            <Route path="/predict/:raceId" element={<Predict />} />
            <Route path="/standings" element={<Standings />} />
            <Route path="/results" element={<Results />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
            <Route path="/admin/result/:raceId" element={<AdminRoute><AdminResult /></AdminRoute>} />
          </Route>

          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

`Standings`/`Results`/`Rules` монтируются на обоих деревьях маршрутов (`/g/...` и защищённом) без
изменений в самих компонентах — они уже гейтятся не собственной логикой авторизации, а тем, что
им фактически возвращает RLS: под `anon` те же вызовы `listRaces/getScores/listUsers/listDrivers/
getResult/getPrediction` просто вернут отфильтрованное RLS подмножество данных.

- [ ] **Step 3: Проверить типы и собрать**

```bash
npx tsc -b --noEmit
npm run build
```
Expected: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add src/auth/RootRedirect.tsx src/App.tsx
git commit -m "feat(frontend): маршрут /g/* и сессия-зависимый корень сайта"
```

---

### Task 8: Проверка целиком

- [ ] **Step 1: Включить свитч на бою**

```bash
cd scripts/db
node runner.js sql "select set_guest_access(true)"
```
Ожидается ошибка `admin only` (эта команда идёт от сервисного подключения без `auth.uid()` —
`is_admin()` вернёт `false` для `null`-пользователя). **Правильный способ** — включить через
чекбокс в Админке живого сайта под своим админ-аккаунтом (Task 4), не через прямой SQL.

- [ ] **Step 2: Смоук в браузере**

`npm run dev`, открыть сайт в приватном окне (без логина):
1. Открывается `/g/calendar` — виден список гонок, без «✓/— нет прогноза», карточки не кликаются.
2. `/g/standings` — реальный общий зачёт с именами.
3. `/g/results` — реальные результаты и прогнозы игроков после дедлайна (drift chart).
4. `/g/rules` — страница правил.
5. Кнопка «Войти» в шапке ведёт на `/login`.
6. Прямой переход на `/predict` или `/admin` — редиректит на `/login` (`ProtectedRoute` не
   тронут).
7. Выключить свитч в Админке под логином — обновить `/g/calendar` в приватном окне, должно
   показать пустое/ошибку загрузки (RLS снова всё скрывает).

- [ ] **Step 3: Финальная регрессия**

```bash
cd scripts/db
npm test
npm run test:rls
npm run test:security_grants
npm run test:predicted_user_ids
npm run test:gridbot
npm run test:guest_access
```
Expected: все зелёные.

```bash
npx tsc -b --noEmit
npm run build
```
Expected: без ошибок.
