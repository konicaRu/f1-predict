# Список проголосовавших на вкладке «Прогноз» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На вкладке «Прогноз» под таймером дедлайна показывать строку с именами игроков лиги, уже сделавших прогноз на эту гонку — не раскрывая сам прогноз.

**Architecture:** Новая `security definer` SQL-функция `predicted_user_ids(race_id)` в облачной БД (по прецеденту `keepalive_ping()`) отдаёт только `user_id` в обход построчного RLS-скрытия чужих прогнозов. Новый хелпер `getVotedUserIds` в `src/lib/db.ts` дёргает эту функцию через `supabase.rpc()`. `Predict.tsx` подгружает список игроков лиги + проголосовавших и рендерит строку в шапке.

**Tech Stack:** PostgreSQL (`security definer` функция), Supabase RPC (`supabase-js`), React (TSX), `pg` (для миграции/теста через `scripts/db/`).

---

### Task 1: SQL-функция `predicted_user_ids` + тест обхода RLS

**Files:**
- Create: `supabase/migrations/0012_predicted_user_ids.sql`
- Create: `scripts/db/predicted_user_ids.test.js`
- Modify: `scripts/db/package.json`

- [ ] **Step 1: Написать миграцию**

Создать `supabase/migrations/0012_predicted_user_ids.sql`:

```sql
-- 0012_predicted_user_ids.sql — узкий обход RLS для списка "кто уже сделал прогноз"
-- на вкладке "Прогноз" (стимул/соревновательный элемент). Отдаёт ТОЛЬКО user_id,
-- НЕ positions — содержимое прогноза до дедлайна остаётся скрытым как раньше.
-- security definer по прецеденту keepalive_ping() (0008_keepalive.sql).
create or replace function public.predicted_user_ids(p_race_id bigint)
returns setof uuid
language sql security definer set search_path = public as $$
  select user_id from public.predictions where race_id = p_race_id;
$$;

grant execute on function public.predicted_user_ids(bigint) to authenticated;
```

- [ ] **Step 2: Применить миграцию к облачной БД**

Run: `cd scripts/db && node runner.js applyfile ../../supabase/migrations/0012_predicted_user_ids.sql`
Expected: `applied: 0012_predicted_user_ids.sql (2 stmts...)`.

**Не запускать `npm run rebuild`** — эта команда дропает и пересоздаёт ВСЕ таблицы (реальные
прогнозы, очки, пользователей текущего сезона). Только `applyfile` для точечной миграции.

- [ ] **Step 3: Написать RLS-тест функции**

Создать `scripts/db/predicted_user_ids.test.js` (по образцу `scripts/db/rls.test.js` — весь тест
в одной транзакции с `rollback`, синтетические данные с высоким id, чтобы не задеть реальные):

```js
// Тест safety-критичной функции predicted_user_ids: должна обходить RLS-скрытие
// чужих прогнозов узко (отдаёт user_id, НЕ positions). Проверяем и обход, и то, что
// сама таблица predictions по-прежнему скрыта напрямую для того же пользователя.
const fs = require('fs'); const path = require('path');
const { Client } = require('pg');
const env = fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();

const A='44444444-4444-4444-4444-444444444444';
const B='55555555-5555-5555-5555-555555555555';
const perfect = JSON.stringify(Array.from({length:10},(_,i)=>`e${i+1}`));
const R = 900000101; // высокий id, чтобы не конфликтовать с реальными гонками

const SQL = `
begin;
set local statement_timeout='25s';
do $$
declare n int; secdef boolean; voted uuid[]; names text[]:='{}'; passed boolean[]:='{}'; infos text[]:='{}';
begin
  create temp table _t(name text, passed boolean, info text) on commit drop;
  insert into drivers(id,code,name) select 'e'||g,'E'||g,'Drv'||g from generate_series(1,10) g;
  insert into auth.users(id,email) values('${A}','pu-a@t.io'),('${B}','pu-b@t.io');
  insert into users(id,display_name,is_admin) values('${A}','A',false),('${B}','B',false);
  insert into races(id,round,name,deadline_utc,status) overriding system value values
    (${R},9101,'Open',now()+interval '2 days','open');
  insert into race_driver_pool(race_id,driver_id) select ${R},'e'||g from generate_series(1,10) g;
  insert into predictions(user_id,race_id,positions) values('${B}',${R},'${perfect}'::jsonb);

  select prosecdef into secdef from pg_proc where proname='predicted_user_ids';
  names:=array_append(names,'is security definer'); passed:=array_append(passed,secdef is true); infos:=array_append(infos,'prosecdef='||secdef);

  perform set_config('request.jwt.claims','{"sub":"${A}","role":"authenticated"}',true);
  execute 'set local role authenticated';

  select count(*) into n from predictions where race_id=${R} and user_id<>'${A}';
  names:=array_append(names,'raw table still hides others'); passed:=array_append(passed,(n=0)); infos:=array_append(infos,'видно чужих напрямую='||n);

  select array_agg(user_id) into voted from public.predicted_user_ids(${R});
  names:=array_append(names,'function surfaces voter despite RLS'); passed:=array_append(passed,(voted=array['${B}']::uuid[])); infos:=array_append(infos,'voted='||voted::text);

  reset role;
  insert into _t select * from unnest(names,passed,infos);
end $$;
select name, passed, info from _t order by name;
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
  console.log(`\n=== ИТОГ: ${pass} PASS, ${fail} FAIL (строк ${rows.length}/3) ===`);
  process.exit(fail===0&&rows.length===3?0:1);
})();
```

- [ ] **Step 4: Добавить npm-скрипт**

В `scripts/db/package.json` в объект `"scripts"` добавить (по образцу соседних
`test:open_race`/`test:set_race_result`, не входящих в агрегатный `test`):

```json
    "test:predicted_user_ids": "node predicted_user_ids.test.js",
```

- [ ] **Step 5: Прогнать тест**

Run: `cd scripts/db && npm run test:predicted_user_ids`
Expected: `=== ИТОГ: 3 PASS, 0 FAIL (строк 3/3) ===`, exit code 0. Все три проверки: функция
объявлена `security definer`, сырая таблица `predictions` по-прежнему прячет чужие строки для
пользователя A, но `predicted_user_ids()` для того же A возвращает `user_id` пользователя B.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_predicted_user_ids.sql scripts/db/predicted_user_ids.test.js scripts/db/package.json
git commit -m "feat(db): security definer функция predicted_user_ids — кто сделал прогноз, без RLS-обхода содержимого"
```

---

### Task 2: Строка «Поставили: ...» на вкладке «Прогноз»

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/pages/Predict.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: Добавить `getVotedUserIds` в `db.ts`**

В `src/lib/db.ts` добавить сразу после функции `getPrediction` (после закрывающей `}` на текущей
строке 93, перед `export async function nextOpenRace()`):

```ts

// Кто уже сделал прогноз на гонку (только user_id, не positions) — для вкладки "Прогноз".
// RPC security definer обходит построчное RLS-скрытие чужих прогнозов узко и осознанно
// (см. supabase/migrations/0012_predicted_user_ids.sql) — сам прогноз остаётся скрытым.
export async function getVotedUserIds(raceId: number): Promise<string[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.rpc('predicted_user_ids', { p_race_id: raceId });
    if (error) throw error;
    return (data ?? []) as string[];
  });
}
```

- [ ] **Step 2: Обновить импорты в `Predict.tsx`**

Заменить строки 1-8:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, getMyPrediction, savePrediction, nextOpenRace } from '../lib/db';
import type { Driver, Race } from '../lib/types';
import { SaveError } from '../lib/types';
import { isPast, formatCountdown } from '../lib/countdown';
import { PredictionSlots } from '../components/PredictionSlots';
import { DriverPool } from '../components/DriverPool';
```

на:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, getMyPrediction, savePrediction, nextOpenRace, getVotedUserIds, listUsers } from '../lib/db';
import type { Driver, Race, LeagueUser } from '../lib/types';
import { SaveError } from '../lib/types';
import { isPast, formatCountdown } from '../lib/countdown';
import { PredictionSlots } from '../components/PredictionSlots';
import { DriverPool } from '../components/DriverPool';
```

- [ ] **Step 3: Добавить состояние**

Заменить блок состояния (текущие строки 13-21):

```tsx
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [slots, setSlots] = useState<(string | null)[]>(Array(10).fill(null));
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
```

на:

```tsx
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [slots, setSlots] = useState<(string | null)[]>(Array(10).fill(null));
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [leagueUsers, setLeagueUsers] = useState<LeagueUser[]>([]);
  const [votedIds, setVotedIds] = useState<string[]>([]);
```

- [ ] **Step 4: Подгрузить игроков и проголосовавших вместе с гонкой**

Заменить эффект загрузки гонки (текущие строки 40-57):

```tsx
  useEffect(() => {
    if (!raceId) return;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { race, pool } = await getRaceWithPool(Number(raceId));
        const saved = await getMyPrediction(Number(raceId));
        setRace(race);
        setPool(pool);
        setSlots(saved && saved.length === 10 ? saved : Array(10).fill(null));
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);
```

на:

```tsx
  useEffect(() => {
    if (!raceId) return;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { race, pool } = await getRaceWithPool(Number(raceId));
        const saved = await getMyPrediction(Number(raceId));
        const users = await listUsers();
        const voted = await getVotedUserIds(Number(raceId));
        setRace(race);
        setPool(pool);
        setSlots(saved && saved.length === 10 ? saved : Array(10).fill(null));
        setLeagueUsers(users);
        setVotedIds(voted);
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    })();
  }, [raceId, reload]);
```

- [ ] **Step 5: Посчитать имена проголосовавших**

Заменить блок мемо (текущие строки 59-62):

```tsx
  const driversById = useMemo(() => new Map(pool.map((d) => [d.id, d])), [pool]);
  const assigned = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const readOnly = race ? isPast(race.deadline_utc) : false;
  const full = slots.every((s) => s !== null);
```

на:

```tsx
  const driversById = useMemo(() => new Map(pool.map((d) => [d.id, d])), [pool]);
  const assigned = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const readOnly = race ? isPast(race.deadline_utc) : false;
  const full = slots.every((s) => s !== null);
  const votedNames = useMemo(() => {
    const voted = new Set(votedIds);
    return leagueUsers
      .filter((u) => voted.has(u.id))
      .map((u) => u.display_name)
      .sort((a, b) => a.localeCompare(b));
  }, [leagueUsers, votedIds]);
```

- [ ] **Step 6: Обновлять список сразу после своего сохранения**

Заменить функцию `save` (текущие строки 94-107):

```tsx
  async function save() {
    if (!race || !full) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await savePrediction(race.id, slots as string[]);
      setMsg('Прогноз сохранён');
    } catch (e) {
      setErr(e instanceof SaveError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }
```

на:

```tsx
  async function save() {
    if (!race || !full) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await savePrediction(race.id, slots as string[]);
      setMsg('Прогноз сохранён');
      setVotedIds(await getVotedUserIds(race.id));
    } catch (e) {
      setErr(e instanceof SaveError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 7: Отрендерить строку в шапке**

Заменить блок `predict-head` (текущие строки 122-129):

```tsx
      <div className="predict-head">
        <h1>{race.name}</h1>
        {readOnly ? (
          <span className="lock-note">Дедлайн прошёл — прогноз зафиксирован</span>
        ) : (
          <span className="race-cd">⏱ до дедлайна: {formatCountdown(race.deadline_utc)}</span>
        )}
      </div>
```

на:

```tsx
      <div className="predict-head">
        <h1>{race.name}</h1>
        {readOnly ? (
          <span className="lock-note">Дедлайн прошёл — прогноз зафиксирован</span>
        ) : (
          <span className="race-cd">⏱ до дедлайна: {formatCountdown(race.deadline_utc)}</span>
        )}
        {votedNames.length > 0 && (
          <p className="predict-voted">✓ Поставили: {votedNames.join(', ')}</p>
        )}
      </div>
```

- [ ] **Step 8: Добавить стиль**

В `src/styles/app.css` добавить сразу после строки `.lock-note { ... }` (сейчас строка 80):

```css
.predict-voted { color: var(--muted); font-size: 13px; margin: 0; flex-basis: 100%; }
```

`flex-basis: 100%` заставляет строку встать на новую строку внутри `.predict-head`
(`display: flex; flex-wrap: wrap`), то есть под заголовком/таймером, а не втискиваться рядом.

- [ ] **Step 9: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 10: Ручная проверка в браузере**

Run: `npm run dev`
Открыть «Прогноз» на открытой гонке под своим аккаунтом. Проверить:
- Если ты ещё не сохранял прогноз и никто из лиги тоже — строки «Поставили: ...» нет.
- Сохранить прогноз (заполнить все 10 слотов, нажать «Сохранить») — сразу после сообщения
  «Прогноз сохранён» строка «✓ Поставили: {твоё имя}» появляется без перезагрузки страницы.
- Если сверить с БД (через `node scripts/db/runner.js sql "select display_name from users u join predictions p on p.user_id=u.id where p.race_id = <id>"`) — список имён в строке совпадает с реальными прогнозами по этой гонке.
- Сами прогнозы других игроков по-прежнему не видны на этой вкладке (только имена в строке).

- [ ] **Step 11: Commit**

```bash
git add src/lib/db.ts src/pages/Predict.tsx src/styles/app.css
git commit -m "feat(predict): строка «Поставили: ...» на вкладке Прогноз"
```
