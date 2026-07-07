# Фаза 2b — Календарь + Прогноз: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать участнику лиги экраны Календарь и Прогноз (tap-to-assign топ-10) для открытой гонки, с серверной валидацией и функцией `open_race()` для перевода гонки в статус `open`.

**Architecture:** Серверная функция `open_race()` (миграция 0007) снимает пул активных пилотов и ставит `status='open'`; dev-бутстрап открывает Бельгию. Фронт — подход A: тонкий типизированный `src/lib/db.ts` (единственная точка вызовов Supabase для данных лиги) + локальный `useState` в экранах + презентационные компоненты без обращения к БД. Serverside RLS/триггер (Фаза 0) уже enforce'ят дедлайн и состав; фронт лишь шлёт корректный массив и маппит ошибки.

**Tech Stack:** Postgres (Supabase, cloud-direct через pg), React 18 + Vite + TypeScript, react-router-dom, @supabase/supabase-js.

**Спека:** `docs/superpowers/specs/2026-07-05-phase2b-calendar-prediction-design.md`

---

## Заметки для исполнителя

- Все pg-команды идут cloud-direct через `.env` → `SUPABASE_DB_URL` (transaction pooler :6543). `.env` в git НЕ коммитить.
- Миграции применяются раннером: `cd scripts/db && node runner.js applyfile ../../supabase/migrations/0007_open_race.sql`.
- Фронт-верификация без юнит-раннера (спека §9): `npm run build` (= `tsc -b && vite build` — типы + сборка) + финальный ручной e2e-смоук в браузере. Проект composite (tsconfig с references, `noUnusedLocals`/`noUnusedParameters` включены) — не оставляй неиспользуемых импортов/параметров. React-тестов в 2b нет — это осознанное решение (YAGNI до 2c).
- Стиль pg-теста — как `scripts/db/membership.test.js`: одна SQL-строка (транзакция + DO-блок + `rollback`), клиент с ретраем и `killOrphans`.

---

## Task 1: Миграция 0007 — функция `open_race()`

**Files:**
- Create: `supabase/migrations/0007_open_race.sql`
- Create: `scripts/db/open_race.test.js`
- Modify: `scripts/db/package.json` (добавить npm-скрипт)

- [ ] **Step 1: Написать pg-тест (падающий)**

Create `scripts/db/open_race.test.js`:

```js
// open_race.test.js — снимок пула только активных, идемпотентность, гейт прав, защита resulted.
// Транзакция -> rollback (облако чистое). Стиль как membership.test.js.
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const ADMIN='55555555-5555-5555-5555-555555555555';
const USER ='66666666-6666-6666-6666-666666666666';
const SQL=`
begin;
set local statement_timeout='25s';
do $$
declare
  v_race bigint; v_resulted bigint;
  v_active int; v_pool int; v_idem int; v_hasinactive int;
  v_reopen_blocked boolean := false; v_nonadmin_blocked boolean := false;
begin
  insert into auth.users(id,email) values ('${ADMIN}','admin-or@t.io'),('${USER}','user-or@t.io');
  insert into public.users(id,display_name,is_admin) values ('${ADMIN}','Admin',true),('${USER}','User',false);
  insert into public.drivers(id,code,name,active) values ('_or_inactive','ZZZ','Inactive',false)
    on conflict (id) do update set active=false;
  select count(*) into v_active from drivers where active;

  insert into races(season,round,name,deadline_utc,status)
    values (2026,9901,'OR Demo', now()+interval '10 days','demo') returning id into v_race;
  insert into races(season,round,name,deadline_utc,status)
    values (2026,9902,'OR Resulted', now()-interval '1 day','resulted') returning id into v_resulted;

  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  select public.open_race(v_race) into v_pool;
  select public.open_race(v_race) into v_idem;
  execute 'reset role';

  select count(*) into v_hasinactive from race_driver_pool where race_id=v_race and driver_id='_or_inactive';

  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${ADMIN}'), true);
  execute 'set local role authenticated';
  begin perform public.open_race(v_resulted); exception when others then v_reopen_blocked := true; end;
  execute 'reset role';

  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}','${USER}'), true);
  execute 'set local role authenticated';
  begin perform public.open_race(v_race); exception when others then v_nonadmin_blocked := true; end;
  execute 'reset role';

  create temp table _or(active int, pool int, idem int, hasinactive int,
    reopen_blocked boolean, nonadmin_blocked boolean, status text) on commit drop;
  insert into _or select v_active, v_pool, v_idem, v_hasinactive, v_reopen_blocked, v_nonadmin_blocked,
    (select status from races where id=v_race);
end $$;
select * from _or;
rollback;`;
function pick(r){const a=Array.isArray(r)?r:[r];const x=a.reverse().find(y=>y.rows&&y.rows.length);return x?x.rows:[];}
async function killOrphans(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false}});c.on('error',()=>{});try{await c.connect();await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and state like '%idle in transaction%' and pid<>pg_backend_pid()");}catch(_){}finally{try{await c.end();}catch(_){}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function once(){const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});c.on('error',()=>{});await c.connect();try{return pick(await c.query(SQL));}finally{try{await c.end();}catch(_){}}}
(async()=>{let rows;for(let a=1;a<=5;a++){try{rows=await once();break;}catch(e){console.error(\`attempt \${a}/5: \${e.message}\`);if(a===5)process.exit(1);await killOrphans();await sleep(2000*a);}}
  const r=rows[0];
  const checks=[
    ['снимок = все активные', Number(r.pool)===Number(r.active)],
    ['идемпотентность', Number(r.idem)===Number(r.pool)],
    ['неактивный не в пуле', Number(r.hasinactive)===0],
    ['статус стал open', r.status==='open'],
    ['resulted не переоткрыть', r.reopen_blocked===true],
    ['не-админ заблокирован', r.nonadmin_blocked===true],
  ];
  const ok=checks.every(c=>c[1]);
  for(const [name,pass] of checks) console.log(\`  \${pass?'ok':'XX'}  \${name}\`);
  console.log(\`\${ok?'PASS':'FAIL'}  open_race (pool=\${r.pool}, active=\${r.active})\`);
  process.exit(ok?0:1);
})();
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd scripts/db && node open_race.test.js`
Expected: FAIL — `function public.open_race(bigint) does not exist` (функции ещё нет).

- [ ] **Step 3: Написать миграцию**

Create `supabase/migrations/0007_open_race.sql`:

```sql
-- 0007_open_race.sql — перевод гонки в 'open' со снимком пула активных пилотов (spec 2b §7).
create or replace function public.open_race(p_race_id bigint)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_count  int;
begin
  -- Гейт прав: залогиненный пользователь обязан быть админом. Прямое подключение
  -- (bootstrap / service_role) не имеет auth.uid() -> проходит.
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'open_race: admin only';
  end if;

  select status into v_status from races where id = p_race_id;
  if v_status is null then
    raise exception 'open_race: race % not found', p_race_id;
  end if;
  if v_status not in ('demo','open') then
    raise exception 'open_race: race % is % (only demo can be opened)', p_race_id, v_status;
  end if;

  -- Снимок пула: все активные пилоты, идемпотентно.
  insert into race_driver_pool (race_id, driver_id)
    select p_race_id, id from drivers where active
  on conflict do nothing;

  update races set status = 'open' where id = p_race_id and status = 'demo';

  select count(*) into v_count from race_driver_pool where race_id = p_race_id;
  return v_count;
end;
$$;

grant execute on function public.open_race(bigint) to authenticated;
```

- [ ] **Step 4: Применить миграцию**

Run: `cd scripts/db && node runner.js applyfile ../../supabase/migrations/0007_open_race.sql`
Expected: применена без ошибок (функция создана).

- [ ] **Step 5: Запустить тест — убедиться, что проходит**

Run: `cd scripts/db && node open_race.test.js`
Expected: `PASS  open_race (...)` — все 6 проверок `ok`.

- [ ] **Step 6: Добавить npm-скрипт**

Modify `scripts/db/package.json` — в `"scripts"` добавить:

```json
    "test:open_race": "node open_race.test.js",
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0007_open_race.sql scripts/db/open_race.test.js scripts/db/package.json
git commit -m "feat(phase2b): функция open_race() + pg-тест (снимок пула, гейт прав)"
```

---

## Task 2: Dev-бутстрап — открыть Бельгию (round 10)

**Files:**
- Create: `scripts/dev/bootstrap-open-belgium.js`
- Create: `scripts/dev/package.json`

- [ ] **Step 1: Создать package.json**

Create `scripts/dev/package.json`:

```json
{
  "name": "f1-predict-dev",
  "private": true,
  "type": "commonjs",
  "description": "Разовые dev-скрипты (cloud-direct). bootstrap-open-belgium: открыть гонку round 10.",
  "dependencies": { "pg": "^8.13.0" }
}
```

- [ ] **Step 2: Создать бутстрап-скрипт**

Create `scripts/dev/bootstrap-open-belgium.js`:

```js
// bootstrap-open-belgium.js — разовый dev-скрипт: открыть Бельгию (round 10) в проде.
// Cloud-direct через SUPABASE_DB_URL (прямое подключение обходит RLS, auth.uid() null -> гейт open_race пропускает).
// Запуск: cd scripts/dev && node bootstrap-open-belgium.js
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
(async()=>{
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});
  c.on('error',()=>{});
  await c.connect();
  try{
    const { rows:[r] } = await c.query('select id, status from races where season=2026 and round=10');
    if(!r){ console.error('гонка season=2026 round=10 не найдена'); process.exit(1); }
    const { rows:[p] } = await c.query('select public.open_race($1) as pool',[r.id]);
    console.log(`open_race(id=${r.id}, было status=${r.status}) OK — пул: ${p.pool} пилотов`);
  } finally { try{ await c.end(); }catch(_){} }
})();
```

- [ ] **Step 3: Установить зависимости**

Run: `cd scripts/dev && npm install`
Expected: установлен `pg`.

- [ ] **Step 4: Запустить бутстрап**

Run: `cd scripts/dev && node bootstrap-open-belgium.js`
Expected: `open_race(id=..., было status=demo) OK — пул: 22 пилотов` (22 активных пилота).
Примечание: идемпотентно — повторный запуск даст тот же вывод (`было status=open`).

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/bootstrap-open-belgium.js scripts/dev/package.json
git commit -m "feat(phase2b): dev-бутстрап открытия Бельгии (round 10)"
```

---

## Task 3: Фронт — типы и слой данных `db.ts`

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/db.ts`

- [ ] **Step 1: Создать типы**

Create `src/lib/types.ts`:

```ts
export type RaceStatus = 'demo' | 'open' | 'closed' | 'resulted';

export interface Race {
  id: number;
  season: number;
  round: number;
  name: string;
  race_datetime_utc: string | null;
  deadline_utc: string;
  status: RaceStatus;
  scored: boolean;
}

export interface Driver {
  id: string;
  code: string;
  name: string;
  team: string | null;
  team_color: string | null;
}

export type SaveErrorCode = 'deadline' | 'shape' | 'pool' | 'unknown';

export class SaveError extends Error {
  code: SaveErrorCode;
  constructor(code: SaveErrorCode, message: string) {
    super(message);
    this.name = 'SaveError';
    this.code = code;
  }
}
```

- [ ] **Step 2: Создать слой данных**

Create `src/lib/db.ts`:

```ts
import { supabase } from './supabase';
import type { Race, Driver } from './types';
import { SaveError } from './types';

export async function listRaces(): Promise<Race[]> {
  const { data, error } = await supabase
    .from('races').select('*').eq('season', 2026).order('round');
  if (error) throw error;
  return (data ?? []) as Race[];
}

export async function getMyPredictionRaceIds(): Promise<Set<number>> {
  const { data, error } = await supabase.from('predictions').select('race_id');
  if (error) throw error;
  return new Set((data ?? []).map((r: { race_id: number }) => r.race_id));
}

export async function getRaceWithPool(raceId: number): Promise<{ race: Race; pool: Driver[] }> {
  const { data: race, error: e1 } = await supabase
    .from('races').select('*').eq('id', raceId).single();
  if (e1) throw e1;
  const { data: poolRows, error: e2 } = await supabase
    .from('race_driver_pool')
    .select('drivers(id, code, name, team, team_color)')
    .eq('race_id', raceId);
  if (e2) throw e2;
  const pool = (poolRows ?? [])
    .map((r: any) => r.drivers as Driver)
    .filter(Boolean)
    .sort((a, b) => a.code.localeCompare(b.code));
  return { race: race as Race, pool };
}

export async function getMyPrediction(raceId: number): Promise<string[] | null> {
  const { data, error } = await supabase
    .from('predictions').select('positions').eq('race_id', raceId).maybeSingle();
  if (error) throw error;
  return data ? (data.positions as string[]) : null;
}

export async function nextOpenRace(): Promise<Race | null> {
  const races = await listRaces();
  const now = Date.now();
  const open = races
    .filter((r) => r.status === 'open' && new Date(r.deadline_utc).getTime() >= now)
    .sort((a, b) => new Date(a.deadline_utc).getTime() - new Date(b.deadline_utc).getTime());
  return open[0] ?? null;
}

export async function savePrediction(raceId: number, driverIds: string[]): Promise<void> {
  const { data: userRes } = await supabase.auth.getUser();
  const uid = userRes.user?.id;
  if (!uid) throw new SaveError('unknown', 'Не авторизован');
  const { error } = await supabase
    .from('predictions')
    .upsert({ user_id: uid, race_id: raceId, positions: driverIds }, { onConflict: 'user_id,race_id' });
  if (error) throw mapSaveError(error);
}

function mapSaveError(error: { message?: string; code?: string }): SaveError {
  const m = (error.message || '').toLowerCase();
  if (error.code === '42501' || m.includes('row-level security'))
    return new SaveError('deadline', 'Дедлайн прошёл — прогноз больше нельзя изменить');
  if (m.includes('exactly 10') || m.includes('10 distinct'))
    return new SaveError('shape', 'Нужно заполнить все 10 мест разными пилотами');
  if (m.includes('race pool'))
    return new SaveError('pool', 'Пилот не из состава этой гонки (обнови страницу)');
  return new SaveError('unknown', 'Не удалось сохранить, попробуй ещё раз');
}
```

- [ ] **Step 3: Проверить типы (сборкой)**

Run: `npm run build`
Expected: без TS-ошибок (существующий код + новые файлы компилируются, vite build успешен).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/db.ts
git commit -m "feat(phase2b): типы лиги + слой данных db.ts (обёртки Supabase, маппинг ошибок)"
```

---

## Task 4: Хелпер `countdown.ts`

**Files:**
- Create: `src/lib/countdown.ts`

- [ ] **Step 1: Создать хелпер**

Create `src/lib/countdown.ts`:

```ts
// Утилиты времени: каунтдаун до дедлайна, признак «прошёл», дата в МСК.
export function msUntil(deadlineUtc: string, now: number = Date.now()): number {
  return new Date(deadlineUtc).getTime() - now;
}

export function isPast(deadlineUtc: string, now: number = Date.now()): boolean {
  return msUntil(deadlineUtc, now) <= 0;
}

export function formatCountdown(deadlineUtc: string, now: number = Date.now()): string {
  const ms = msUntil(deadlineUtc, now);
  if (ms <= 0) return 'дедлайн прошёл';
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / (60 * 24));
  const h = Math.floor((min % (60 * 24)) / 60);
  const m = min % 60;
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

export function formatMoscow(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}
```

- [ ] **Step 2: Проверить типы (сборкой)**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 3: Ручная санити-проверка логики**

Run: `node -e "const d=new Date(Date.now()+3*864e5+14*36e5).toISOString(); const min=Math.floor((new Date(d).getTime()-Date.now())/6e4); console.log(Math.floor(min/1440)+'д '+Math.floor(min%1440/60)+'ч')"`
Expected: `3д 14ч` (проверка формулы каунтдауна, не зависящей от TS).

- [ ] **Step 4: Commit**

```bash
git add src/lib/countdown.ts
git commit -m "feat(phase2b): хелпер countdown (каунтдаун дедлайна, дата МСК)"
```

---

## Task 5: Презентационные компоненты

**Files:**
- Create: `src/components/DriverChip.tsx`
- Create: `src/components/PredictionSlots.tsx`
- Create: `src/components/DriverPool.tsx`
- Create: `src/components/RaceCard.tsx`

- [ ] **Step 1: DriverChip**

Create `src/components/DriverChip.tsx`:

```tsx
import type { Driver } from '../lib/types';

export function DriverChip({ driver, onClick, selected, dimmed, compact }: {
  driver: Driver;
  onClick?: () => void;
  selected?: boolean;
  dimmed?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={'chip' + (selected ? ' chip-sel' : '') + (dimmed ? ' chip-dim' : '') + (compact ? ' chip-compact' : '')}
      style={{ borderLeftColor: driver.team_color || '#888' }}
    >
      <span className="chip-code">{driver.code}</span>
      {!compact && <span className="chip-name">{driver.name}</span>}
    </button>
  );
}
```

- [ ] **Step 2: PredictionSlots**

Create `src/components/PredictionSlots.tsx`:

```tsx
import type { Driver } from '../lib/types';
import { DriverChip } from './DriverChip';

export function PredictionSlots({ slots, driversById, selectedIndex, onSlotClick, readOnly }: {
  slots: (string | null)[];
  driversById: Map<string, Driver>;
  selectedIndex?: number | null;
  onSlotClick?: (index: number) => void;
  readOnly?: boolean;
}) {
  return (
    <ol className="slots">
      {slots.map((driverId, i) => {
        const d = driverId ? driversById.get(driverId) : null;
        const sel = selectedIndex === i;
        return (
          <li key={i} className={'slot' + (sel ? ' slot-sel' : '')}>
            <span className="slot-pos">{i + 1}</span>
            {d ? (
              <DriverChip driver={d} compact onClick={readOnly ? undefined : () => onSlotClick?.(i)} />
            ) : (
              <button type="button" className="slot-empty" disabled={readOnly} onClick={() => onSlotClick?.(i)}>
                {sel ? '▸' : '—'}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 3: DriverPool**

Create `src/components/DriverPool.tsx`:

```tsx
import type { Driver } from '../lib/types';
import { DriverChip } from './DriverChip';

export function DriverPool({ pool, assigned, onPick }: {
  pool: Driver[];
  assigned: Set<string>;
  onPick: (driverId: string) => void;
}) {
  return (
    <div className="pool">
      {pool.map((d) => (
        <DriverChip
          key={d.id}
          driver={d}
          compact
          dimmed={assigned.has(d.id)}
          onClick={assigned.has(d.id) ? undefined : () => onPick(d.id)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: RaceCard (+ классификатор)**

Create `src/components/RaceCard.tsx`:

```tsx
import type { Race } from '../lib/types';
import { formatCountdown, formatMoscow, isPast } from '../lib/countdown';

export type RaceView = 'open' | 'locked' | 'soon' | 'past';

export function classifyRace(race: Race, now: number = Date.now()): RaceView {
  const past = isPast(race.deadline_utc, now);
  if (race.status === 'open') return past ? 'locked' : 'open';
  if (race.status === 'demo') return past ? 'past' : 'soon';
  return 'past'; // closed / resulted
}

const BADGE: Record<RaceView, string> = {
  open: 'открыта', locked: 'закрыта', soon: 'скоро', past: 'результаты',
};

export function RaceCard({ race, hasPrediction, highlight, onClick }: {
  race: Race;
  hasPrediction: boolean;
  highlight?: boolean;
  onClick?: () => void;
}) {
  const view = classifyRace(race);
  const clickable = view === 'open' || view === 'locked';
  return (
    <div
      className={'race-card' + (highlight ? ' race-hl' : '') + (clickable ? ' race-click' : ' race-static')}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
    >
      <div className="race-main">
        <span className="race-round">R{race.round}</span>
        <span className="race-name">{race.name}</span>
      </div>
      <div className="race-meta">
        <span className={'race-badge badge-' + view}>{BADGE[view]}</span>
        {race.race_datetime_utc && <span className="race-date">{formatMoscow(race.race_datetime_utc)} МСК</span>}
        {view === 'open' && <span className="race-cd">⏱ {formatCountdown(race.deadline_utc)}</span>}
        <span className={'race-pred' + (hasPrediction ? ' has' : '')}>
          {hasPrediction ? '✓ прогноз' : '— нет прогноза'}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Проверить типы (сборкой)**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add src/components/DriverChip.tsx src/components/PredictionSlots.tsx src/components/DriverPool.tsx src/components/RaceCard.tsx
git commit -m "feat(phase2b): презентационные компоненты (чип, слоты, пул, карточка гонки)"
```

---

## Task 6: Экран «Календарь» + роутинг

**Files:**
- Create: `src/pages/Calendar.tsx`
- Modify: `src/App.tsx` (подключить Calendar вместо заглушки)

- [ ] **Step 1: Создать Calendar**

Create `src/pages/Calendar.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listRaces, getMyPredictionRaceIds } from '../lib/db';
import type { Race } from '../lib/types';
import { RaceCard, classifyRace, type RaceView } from '../components/RaceCard';

export default function Calendar() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [predIds, setPredIds] = useState<Set<number>>(new Set());
  const [err, setErr] = useState('');
  const nav = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        const [rs, ids] = await Promise.all([listRaces(), getMyPredictionRaceIds()]);
        setRaces(rs);
        setPredIds(ids);
      } catch (e: any) {
        setErr(e.message || 'Ошибка загрузки');
      }
    })();
  }, []);

  if (err) return <div className="stub">{err}</div>;
  if (!races) return <div className="stub">Загрузка…</div>;

  const byView = (v: RaceView | RaceView[]) => {
    const set = Array.isArray(v) ? v : [v];
    return races.filter((r) => set.includes(classifyRace(r)));
  };
  const open = byView('open');
  const soon = byView('soon');
  const past = byView(['locked', 'past']);
  const nextOpenId = [...open]
    .sort((a, b) => new Date(a.deadline_utc).getTime() - new Date(b.deadline_utc).getTime())[0]?.id;

  const section = (title: string, list: Race[]) =>
    list.length > 0 && (
      <section className="cal-sec" key={title}>
        <h2 className="cal-h">{title}</h2>
        {list.map((r) => (
          <RaceCard
            key={r.id}
            race={r}
            hasPrediction={predIds.has(r.id)}
            highlight={r.id === nextOpenId}
            onClick={() => nav(`/predict/${r.id}`)}
          />
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

- [ ] **Step 2: Подключить в App.tsx**

Modify `src/App.tsx` — добавить импорт вверху (после существующих импортов страниц):

```tsx
import Calendar from './pages/Calendar';
```

И заменить строку заглушки Календаря:

```tsx
            <Route path="/calendar" element={<Stub name="Календарь" />} />
```

на:

```tsx
            <Route path="/calendar" element={<Calendar />} />
```

- [ ] **Step 3: Собрать**

Run: `npm run build`
Expected: сборка успешна, без TS-ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Calendar.tsx src/App.tsx
git commit -m "feat(phase2b): экран Календарь (группы статусов, подсветка, переход к прогнозу)"
```

---

## Task 7: Экран «Прогноз» + роутинг

**Files:**
- Create: `src/pages/Predict.tsx`
- Modify: `src/App.tsx` (маршруты `/predict` и `/predict/:raceId`)

- [ ] **Step 1: Создать Predict**

Create `src/pages/Predict.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getRaceWithPool, getMyPrediction, savePrediction, nextOpenRace } from '../lib/db';
import type { Driver, Race } from '../lib/types';
import { SaveError } from '../lib/types';
import { isPast, formatCountdown } from '../lib/countdown';
import { PredictionSlots } from '../components/PredictionSlots';
import { DriverPool } from '../components/DriverPool';

export default function Predict() {
  const { raceId } = useParams();
  const nav = useNavigate();
  const [race, setRace] = useState<Race | null>(null);
  const [pool, setPool] = useState<Driver[]>([]);
  const [slots, setSlots] = useState<(string | null)[]>(Array(10).fill(null));
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // /predict без id -> редирект на ближайшую открытую гонку
  useEffect(() => {
    if (raceId) return;
    (async () => {
      const r = await nextOpenRace();
      if (r) nav(`/predict/${r.id}`, { replace: true });
      else setLoading(false);
    })();
  }, [raceId, nav]);

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
  }, [raceId]);

  const driversById = useMemo(() => new Map(pool.map((d) => [d.id, d])), [pool]);
  const assigned = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const readOnly = race ? isPast(race.deadline_utc) : false;
  const full = slots.every((s) => s !== null);

  function onSlotClick(i: number) {
    if (readOnly) return;
    if (slots[i]) {
      // занятый -> освободить
      setSlots((prev) => {
        const next = [...prev];
        next[i] = null;
        return next;
      });
      setSelectedSlot(null);
    } else {
      // пустой -> выбрать/снять выбор для прицельного размещения
      setSelectedSlot((prev) => (prev === i ? null : i));
    }
  }

  function onPick(driverId: string) {
    if (readOnly) return;
    setSlots((prev) => {
      const target = selectedSlot !== null ? selectedSlot : prev.indexOf(null);
      if (target === -1 || target === null) return prev;
      const next = [...prev];
      const existing = next.indexOf(driverId);
      if (existing !== -1) next[existing] = null; // защита от дубля
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
      await savePrediction(race.id, slots as string[]);
      setMsg('Прогноз сохранён');
    } catch (e) {
      setErr(e instanceof SaveError ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="stub">Загрузка…</div>;
  if (!raceId) return <div className="stub">Сейчас нет открытых гонок — смотри Календарь.</div>;
  if (err && !race) return <div className="stub">{err}</div>;
  if (!race) return <div className="stub">Загрузка…</div>;

  return (
    <div className="predict">
      <div className="predict-head">
        <h1>{race.name}</h1>
        {readOnly ? (
          <span className="lock-note">Дедлайн прошёл — прогноз зафиксирован</span>
        ) : (
          <span className="race-cd">⏱ до дедлайна: {formatCountdown(race.deadline_utc)}</span>
        )}
      </div>

      <div className="predict-grid">
        <PredictionSlots
          slots={slots}
          driversById={driversById}
          selectedIndex={selectedSlot}
          onSlotClick={onSlotClick}
          readOnly={readOnly}
        />
        {!readOnly && <DriverPool pool={pool} assigned={assigned} onPick={onPick} />}
      </div>

      {!readOnly && (
        <div className="predict-actions">
          <button disabled={!full || busy} onClick={save}>{busy ? '…' : 'Сохранить'}</button>
          {msg && <span className="ok-note">{msg}</span>}
          {err && <span className="auth-err">{err}</span>}
        </div>
      )}

      {readOnly && !slots.some(Boolean) && (
        <p className="stub">Ты не делал прогноз на эту гонку.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Подключить маршруты в App.tsx**

Modify `src/App.tsx` — добавить импорт:

```tsx
import Predict from './pages/Predict';
```

Заменить строку заглушки Прогноза:

```tsx
            <Route path="/predict" element={<Stub name="Прогноз" />} />
```

на две строки (список + конкретная гонка):

```tsx
            <Route path="/predict" element={<Predict />} />
            <Route path="/predict/:raceId" element={<Predict />} />
```

- [ ] **Step 3: Собрать**

Run: `npm run build`
Expected: сборка успешна.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Predict.tsx src/App.tsx
git commit -m "feat(phase2b): экран Прогноз (tap-to-assign, сохранение, read-only после дедлайна)"
```

---

## Task 8: Стили (Календарь + Прогноз + мобильная боковая раскладка)

**Files:**
- Modify: `src/styles/app.css` (добавить блок стилей 2b в конец)

- [ ] **Step 1: Добавить стили**

Modify `src/styles/app.css` — дописать в конец файла:

```css
/* ===== Фаза 2b: Календарь ===== */
.calendar { display: flex; flex-direction: column; gap: 20px; }
.cal-sec { display: flex; flex-direction: column; gap: 8px; }
.cal-h { font-family: 'Saira Condensed'; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-size: 14px; margin: 4px 0; }
.race-card { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 12px; padding: 12px 16px; }
.race-click { cursor: pointer; }
.race-click:hover { border-color: var(--volt); }
.race-static { opacity: .6; }
.race-hl { border-left-color: var(--volt); box-shadow: 0 0 0 1px var(--volt) inset; }
.race-main { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.race-round { font-family: 'Saira Condensed'; font-weight: 800; color: var(--volt); font-size: 15px; }
.race-name { font-family: 'Saira Condensed'; font-weight: 700; font-size: 17px; }
.race-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; font-size: 12px; }
.race-badge { text-transform: uppercase; letter-spacing: .05em; font-weight: 700; font-size: 10px; padding: 3px 8px; border-radius: 6px; }
.badge-open { background: rgba(0,229,255,.15); color: var(--volt); }
.badge-locked { background: rgba(138,147,166,.18); color: var(--muted); }
.badge-soon { background: rgba(255,46,99,.15); color: var(--hot); }
.badge-past { background: rgba(138,147,166,.12); color: var(--muted); }
.race-date { color: var(--muted); }
.race-cd { color: var(--volt); font-weight: 600; }
.race-pred { color: var(--muted); }
.race-pred.has { color: var(--volt); }

/* ===== Чипы пилотов ===== */
.chip { display: inline-flex; align-items: center; gap: 8px; background: var(--panel2); border: 1px solid var(--line); border-left: 4px solid #888; color: var(--txt); border-radius: 8px; padding: 8px 10px; cursor: pointer; font-family: 'Saira Condensed'; font-weight: 700; }
.chip:disabled { cursor: default; }
.chip-code { font-size: 15px; letter-spacing: .04em; }
.chip-name { font-family: Inter; font-weight: 500; font-size: 12px; color: var(--muted); }
.chip-compact { padding: 6px 8px; }
.chip-sel { border-color: var(--volt); box-shadow: 0 0 0 1px var(--volt) inset; }
.chip-dim { opacity: .32; cursor: default; }

/* ===== Прогноз ===== */
.predict { display: flex; flex-direction: column; gap: 14px; }
.predict-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.predict-head h1 { font-family: 'Saira Condensed'; font-weight: 800; margin: 0; }
.lock-note { color: var(--muted); font-size: 13px; }
.predict-grid { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
.slots { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.slot { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; }
.slot-sel { border-color: var(--volt); }
.slot-pos { font-family: 'Saira Condensed'; font-weight: 800; color: var(--volt); width: 22px; text-align: center; }
.slot-empty { flex: 1; text-align: left; background: transparent; border: 1px dashed var(--line); color: var(--muted); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.slot-empty:disabled { cursor: default; }
.pool { display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start; }
.predict-actions { display: flex; align-items: center; gap: 14px; }
.predict-actions button { background: linear-gradient(90deg, var(--hot), #c01f4a); color: #fff; border: 0; border-radius: 9px; padding: 12px 22px; font-weight: 600; cursor: pointer; }
.predict-actions button:disabled { opacity: .5; cursor: not-allowed; }
.ok-note { color: var(--volt); font-size: 13px; }

/* ===== Мобильная боковая раскладка (принятое требование §16.11) ===== */
@media (max-width: 640px) {
  .predict-grid { grid-template-columns: 116px 1fr; gap: 8px; }
  .pool { max-height: 72vh; overflow-y: auto; gap: 6px; }
  .slot { padding: 5px 6px; gap: 6px; }
  .slot-pos { width: 16px; }
  .race-meta { justify-content: flex-start; }
}
```

- [ ] **Step 2: Собрать**

Run: `npm run build`
Expected: сборка успешна.

- [ ] **Step 3: Commit**

```bash
git add src/styles/app.css
git commit -m "feat(phase2b): стили Календаря и Прогноза + мобильная боковая раскладка"
```

---

## Task 9: E2E-смоук в браузере + фиксация

**Files:**
- Modify: `MEMORY.md` (лог сессии 2b)

- [ ] **Step 1: Убедиться, что Бельгия открыта**

Если Task 2 не запускался в этой среде — выполнить `cd scripts/dev && node bootstrap-open-belgium.js` (идемпотентно).
Expected: `... OK — пул: 22 пилотов`.

- [ ] **Step 2: Запустить dev-сервер**

Run: `npm run dev -- --host`
Expected: Vite поднялся на `http://localhost:5173/f1-predict/`.

- [ ] **Step 3: Ручной смоук (в браузере)**

Проверить по шагам (залогиниться под `prokol35@gmail.com`):
1. Вкладка **Календарь**: Бельгия (R10) в блоке «Активные», подсвечена, бейдж «открыта», каунтдаун, «— нет прогноза». Прошедшие демо-гонки — в «Прошедшие», приглушены.
2. Тап по Бельгии → экран **Прогноз** с 10 пустыми слотами и пулом из 22 пилотов.
3. **Быстрый режим:** тап по пилоту в пуле → он встаёт в первый пустой слот, в пуле гаснет.
4. **Прицельный режим:** тап по пустому слоту (подсветка ▸) → тап по пилоту → он встаёт в этот слот.
5. Тап по занятому слоту → пилот освобождается, возвращается в пул.
6. Заполнить все 10 → кнопка «Сохранить» активна → нажать → «Прогноз сохранён».
7. Перейти на Календарь → у Бельгии «✓ прогноз». Вернуться в Прогноз → сохранённая расстановка на местах (редактируема).
8. **Мобильная раскладка:** DevTools → ширина ≤ 640px → слоты слева узкой колонкой, пул справа прокруткой, обе колонки на одном экране без вертикальной простыни.

Expected: все 8 пунктов проходят. Если что-то не так — зафиксировать и починить до коммита.

- [ ] **Step 4: Обновить MEMORY.md**

Modify `MEMORY.md` — в разделе «Статус проекта» отметить, что 2b закрыта (Календарь+Прогноз работают, `open_race()` + бутстрап, Бельгия открыта), и добавить запись в «Лог сессий» с датой 2026-07-05: brainstorm→спека→план→impl 2b, e2e-смоук пройден, ветка `phase2b`.

- [ ] **Step 5: Commit**

```bash
git add MEMORY.md
git commit -m "docs(phase2b): e2e-смоук пройден, журнал обновлён"
```

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:**
- §4 архитектура/файлы → Tasks 3–8 (все файлы созданы).
- §5 Календарь (классификация, группы, подсветка, каунтдаун, метка прогноза, роутинг) → Task 5 (RaceCard+classifyRace), Task 6 (Calendar+App).
- §6 Прогноз (загрузка пул+прогноз, tap-to-assign quick+targeted, save, read-only, мобильная раскладка) → Task 5 (Slots/Pool), Task 7 (Predict), Task 8 (мобильный CSS).
- §7 open_race + бутстрап → Task 1, Task 2.
- §8 маппинг ошибок → Task 3 (`mapSaveError` в db.ts).
- §9 тесты → Task 1 (pg-тест open_race), Task 9 (e2e-смоук); scoring/RLS не дублируются.

**Плейсхолдеры:** нет — весь код приведён целиком.

**Согласованность типов/имён:** `classifyRace`/`RaceView`/`RaceCard` едины (Task 5, 6). `db.ts` API (`listRaces`, `getMyPredictionRaceIds`, `getRaceWithPool`, `getMyPrediction`, `nextOpenRace`, `savePrediction`) совпадает с вызовами в Calendar/Predict. `PredictionSlots` (`selectedIndex`) и `DriverPool` (`onPick`, `assigned`) совпадают с использованием в Predict. `SaveError`/`SaveErrorCode` — types.ts ↔ db.ts ↔ Predict.
