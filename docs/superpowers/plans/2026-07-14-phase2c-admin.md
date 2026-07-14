# Фаза 2c — Админка: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Конституция:** в промпты сабагентов-исполнителей/ревьюеров вкладывать релевантные пункты `docs/constitution.md` (§2 безопасность в БД, §3 журнал результата, секреты, UTC/МСК, §6 YAGNI, устойчивость сети).

**Goal:** Дать админу UI: кнопку «Открыть гонку» (поверх `open_race`) и ручной занос/правку топ-10 результата (RPC `set_race_result` → гонка `resulted`+`scored`, очки через view `scores`, правки в журнал `result_changes`).

**Architecture:** Вся запись результата — атомарный серверный RPC `set_race_result` (SECURITY DEFINER, гейт админа, валидация состава, журнал, upsert, scored/status). Фронт тонкий: страница `/admin` (список гонок + действия по `races.status`) и `/admin/result/:raceId` (tap-to-assign из пула, переиспользует компоненты 2b). Гейт `AdminRoute`.

**Tech Stack:** Postgres (Supabase, cloud-direct через pg), React 18 + Vite + TS, react-router-dom, @supabase/supabase-js.

**Спека:** `docs/superpowers/specs/2026-07-14-phase2c-admin-design.md`

---

## Заметки для исполнителя

- Cloud-direct через `.env` → `SUPABASE_DB_URL` (transaction pooler :6543). `.env` в git НЕ коммитить.
- Миграции: `cd scripts/db && node runner.js applyfile ../../supabase/migrations/0009_admin_results.sql`.
- Фронт-верификация: `npm run build` (= `tsc -b && vite build`; проект composite, `noUnusedLocals`/`noUnusedParameters` — не оставляй неиспользуемых импортов/параметров). React-юнит-раннера нет (YAGNI, как в 2b) — плюс финальный ручной e2e-смоук.
- Стиль pg-теста — как `scripts/db/open_race.test.js` (одна SQL-строка: транзакция + DO-блок + rollback; клиент с ретраем + killOrphans).
- Скоринг уже есть: view `scores` (predictions ⋈ results ⋈ score_prediction). Перфектный прогноз даёт **131 очко / 10 точных**.

---

## Task 1: Миграция 0009 — RPC `set_race_result()`

**Files:**
- Create: `supabase/migrations/0009_admin_results.sql`
- Create: `scripts/db/set_race_result.test.js`
- Modify: `scripts/db/package.json` (npm-скрипт)

- [ ] **Step 1: Написать pg-тест (падающий)**

Create `scripts/db/set_race_result.test.js`:

```js
// set_race_result.test.js — гейт админа, валидация состава, журнал, scored/status, override, сквозной скоринг.
// Транзакция -> rollback. Стиль как open_race.test.js.
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const ADMIN='77777777-7777-7777-7777-777777777777';
const USER ='88888888-8888-8888-8888-888888888888';
const SQL=`
begin;
set local statement_timeout='25s';
do $$
declare
  v_race bigint;
  actual jsonb; actual2 jsonb; actual9 jsonb; actualdup jsonb; actualpool jsonb;
  rc1 int; rc2 int; v_points int;
  v_res_status text; v_race_status text; v_scored boolean; v_res_match boolean;
  not10 boolean:=false; dup boolean:=false; pool boolean:=false; nonadmin boolean:=false;
begin
  -- fixtures
  insert into auth.users(id,email) values ('${ADMIN}','a-sr@t.io'),('${USER}','u-sr@t.io');
  insert into public.users(id,display_name,is_admin) values ('${ADMIN}','A',true),('${USER}','U',false);
  insert into public.drivers(id,code,name,active)
    select '_tr'||lpad(g::text,2,'0'), 'T'||g, 'Test '||g, true from generate_series(1,12) g;
  insert into races(season,round,name,deadline_utc,status,scored)
    values (2026,9911,'SR Test', now()-interval '1 day','open',false) returning id into v_race;
  insert into race_driver_pool(race_id,driver_id)
    select v_race, '_tr'||lpad(g::text,2,'0') from generate_series(1,12) g;

  actual     := (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,10) g);
  actual2    := jsonb_build_array('_tr02','_tr01') || (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(3,10) g);
  actual9    := (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,9) g);
  actualdup  := jsonb_build_array('_tr01') || (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,9) g);
  actualpool := (select jsonb_agg('_tr'||lpad(g::text,2,'0')) from generate_series(1,9) g) || jsonb_build_array('_zzz_notpool');

  -- прогноз игрока = actual (перфект -> 131 очко)
  insert into predictions(user_id,race_id,positions) values ('${USER}',v_race,actual);

  -- ПЕРВЫЙ ЗАНОС (как админ)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  perform public.set_race_result(v_race, actual, null);
  execute 'reset role';

  select count(*) into rc1 from result_changes where race_id=v_race;
  select status into v_res_status from results where race_id=v_race;
  select scored, status into v_scored, v_race_status from races where id=v_race;
  select points into v_points from scores where user_id='${USER}' and race_id=v_race;

  -- OVERRIDE (как админ)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  perform public.set_race_result(v_race, actual2, 'fix');
  execute 'reset role';

  select count(*) into rc2 from result_changes where race_id=v_race;
  select (positions = actual2) into v_res_match from results where race_id=v_race;

  -- ВАЛИДАЦИЯ (как админ, каждая должна упасть)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  begin perform public.set_race_result(v_race, actual9,   null); exception when others then not10:=true; end;
  begin perform public.set_race_result(v_race, actualdup, null); exception when others then dup:=true;   end;
  begin perform public.set_race_result(v_race, actualpool,null); exception when others then pool:=true;  end;
  execute 'reset role';

  -- НЕ-АДМИН (должно упасть)
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${USER}'), true);
  execute 'set local role authenticated';
  begin perform public.set_race_result(v_race, actual, null); exception when others then nonadmin:=true; end;
  execute 'reset role';

  create temp table _tr(res_status text, race_status text, scored boolean, points int,
    rc1 int, rc2 int, res_match boolean, not10 boolean, dup boolean, pool boolean, nonadmin boolean) on commit drop;
  insert into _tr values (v_res_status, v_race_status, v_scored, v_points, rc1, rc2, v_res_match, not10, dup, pool, nonadmin);
end $$;
select * from _tr;
rollback;`;
function pick(r){const a=Array.isArray(r)?r:[r];const x=a.reverse().find(y=>y.rows&&y.rows.length);return x?x.rows:[];}
async function killOrphans(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false}});c.on('error',()=>{});try{await c.connect();await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}finally{try{await c.end();}catch(_){}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function once(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});c.on('error',()=>{});await c.connect();try{return pick(await c.query(SQL));}finally{try{await c.end();}catch(_){}}}
(async()=>{let rows;for(let a=1;a<=5;a++){try{rows=await once();break;}catch(e){console.error(\`attempt \${a}/5: \${e.message}\`);if(a===5)process.exit(1);await killOrphans();await sleep(2000*a);}}
  const r=rows[0];
  const checks=[
    ['результат final', r.res_status==='final'],
    ['гонка resulted', r.race_status==='resulted'],
    ['scored=true', r.scored===true],
    ['очки=131 (сквозной скоринг)', Number(r.points)===131],
    ['журнал после заноса=1', Number(r.rc1)===1],
    ['журнал после override=2', Number(r.rc2)===2],
    ['override перезаписал результат', r.res_match===true],
    ['не 10 -> отказ', r.not10===true],
    ['дубли -> отказ', r.dup===true],
    ['вне пула -> отказ', r.pool===true],
    ['не-админ -> отказ', r.nonadmin===true],
  ];
  const ok=checks.every(c=>c[1]);
  for(const [n,p] of checks) console.log(\`  \${p?'ok':'XX'}  \${n}\`);
  console.log(\`\${ok?'PASS':'FAIL'}  set_race_result (points=\${r.points})\`);
  process.exit(ok?0:1);
})();
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd scripts/db && node set_race_result.test.js`
Expected: FAIL — `function public.set_race_result(bigint, jsonb, text) does not exist`. (Сеть до пулера может флапать — харнесс ретраит 5×; если все попытки — транзиентная сеть, а не «does not exist», сообщи как concern.)

- [ ] **Step 3: Написать миграцию**

Create `supabase/migrations/0009_admin_results.sql`:

```sql
-- 0009_admin_results.sql — ручной занос результата гонки админом (spec 2c §5).
create or replace function public.set_race_result(
  p_race_id bigint, p_positions jsonb, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  ids text[];
begin
  -- Гейт: залогиненный обязан быть админом; прямое подключение (service/bootstrap) проходит.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'set_race_result: admin only';
  end if;

  -- Валидация состава (как validate_prediction): ровно 10 разных из пула гонки.
  if jsonb_typeof(p_positions) <> 'array' or jsonb_array_length(p_positions) <> 10 then
    raise exception 'result must be an array of exactly 10 drivers';
  end if;
  select array_agg(value) into ids from jsonb_array_elements_text(p_positions);
  if (select count(distinct e) from unnest(ids) e) <> 10 then
    raise exception 'result must contain 10 distinct drivers';
  end if;
  if exists (
    select 1 from unnest(ids) e
    where not exists (select 1 from public.race_driver_pool p
                      where p.race_id = p_race_id and p.driver_id = e)
  ) then
    raise exception 'all drivers must be in the race pool';
  end if;

  -- Журнал (before -> after).
  select positions into v_before from public.results where race_id = p_race_id;
  insert into public.result_changes(race_id, before, after, reason)
    values (p_race_id, v_before, p_positions, p_reason);

  -- Занос результата (final).
  insert into public.results(race_id, positions, status, fetched_at)
    values (p_race_id, p_positions, 'final', now())
  on conflict (race_id) do update
    set positions = excluded.positions, status = 'final', fetched_at = now();

  -- Зачёт гонки.
  update public.races set status = 'resulted', scored = true where id = p_race_id;
end;
$$;

grant execute on function public.set_race_result(bigint, jsonb, text) to authenticated;
```

- [ ] **Step 4: Применить миграцию**

Run: `cd scripts/db && node runner.js applyfile ../../supabase/migrations/0009_admin_results.sql`
Expected: применена без ошибок.

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `cd scripts/db && node set_race_result.test.js`
Expected: `PASS  set_race_result (points=131)` — все 11 проверок `ok`.

- [ ] **Step 6: Добавить npm-скрипт**

Modify `scripts/db/package.json` — в `"scripts"` добавить строку (сохрани валидный JSON — запятая на предыдущей строке):

```json
    "test:set_race_result": "node set_race_result.test.js",
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0009_admin_results.sql scripts/db/set_race_result.test.js scripts/db/package.json
git commit -m "feat(phase2c): RPC set_race_result() + pg-тест (валидация, журнал, scored, скоринг)"
```

---

## Task 2: Слой данных — обёртки админа в `db.ts`

**Files:**
- Modify: `src/lib/types.ts` (добавить код ошибки `admin`)
- Modify: `src/lib/db.ts` (openRace, getResult, setRaceResult, mapResultError)

- [ ] **Step 1: Расширить `SaveErrorCode`**

Modify `src/lib/types.ts` — заменить строку:

```ts
export type SaveErrorCode = 'deadline' | 'shape' | 'pool' | 'unknown';
```

на:

```ts
export type SaveErrorCode = 'deadline' | 'shape' | 'pool' | 'admin' | 'unknown';
```

- [ ] **Step 2: Добавить обёртки в `db.ts`**

Modify `src/lib/db.ts` — дописать в конец файла:

```ts
// ===== Админ (Фаза 2c) =====

// Открыть гонку (снимок пула + status=open). open_race идемпотентна.
export async function openRace(raceId: number): Promise<number> {
  const { data, error } = await supabase.rpc('open_race', { p_race_id: raceId });
  if (error) throw error;
  return data as number;
}

// Текущий результат гонки (топ-10 driver_id) или null.
export async function getResult(raceId: number): Promise<string[] | null> {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('results').select('positions').eq('race_id', raceId).maybeSingle();
    if (error) throw error;
    return data ? (data.positions as string[]) : null;
  });
}

// Занос/правка результата. НЕ ретраим (журнал не идемпотентен: повтор = лишняя строка в result_changes).
export async function setRaceResult(raceId: number, driverIds: string[], reason?: string): Promise<void> {
  const { error } = await supabase.rpc('set_race_result', {
    p_race_id: raceId, p_positions: driverIds, p_reason: reason ?? null,
  });
  if (error) throw mapResultError(error);
}

function mapResultError(error: { message?: string; code?: string }): SaveError {
  const m = (error.message || '').toLowerCase();
  if (m.includes('admin only') || error.code === '42501' || m.includes('row-level security'))
    return new SaveError('admin', 'Только для администратора');
  if (m.includes('exactly 10') || m.includes('10 distinct'))
    return new SaveError('shape', 'Нужно 10 разных пилотов');
  if (m.includes('race pool'))
    return new SaveError('pool', 'Пилот не из состава гонки (обнови страницу)');
  return new SaveError('unknown', 'Не удалось сохранить, попробуй ещё');
}
```

- [ ] **Step 3: Проверить сборку**

Run: `npm run build`
Expected: без TS-ошибок, vite build успешен.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/db.ts
git commit -m "feat(phase2c): db.ts — openRace/getResult/setRaceResult + маппинг ошибок админа"
```

---

## Task 3: Гейт `AdminRoute` + экран «Админка» + роутинг

**Files:**
- Create: `src/auth/AdminRoute.tsx`
- Create: `src/pages/Admin.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Создать `AdminRoute`**

Create `src/auth/AdminRoute.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Клиентский гейт админки (сервер защищён RLS; это UX — не пускать не-админа на /admin).
export function AdminRoute({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/calendar" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 2: Создать `Admin`**

Create `src/pages/Admin.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listRaces, openRace } from '../lib/db';
import type { Race } from '../lib/types';
import { isPast } from '../lib/countdown';
import { raceCountry } from '../lib/flags';
import { Flag } from '../components/Flag';

export default function Admin() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const nav = useNavigate();

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

  async function onOpen(id: number) {
    setBusyId(id);
    setErr('');
    try {
      await openRace(id);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Не удалось открыть гонку');
    } finally {
      setBusyId(null);
    }
  }

  if (err && !races)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (!races) return <div className="stub">Загрузка…</div>;

  return (
    <div className="admin">
      <h1 className="admin-h1">Админка</h1>
      {err && <p className="auth-err">{err}</p>}
      <div className="admin-list">
        {races.map((r) => {
          const upcoming = r.status === 'demo' && !isPast(r.deadline_utc);
          const opened = r.status === 'open';
          const resulted = r.status === 'resulted';
          const dim = r.status === 'demo' && isPast(r.deadline_utc);
          return (
            <div key={r.id} className={'admin-row' + (dim ? ' admin-dim' : '')}>
              <div className="admin-race">
                <span className="race-round">R{r.round}</span>
                <Flag code={raceCountry(r.name)} />
                <span className="race-name">{r.name}</span>
              </div>
              <div className="admin-actions">
                {upcoming && (
                  <button disabled={busyId === r.id} onClick={() => onOpen(r.id)}>
                    {busyId === r.id ? '…' : 'Открыть гонку'}
                  </button>
                )}
                {opened && (
                  <button onClick={() => nav(`/admin/result/${r.id}`)}>Занести результат</button>
                )}
                {resulted && (
                  <>
                    <button onClick={() => nav(`/admin/result/${r.id}`)}>✏ Редактировать результат</button>
                    <span className="admin-badge">результат ✓</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Подключить роут в `App.tsx`**

Modify `src/App.tsx`:

(a) Добавить импорты после существующих импортов страниц:

```tsx
import Admin from './pages/Admin';
import { AdminRoute } from './auth/AdminRoute';
```

(b) Заменить строку:

```tsx
            <Route path="/admin" element={<Stub name="Админка" />} />
```

на:

```tsx
            <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
```

- [ ] **Step 4: Сборка**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/auth/AdminRoute.tsx src/pages/Admin.tsx src/App.tsx
git commit -m "feat(phase2c): гейт AdminRoute + экран Админка (список гонок, кнопка Открыть)"
```

---

## Task 4: Экран заноса результата `/admin/result/:raceId`

**Files:**
- Create: `src/pages/AdminResult.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Создать `AdminResult`**

Create `src/pages/AdminResult.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, getResult, setRaceResult } from '../lib/db';
import type { Driver, Race } from '../lib/types';
import { SaveError } from '../lib/types';
import { PredictionSlots } from '../components/PredictionSlots';
import { DriverPool } from '../components/DriverPool';

export default function AdminResult() {
  const { raceId } = useParams();
  const nav = useNavigate();
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [slots, setSlots] = useState<(string | null)[]>(Array(10).fill(null));
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [hadResult, setHadResult] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { race, pool } = await getRaceWithPool(Number(raceId));
        const saved = await getResult(Number(raceId));
        setRace(race);
        setPool(pool);
        setHadResult(!!saved);
        setSlots(saved && saved.length === 10 ? saved : Array(10).fill(null));
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);

  const driversById = useMemo(() => new Map(pool.map((d) => [d.id, d])), [pool]);
  const assigned = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const full = slots.every((s) => s !== null);

  function onSlotClick(i: number) {
    if (slots[i]) {
      setSlots((prev) => {
        const next = [...prev];
        next[i] = null;
        return next;
      });
      setSelectedSlot(null);
    } else {
      setSelectedSlot((prev) => (prev === i ? null : i));
    }
  }

  function onPick(driverId: string) {
    setSlots((prev) => {
      const target = selectedSlot !== null ? selectedSlot : prev.indexOf(null);
      if (target === -1 || target === null) return prev;
      const next = [...prev];
      const existing = next.indexOf(driverId);
      if (existing !== -1) next[existing] = null;
      next[target] = driverId;
      return next;
    });
    setSelectedSlot(null);
  }

  async function save() {
    if (!race || !full) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await setRaceResult(race.id, slots as string[], hadResult ? reason || undefined : undefined);
      setMsg('Результат сохранён, гонка зачтена');
      setTimeout(() => nav('/admin'), 700);
    } catch (e) {
      setErr(e instanceof SaveError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="stub">Загрузка…</div>;
  if (err && !race)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={() => setReload((n) => n + 1)}>Повторить</button>
      </div>
    );
  if (!race) return <div className="stub">Загрузка…</div>;

  return (
    <div className="predict">
      <div className="predict-head">
        <h1>Результат: {race.name}</h1>
        {hadResult && (
          <span className="lock-note">Редактирование перезапишет результат; изменение попадёт в журнал</span>
        )}
      </div>

      <div className="predict-grid">
        <PredictionSlots
          slots={slots}
          driversById={driversById}
          selectedIndex={selectedSlot}
          onSlotClick={onSlotClick}
        />
        <DriverPool pool={pool} assigned={assigned} onPick={onPick} />
      </div>

      {hadResult && (
        <input
          className="reason-input"
          placeholder="причина правки (необязательно)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}

      <div className="predict-actions">
        <button disabled={!full || busy} onClick={save}>{busy ? '…' : 'Сохранить результат'}</button>
        {msg && <span className="ok-note">{msg}</span>}
        {err && <span className="auth-err">{err}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Подключить роут в `App.tsx`**

Modify `src/App.tsx`:

(a) Добавить импорт после `import Admin from './pages/Admin';`:

```tsx
import AdminResult from './pages/AdminResult';
```

(b) После строки роута `/admin` добавить:

```tsx
            <Route path="/admin/result/:raceId" element={<AdminRoute><AdminResult /></AdminRoute>} />
```

- [ ] **Step 3: Сборка**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/pages/AdminResult.tsx src/App.tsx
git commit -m "feat(phase2c): экран заноса результата (tap-to-assign, override с причиной)"
```

---

## Task 5: Стили админки

**Files:**
- Modify: `src/styles/app.css` (дописать в конец)

- [ ] **Step 1: Добавить стили**

Modify `src/styles/app.css` — дописать в конец файла:

```css
/* ===== Фаза 2c: Админка ===== */
.admin { display: flex; flex-direction: column; gap: 14px; }
.admin-h1 { font-family: 'Titillium Web'; font-weight: 700; margin: 0; }
.admin-list { display: flex; flex-direction: column; gap: 8px; }
.admin-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
.admin-dim { opacity: .5; }
.admin-race { display: flex; align-items: center; gap: 10px; min-width: 0; }
.admin-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.admin-actions button { background: var(--panel2); border: 1px solid var(--line); color: var(--txt); border-radius: 9px; padding: 9px 14px; font-weight: 600; cursor: pointer; font-family: Inter; }
.admin-actions button:hover:not(:disabled) { border-color: var(--volt); }
.admin-actions button:disabled { opacity: .5; cursor: not-allowed; }
.admin-badge { font-size: 11px; color: var(--volt); }
.reason-input { background: var(--panel2); border: 1px solid var(--line); color: var(--txt); border-radius: 9px; padding: 10px 12px; font-size: 14px; max-width: 420px; }
```

- [ ] **Step 2: Сборка**

Run: `npm run build`
Expected: сборка успешна.

- [ ] **Step 3: Commit**

```bash
git add src/styles/app.css
git commit -m "feat(phase2c): стили Админки и поля причины правки"
```

---

## Task 6: E2E-смоук в браузере + фиксация

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Запустить dev-сервер**

Run (PowerShell): `npx vite --host 0.0.0.0`
Expected: поднялся на `http://localhost:5173/f1-predict/` (слушает 0.0.0.0 — и IPv4, и IPv6).

- [ ] **Step 2: Ручной смоук (в браузере, под админом `prokol35@gmail.com`)**

1. Вкладка **Админ** видна (для не-админа /admin редиректит на Календарь — проверить отдельным аккаунтом при желании).
2. На `/admin` — список гонок. У будущих (demo, дедлайн впереди) — кнопка «Открыть гонку»; у Бельгии (open) — «Занести результат»; исторические демо — приглушены без кнопок.
3. **Открыть гонку:** нажать «Открыть гонку» на любой будущей → строка станет с кнопкой «Занести результат» (гонка открыта, пул снят).
4. **Занести результат:** у Бельгии → «Занести результат» → экран tap-to-assign → разложить топ-10 → «Сохранить результат» → «…зачтена» → возврат на /admin, у Бельгии бейдж «результат ✓» и кнопка «Редактировать».
5. **Правка/журнал:** снова открыть Бельгию → префилл сохранённого → поменять местами двух пилотов → указать причину → сохранить. (Журнал `result_changes` проверить через `scripts/db`: `node runner.js sql "select race_id,before,after,reason from result_changes order by changed_at desc limit 3"`.)
6. **Скоринг:** проверить, что очки появились — `node runner.js sql "select * from scores where race_id=<belgium id> limit 5"` (если есть прогнозы игроков).

Expected: все пункты проходят. Если что-то не так — зафиксировать и починить до коммита.

> Примечание: занос результата на Бельгию делает её `resulted`+`scored` (для реальной игры админ заносит после гонки). Для смоука это ок; при необходимости результат правится повторно.

- [ ] **Step 2b: Проверить сборку**

Run: `npm run build`
Expected: зелёная.

- [ ] **Step 3: Обновить `MEMORY.md`**

Modify `MEMORY.md` — в «Статус проекта» отметить, что 2c закрыта (Админка: open_race-кнопка + set_race_result занос/правка с журналом, скоринг через scores), и добавить запись в «Лог сессий» (дата 2026-07-14): brainstorm→спека→план→impl 2c через subagent-driven с конституцией, e2e-смоук пройден, ветка `phase2c`.

- [ ] **Step 4: Commit**

```bash
git add MEMORY.md
git commit -m "docs(phase2c): e2e-смоук пройден, журнал обновлён"
```

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:**
- §5 RPC set_race_result (гейт, валидация, журнал, upsert, scored/status) → Task 1.
- §4 файлы/границы → Tasks 1–5.
- §6 Админка (список, действия по статусу, кнопка Открыть, гейт) → Task 3.
- §7 экран заноса (tap-to-assign, префилл, причина, override) → Task 4.
- §8 маппинг ошибок RPC → Task 2 (`mapResultError`).
- §9 тесты → Task 1 (pg-тест 11 проверок вкл. сквозной скоринг 131), Task 6 (e2e). Скоринг/RLS/open_race не дублируются.

**Плейсхолдеры:** нет — весь код приведён целиком.

**Согласованность типов/имён:** `openRace`/`getResult`/`setRaceResult`/`mapResultError` (Task 2) совпадают с вызовами в Admin (Task 3) и AdminResult (Task 4). `SaveError`/`SaveErrorCode`(+`admin`) — types.ts ↔ db.ts ↔ AdminResult. `PredictionSlots`(`selectedIndex`,`onSlotClick`,`driversById`,`slots`) и `DriverPool`(`pool`,`assigned`,`onPick`) — сигнатуры из 2b соблюдены (в AdminResult `readOnly` не передаём — по умолчанию редактируемо). `classifyRace` НЕ используется в Admin (действия по `races.status` напрямую — у `classifyRace` нет вида `resulted`); это осознанно.
