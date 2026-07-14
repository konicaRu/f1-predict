# Фаза 3 — Витрина (Зачёт + Результаты): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Конституция:** в промпты сабагентов вкладывать релевантные пункты `docs/constitution.md` (§1 тайбрейкер, §2 RLS-чтение, UTC/МСК, §6 YAGNI, устойчивость сети).

**Goal:** Показать игрокам исход игры — экран «Зачёт» (лидерборд с тайбрейкером) и «Результаты» (фактический топ-10 + очки игроков по выбранной сыгранной гонке).

**Architecture:** Подход A (клиентский): тонкие read-обёртки `db.ts` (`getScores`/`listUsers`/`listDrivers`, все через `withRetry`) + чистая функция агрегации `standings.ts` + два экрана-оркестратора. Очки уже считаются в view `scores`; drift-chart отложен.

**Tech Stack:** React 18 + Vite + TS, react-router-dom, @supabase/supabase-js. Тестовые данные — cloud-direct через `scripts/db/runner.js`.

**Спека:** `docs/superpowers/specs/2026-07-14-phase3-showcase-design.md`

---

## Заметки для исполнителя

- Фронт-верификация: `npm run build` (`tsc -b && vite build`; composite, `noUnusedLocals`/`noUnusedParameters` — без неиспользуемых импортов/параметров). React-юнит-раннера нет (YAGNI, как в 2b/2c) — логика `standings.ts` проверяется в e2e-смоуке на контролируемых фикстурах (Task 6).
- Cloud-direct для тестовых данных: `.env` → `SUPABASE_DB_URL`; `.env` в git НЕ коммитить.
- `scores` (view): `user_id, race_id, points, exact_hits`, RLS-safe. Перфектный прогноз = 131 очко / 10 точных.

---

## Task 1: Типы + read-обёртки в `db.ts`

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Добавить типы**

Modify `src/lib/types.ts` — дописать в конец файла:

```ts
export interface Score {
  user_id: string;
  race_id: number;
  points: number;
  exact_hits: number;
}

export interface LeagueUser {
  id: string;
  display_name: string;
}
```

- [ ] **Step 2: Расширить импорт типов в `db.ts`**

Modify `src/lib/db.ts` — заменить строку:

```ts
import type { Race, Driver } from './types';
```

на:

```ts
import type { Race, Driver, Score, LeagueUser } from './types';
```

- [ ] **Step 3: Добавить обёртки-чтения**

Modify `src/lib/db.ts` — дописать в конец файла:

```ts
// ===== Витрина (Фаза 3) =====

// Очки: все видимые строки view scores (RLS: чужое до дедлайна скрыто, для сыгранных — видно).
export async function getScores(): Promise<Score[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('scores').select('user_id, race_id, points, exact_hits');
    if (error) throw error;
    return (data ?? []) as Score[];
  });
}

// Игроки лиги (для имён в таблицах).
export async function listUsers(): Promise<LeagueUser[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('users').select('id, display_name');
    if (error) throw error;
    return (data ?? []) as LeagueUser[];
  });
}

// Все пилоты (для кодов/цветов команд в топ-10 результата).
export async function listDrivers(): Promise<Driver[]> {
  return withRetry(async () => {
    const { data, error } = await supabase.from('drivers').select('id, code, name, team, team_color, standing');
    if (error) throw error;
    return (data ?? []) as Driver[];
  });
}
```

- [ ] **Step 4: Сборка**

Run: `npm run build`
Expected: без TS-ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/db.ts
git commit -m "feat(phase3): типы Score/LeagueUser + обёртки getScores/listUsers/listDrivers"
```

## Context (Task 1)
- `src/lib/db.ts` уже экспортирует Supabase-обёртки и имеет `withRetry` (таймаут+ретрай) + `SaveError`. Новые функции — только чтение, все через `withRetry`.
- `scores` — SQL view (`predictions ⋈ results ⋈ score_prediction`), `security_invoker=true`.
- `Driver` (в types.ts) уже имеет поле `standing`.

---

## Task 2: Чистая функция `standings.ts`

**Files:**
- Create: `src/lib/standings.ts`

- [ ] **Step 1: Создать `src/lib/standings.ts`**

Create `src/lib/standings.ts` with EXACTLY this content:

```ts
import type { Score, LeagueUser } from './types';

export interface StandingRow {
  userId: string;
  name: string;
  points: number;
  exact: number;
  bestRace: number;
  played: number;
  rank: number;
}

// Агрегирует очки по игрокам среди ЗАЧЁТНЫХ гонок и ранжирует.
// Тайбрейкер (конституция §1): очки ↓ → точные ↓ → лучшая гонка ↓ (затем имя для стабильности).
// Ранг соревновательный: равным ключам — одно место, следующий сдвигается (1,2,2,4).
export function aggregateStandings(
  scores: Score[],
  users: LeagueUser[],
  scoredRaceIds: Set<number>,
): StandingRow[] {
  const agg = new Map<string, { points: number; exact: number; bestRace: number; played: number }>();
  for (const u of users) agg.set(u.id, { points: 0, exact: 0, bestRace: 0, played: 0 });
  for (const s of scores) {
    if (!scoredRaceIds.has(s.race_id)) continue;
    const a = agg.get(s.user_id);
    if (!a) continue; // счёт по не-члену игнорируем
    a.points += s.points;
    a.exact += s.exact_hits;
    a.bestRace = Math.max(a.bestRace, s.points);
    a.played += 1;
  }
  const rows: StandingRow[] = users.map((u) => {
    const a = agg.get(u.id)!;
    return { userId: u.id, name: u.display_name, points: a.points, exact: a.exact, bestRace: a.bestRace, played: a.played, rank: 0 };
  });
  rows.sort(
    (a, b) => b.points - a.points || b.exact - a.exact || b.bestRace - a.bestRace || a.name.localeCompare(b.name),
  );
  let rank = 0;
  let prev: StandingRow | null = null;
  rows.forEach((r, i) => {
    if (!prev || r.points !== prev.points || r.exact !== prev.exact || r.bestRace !== prev.bestRace) {
      rank = i + 1;
    }
    r.rank = rank;
    prev = r;
  });
  return rows;
}
```

- [ ] **Step 2: Сборка**

Run: `npm run build`
Expected: без TS-ошибок.

- [ ] **Step 3: Commit**

```bash
git add src/lib/standings.ts
git commit -m "feat(phase3): standings.ts — агрегация зачёта + тайбрейкер (чистая функция)"
```

## Context (Task 2)
- Чистая функция без React/БД: вход — строки `scores`, список `users`, множество id зачётных гонок; выход — ранжированные строки. Проверяется в смоуке (Task 6) на фикстурах с известными очками.

---

## Task 3: Экран «Зачёт» + роутинг

**Files:**
- Create: `src/pages/Standings.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Создать `src/pages/Standings.tsx`**

Create `src/pages/Standings.tsx` with EXACTLY this content:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { listRaces, getScores, listUsers } from '../lib/db';
import { aggregateStandings, type StandingRow } from '../lib/standings';
import { supabase } from '../lib/supabase';

export default function Standings() {
  const [rows, setRows] = useState<StandingRow[] | null>(null);
  const [scoredCount, setScoredCount] = useState(0);
  const [meId, setMeId] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    setRows(null);
    try {
      const [races, scores, users, userRes] = await Promise.all([
        listRaces(),
        getScores(),
        listUsers(),
        supabase.auth.getUser(),
      ]);
      const scoredIds = new Set(races.filter((r) => r.scored).map((r) => r.id));
      setScoredCount(scoredIds.size);
      setMeId(userRes.data.user?.id ?? null);
      setRows(aggregateStandings(scores, users, scoredIds));
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (err && !rows)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (!rows) return <div className="stub">Загрузка…</div>;
  if (scoredCount === 0) return <div className="stub">Зачёт появится после первой зачётной гонки.</div>;

  return (
    <div className="standings">
      <h1 className="page-h1">Общий зачёт</h1>
      <table className="lb">
        <thead>
          <tr>
            <th>#</th>
            <th>Игрок</th>
            <th>Очки</th>
            <th>Точных</th>
            <th>Лучшая</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.userId}
              className={'lb-row' + (r.userId === meId ? ' lb-me' : '') + (r.rank <= 3 ? ' lb-p' + r.rank : '')}
            >
              <td className="lb-place">{r.rank}</td>
              <td className="lb-name">
                {r.name}
                {r.userId === meId && <span className="lb-you">ты</span>}
              </td>
              <td className="lb-pts">{r.points}</td>
              <td>{r.exact}</td>
              <td>{r.bestRace}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lb-note">При равенстве очков выше тот, у кого больше точных попаданий, затем — лучшая гонка.</p>
    </div>
  );
}
```

- [ ] **Step 2: Подключить роут в `App.tsx`**

Modify `src/App.tsx`:

(a) Добавить импорт после существующих импортов страниц:

```tsx
import Standings from './pages/Standings';
```

(b) Заменить строку:

```tsx
            <Route path="/standings" element={<Stub name="Зачёт" />} />
```

на:

```tsx
            <Route path="/standings" element={<Standings />} />
```

- [ ] **Step 3: Сборка**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Standings.tsx src/App.tsx
git commit -m "feat(phase3): экран Зачёт (лидерборд, тайбрейкер, подсветка ты/подиум)"
```

## Context (Task 3)
- Паттерн экрана — как `Calendar.tsx`: `load` в `useCallback([])`, loading/error+«Повторить», пустое состояние.
- `supabase.auth.getUser()` даёт id текущего игрока для подсветки строки «ты».
- Стили (`page-h1`, `lb`, `lb-me`, `lb-p1/2/3`, `lb-you`, …) добавляются в Task 5 — до тех пор экран нестилизован, но функционален.

---

## Task 4: Экран «Результаты» + роутинг

**Files:**
- Create: `src/pages/Results.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Создать `src/pages/Results.tsx`**

Create `src/pages/Results.tsx` with EXACTLY this content:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listRaces, getResult, getScores, listUsers, listDrivers } from '../lib/db';
import type { Race, Driver, Score } from '../lib/types';
import { supabase } from '../lib/supabase';

export default function Results() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [drivers, setDrivers] = useState<Map<string, Driver>>(new Map());
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [scores, setScores] = useState<Score[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [positions, setPositions] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const [rs, ds, us, sc, userRes] = await Promise.all([
        listRaces(),
        listDrivers(),
        listUsers(),
        getScores(),
        supabase.auth.getUser(),
      ]);
      setRaces(rs);
      setDrivers(new Map(ds.map((d) => [d.id, d])));
      setUsers(new Map(us.map((u) => [u.id, u.display_name])));
      setScores(sc);
      setMeId(userRes.data.user?.id ?? null);
      const resulted = rs.filter((r) => r.status === 'resulted').sort((a, b) => b.round - a.round);
      setSel(resulted[0]?.id ?? null);
    } catch (e: any) {
      setErr(e.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (sel == null) {
      setPositions(null);
      return;
    }
    getResult(sel).then(setPositions).catch(() => setPositions(null));
  }, [sel]);

  const resulted = useMemo(
    () => (races ?? []).filter((r) => r.status === 'resulted').sort((a, b) => b.round - a.round),
    [races],
  );
  const raceScores = useMemo(
    () => scores.filter((s) => s.race_id === sel).sort((a, b) => b.points - a.points),
    [scores, sel],
  );

  if (err && !races)
    return (
      <div className="stub">
        <p>{err}</p>
        <button className="retry-btn" onClick={load}>Повторить</button>
      </div>
    );
  if (loading || !races) return <div className="stub">Загрузка…</div>;
  if (resulted.length === 0)
    return <div className="stub">Результатов пока нет — появятся после первой сыгранной гонки.</div>;

  return (
    <div className="results">
      <h1 className="page-h1">Результаты</h1>
      <div className="race-pills">
        {resulted.map((r) => (
          <button
            key={r.id}
            className={'pill' + (r.id === sel ? ' pill-on' : '')}
            onClick={() => setSel(r.id)}
          >
            R{r.round} · {r.name.replace(' Grand Prix', '')}
          </button>
        ))}
      </div>
      <div className="results-grid">
        <div className="res-top10">
          <h2 className="col-h">Финиш · топ-10</h2>
          <ol className="finish">
            {(positions ?? []).map((id, i) => {
              const d = drivers.get(id);
              return (
                <li key={id} className={'finish-row' + (i < 3 ? ' finish-podium' : '')}>
                  <span className="finish-pos">{i + 1}</span>
                  <span className="finish-bar" style={{ background: d?.team_color || '#888' }} />
                  <span className="finish-code">{d?.code ?? id}</span>
                  <span className="finish-name">{d?.name ?? ''}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="res-scores">
          <h2 className="col-h">Очки за гонку</h2>
          <table className="lb">
            <thead>
              <tr>
                <th>Игрок</th>
                <th>Очки</th>
                <th>Точных</th>
              </tr>
            </thead>
            <tbody>
              {raceScores.map((s) => (
                <tr key={s.user_id} className={'lb-row' + (s.user_id === meId ? ' lb-me' : '')}>
                  <td className="lb-name">
                    {users.get(s.user_id) ?? '—'}
                    {s.user_id === meId && <span className="lb-you">ты</span>}
                  </td>
                  <td className="lb-pts">{s.points}</td>
                  <td>{s.exact_hits}</td>
                </tr>
              ))}
              {raceScores.length === 0 && (
                <tr>
                  <td colSpan={3} className="lb-empty">Нет прогнозов на эту гонку</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Подключить роут в `App.tsx`**

Modify `src/App.tsx`:

(a) Добавить импорт после `import Standings from './pages/Standings';`:

```tsx
import Results from './pages/Results';
```

(b) Заменить строку:

```tsx
            <Route path="/results" element={<Stub name="Результаты" />} />
```

на:

```tsx
            <Route path="/results" element={<Results />} />
```

- [ ] **Step 3: Сборка**

Run: `npm run build`
Expected: без ошибок.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Results.tsx src/App.tsx
git commit -m "feat(phase3): экран Результаты (селектор гонок, топ-10, очки игроков)"
```

## Context (Task 4)
- `getResult(raceId)` уже есть (2c) — возвращает `string[] | null` (топ-10 driver_id).
- Селектор показывает только `status='resulted'`, по умолчанию последняя (макс round). Смена гонки перезагружает `positions` (второй эффект по `sel`).
- Таблица очков за гонку — `scores`, отфильтрованные по выбранной гонке (`raceScores`), сорт по очкам ↓.

---

## Task 5: Стили витрины

**Files:**
- Modify: `src/styles/app.css` (дописать в конец)

- [ ] **Step 1: Добавить стили**

Modify `src/styles/app.css` — дописать в конец файла:

```css
/* ===== Фаза 3: Витрина (Зачёт + Результаты) ===== */
.page-h1 { font-family: 'Titillium Web'; font-weight: 700; margin: 0 0 14px; }

/* Таблицы-лидерборды (общие для Зачёта и Результатов) */
.lb { width: 100%; border-collapse: collapse; }
.lb thead th { text-align: left; font-family: 'Titillium Web'; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: var(--muted); padding: 6px 10px; border-bottom: 1px solid var(--line); }
.lb-row td { padding: 10px; border-bottom: 1px solid var(--line); font-size: 14px; }
.lb-place { font-family: 'Titillium Web'; font-weight: 700; font-size: 18px; width: 40px; }
.lb-name { font-weight: 600; }
.lb-you { margin-left: 8px; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: var(--volt); border: 1px solid var(--volt); border-radius: 5px; padding: 1px 5px; }
.lb-pts { font-family: 'Titillium Web'; font-weight: 700; font-size: 17px; font-variant-numeric: tabular-nums; }
.lb-me { box-shadow: 0 0 0 1px var(--volt) inset; }
.lb-p1 .lb-place { color: #E8C15A; }
.lb-p2 .lb-place { color: #C7CDD6; }
.lb-p3 .lb-place { color: #CD7F47; }
.lb-note { color: var(--muted); font-size: 12px; margin-top: 12px; }
.lb-empty { color: var(--muted); text-align: center; }

/* Результаты */
.results { display: flex; flex-direction: column; gap: 14px; }
.race-pills { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.pill { flex: 0 0 auto; background: var(--panel); border: 1px solid var(--line); color: var(--txt); border-radius: 9px; padding: 8px 12px; font-weight: 600; cursor: pointer; white-space: nowrap; font-size: 13px; }
.pill-on { border-color: var(--volt); background: var(--panel2); }
.results-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.col-h { font-family: 'Titillium Web'; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; font-size: 13px; color: var(--muted); margin: 0 0 8px; }
.finish { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.finish-row { display: flex; align-items: center; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 7px 10px; }
.finish-pos { font-family: 'Titillium Web'; font-weight: 700; width: 22px; text-align: center; color: var(--muted); }
.finish-podium .finish-pos { color: #E8C15A; }
.finish-bar { width: 4px; height: 20px; border-radius: 2px; flex: 0 0 auto; }
.finish-code { font-family: 'Titillium Web'; font-weight: 700; font-size: 15px; }
.finish-name { color: var(--muted); font-size: 12px; }

@media (max-width: 640px) {
  .results-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Сборка**

Run: `npm run build`
Expected: сборка успешна.

- [ ] **Step 3: Commit**

```bash
git add src/styles/app.css
git commit -m "feat(phase3): стили лидербордов, race-pills, финиш-топ-10"
```

---

## Task 6: Тестовые данные + e2e-смоук + очистка + фиксация

**Files:**
- Modify: `MEMORY.md`

- [ ] **Step 1: Засеять тестовые данные (cloud-direct)**

Открывает R21 (Qatar), заводит 3 фикстур-игрока с разными прогнозами, заносит результат → гонка зачётная. Run из `scripts/db`:

Run (PowerShell): `cd scripts/db; node runner.js sql "do \$\$ declare v_race bigint; ids text[]; actual jsonb; A uuid:='aaaaaaaa-0000-0000-0000-000000000001'; B uuid:='aaaaaaaa-0000-0000-0000-000000000002'; C uuid:='aaaaaaaa-0000-0000-0000-000000000003'; begin select id into v_race from races where season=2026 and round=21; perform public.open_race(v_race); select array_agg(id) into ids from (select id from drivers where active order by standing nulls last, code limit 10) t; actual := to_jsonb(ids); insert into auth.users(id,email) values (A,'seedA@t.io'),(B,'seedB@t.io'),(C,'seedC@t.io') on conflict do nothing; insert into public.users(id,display_name,is_admin) values (A,'Тест-Ало',false),(B,'Тест-Бет',false),(C,'Тест-Гам',false) on conflict do nothing; insert into predictions(user_id,race_id,positions) values (A,v_race,to_jsonb(ids)), (B,v_race,to_jsonb(array[ids[2],ids[1],ids[3],ids[4],ids[5],ids[6],ids[7],ids[8],ids[9],ids[10]])), (C,v_race,to_jsonb(array[ids[10],ids[9],ids[8],ids[7],ids[6],ids[5],ids[4],ids[3],ids[2],ids[1]])) on conflict (user_id,race_id) do update set positions=excluded.positions; perform public.set_race_result(v_race, actual, null); end \$\$;"`

Then verify: `node runner.js sql "select u.display_name, sc.points, sc.exact_hits from scores sc join users u on u.id=sc.user_id join races r on r.id=sc.race_id where r.round=21 order by sc.points desc"`
Expected: три строки — Тест-Ало (131, 10 — перфект), Тест-Бет (меньше, swap 1-2), Тест-Гам (низко, реверс). Разные очки.

- [ ] **Step 2: Запустить dev-сервер**

Run (PowerShell): `npx vite --host 0.0.0.0`
Expected: `http://localhost:5173/f1-predict/`.

- [ ] **Step 3: Ручной e2e-смоук (в браузере, под `prokol35@gmail.com`)**

1. **Зачёт:** вкладка «Зачёт» → лидерборд: Тест-Ало 1-е место (золото, 131), Тест-Бет 2-е, Тест-Гам 3-е (бронза), админ Dima_k — ниже с 0 (прогноза на R21 нет). Проверить: очки/точные/лучшая совпадают, тайбрейкер логичен, подсветка «ты» на своей строке.
2. **Результаты:** вкладка «Результаты» → в селекторе R21 Qatar (последняя resulted) выбрана → слева топ-10 (коды + полосы цветом команды, подиум золотом), справа очки трёх игроков (сорт по очкам). Смена гонки в pills работает (если resulted одна — только R21).
3. **Пустые состояния:** (проверятся автоматически после очистки в Step 5 — Зачёт/Результаты снова покажут заглушки).

Expected: всё совпадает с известными очками фикстур. Если расхождение в ранжировании — баг в `standings.ts`, починить до коммита.

- [ ] **Step 4: Проверить сборку**

Run (PowerShell): `npm run build`
Expected: зелёная.

- [ ] **Step 5: Полностью удалить фикстуры и откатить R21 в demo**

Run (PowerShell): `cd scripts/db; node runner.js sql "do \$\$ declare v_race bigint; A uuid:='aaaaaaaa-0000-0000-0000-000000000001'; B uuid:='aaaaaaaa-0000-0000-0000-000000000002'; C uuid:='aaaaaaaa-0000-0000-0000-000000000003'; begin select id into v_race from races where season=2026 and round=21; delete from result_changes where race_id=v_race; delete from results where race_id=v_race; delete from predictions where race_id=v_race and user_id in (A,B,C); delete from race_driver_pool where race_id=v_race; update races set status='demo', scored=false where id=v_race; delete from public.users where id in (A,B,C); delete from auth.users where id in (A,B,C); end \$\$;"`

Then verify cleanup: `node runner.js sql "select r.status, r.scored, (select count(*) from results where race_id=r.id) res, (select count(*) from predictions where race_id=r.id) preds, (select count(*) from race_driver_pool where race_id=r.id) pool from races r where r.round=21"`
Expected: `demo`, `false`, res=0, preds=0, pool=0. И `select count(*) from users where display_name like 'Тест-%'` → 0.

- [ ] **Step 6: Обновить `MEMORY.md`**

Modify `MEMORY.md` — в «Статус проекта» отметить, что Фаза 3 закрыта (Зачёт+Результаты, витрина очков; drift-chart отложен), и добавить запись в «Лог сессий» (2026-07-14): Фаза 3 через subagent-driven с конституцией, смоук на фикстурах R21 пройден и очищен, ветка `phase3`. **MVP (Фазы 0–3) играбелен.**

- [ ] **Step 7: Commit**

```bash
git add MEMORY.md
git commit -m "docs(phase3): e2e-смоук пройден (фикстуры очищены), журнал обновлён"
```

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:**
- §5 db.ts (getScores/listUsers/listDrivers) → Task 1.
- §6 standings.ts (aggregateStandings + тайбрейкер) → Task 2.
- §7 Зачёт (лидерборд, подиум, «ты», пустое состояние) → Task 3, стили Task 5.
- §8 Результаты (селектор resulted, топ-10, очки игроков, пустое состояние) → Task 4, стили Task 5.
- §9 тесты (сид/смоук/очистка, R21 фикстуры) → Task 6.

**Плейсхолдеры:** нет — весь код и SQL приведены целиком.

**Согласованность типов/имён:** `Score {user_id,race_id,points,exact_hits}` и `LeagueUser {id,display_name}` (Task 1) совпадают с использованием в `standings.ts` (Task 2), `Standings.tsx` (Task 3), `Results.tsx` (Task 4). `aggregateStandings(scores, users, scoredRaceIds)` / `StandingRow` — единая сигнатура Task 2 ↔ Task 3. `getScores`/`listUsers`/`listDrivers`/`getResult` — имена из db.ts совпадают с вызовами. CSS-классы (`page-h1`, `lb*`, `race-pills`, `pill`, `finish*`, `results-grid`) из Task 5 совпадают с эмитом в Task 3/4.
