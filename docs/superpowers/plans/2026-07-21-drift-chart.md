# Drift Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-race, per-player canvas diagram on the «Результаты» screen showing predicted vs actual top-10 positions with Bezier curves colored by accuracy, plus a summary and legend.

**Architecture:** Pure frontend addition — no schema/RLS changes. A new `src/lib/scoring.ts` reimplements the points formula (source of truth stays in SQL `score_prediction`, this is display-only) to produce a per-slot breakdown; a new `src/lib/db.ts` function fetches any player's prediction for a race (RLS already allows this after deadline); a new `src/components/DriftChart.tsx` draws the canvas; `src/pages/Results.tsx` gets a player-selector row and renders the chart below the existing finish/scores block.

**Tech Stack:** React 18 + TypeScript, Supabase JS client, plain HTML5 Canvas (no charting library — matches project's zero-extra-deps convention). Tests run via Node's native TypeScript support (`node --experimental-strip-types`, Node 22+) — no test framework added, consistent with the project having none on the frontend today.

---

## File structure

- **Create** `src/lib/scoring.ts` — `WEIGHTS` constant, `scoreSlot()`, `scoreDriftSlots()`, `DriftSlot`/`SlotAccuracy` types.
- **Create** `src/lib/scoring.test.ts` — plain assertion checks for the above (no framework).
- **Modify** `tsconfig.json` — add `allowImportingTsExtensions: true` so the test file's explicit `.ts` import specifier (required for `node --experimental-strip-types` to resolve it) type-checks under `tsc -b` during `npm run build`.
- **Modify** `src/lib/db.ts` — add `getPrediction(raceId, userId)`.
- **Create** `src/components/DriftChart.tsx` — canvas component.
- **Modify** `src/pages/Results.tsx` — player-selector row + `DriftChart` wiring.
- **Modify** `src/styles/app.css` — drift chart styles (player pills reuse the existing `.race-pills`/`.pill` classes, no new CSS needed for those).

---

### Task 1: Scoring breakdown (`scoring.ts`)

**Files:**
- Create: `src/lib/scoring.ts`
- Create: `src/lib/scoring.test.ts`
- Modify: `tsconfig.json:1-20`

- [ ] **Step 1: Write the failing test**

Create `src/lib/scoring.test.ts`:

```ts
import { scoreSlot, scoreDriftSlots, WEIGHTS } from './scoring.ts';

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: получено ${a}, ожидалось ${e}`);
  console.log(`OK ${label}`);
}

check('точное попадание', scoreSlot(1, 1), { points: WEIGHTS[0] + 3, exact: true });
check('промах на 1 позицию', scoreSlot(1, 2), { points: WEIGHTS[0] - 2, exact: false });
check('вне топ-10', scoreSlot(3, null), { points: 0, exact: false });
check('далёкий промах не уходит в минус', scoreSlot(10, 1), { points: 0, exact: false });

const slots = scoreDriftSlots(['a', 'b', 'c'], ['b', 'a', 'c']);
check('разбивка: длина', slots.length, 3);
check('разбивка: accuracy', slots.map((s) => s.accuracy), ['near', 'near', 'exact']);
check('разбивка: очки за точное', slots[2].points, WEIGHTS[2] + 3);

console.log('scoring.test.ts: все проверки прошли');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types src/lib/scoring.test.ts`
Expected: FAIL — `Cannot find module './scoring.ts'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/scoring.ts`:

```ts
// Формула из конституции §1: вес заявленной позиции, штраф 2·|X−Y|, бонус +3 за точное, min 0.
// Источник истины по итоговым очкам — SQL score_prediction (supabase/migrations/0002_scoring.sql).
// Здесь — только для разбивки по слотам, нужной drift chart (подписи очков, раскраска линий).
export const WEIGHTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export type SlotAccuracy = 'exact' | 'near' | 'close' | 'miss';

export interface DriftSlot {
  code: string;
  predictedPos: number;
  actualPos: number | null;
  points: number;
  accuracy: SlotAccuracy;
}

export function scoreSlot(y: number, x: number | null): { points: number; exact: boolean } {
  if (x === null) return { points: 0, exact: false };
  const diff = Math.abs(x - y);
  let points = Math.max(0, WEIGHTS[y - 1] - 2 * diff);
  const exact = x === y;
  if (exact) points += 3;
  return { points, exact };
}

export function scoreDriftSlots(prediction: string[], actual: string[]): DriftSlot[] {
  return prediction.map((code, i) => {
    const y = i + 1;
    const actualIndex = actual.indexOf(code);
    const x = actualIndex === -1 ? null : actualIndex + 1;
    const { points, exact } = scoreSlot(y, x);
    const accuracy: SlotAccuracy =
      x === null ? 'miss' : exact ? 'exact' : Math.abs(x - y) === 1 ? 'near' : points > 0 ? 'close' : 'miss';
    return { code, predictedPos: y, actualPos: x, points, accuracy };
  });
}
```

- [ ] **Step 4: Allow `.ts` import extensions so `tsc -b` accepts the test file**

In `tsconfig.json`, add `"allowImportingTsExtensions": true` inside `compilerOptions` (valid because `noEmit` is already `true`):

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types src/lib/scoring.test.ts`
Expected: PASS — 7 lines of `OK ...`, ending with `scoring.test.ts: все проверки прошли`. (An `ExperimentalWarning: Type Stripping...` line to stderr is expected and harmless.)

- [ ] **Step 6: Verify the build still type-checks**

Run: `npm run build`
Expected: succeeds (`tsc -b` passes including `scoring.test.ts`, then `vite build`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/scoring.ts src/lib/scoring.test.ts tsconfig.json
git commit -m "feat(results): разбивка очков по слотам для drift chart"
```

---

### Task 2: Fetch any player's prediction (`db.ts`)

**Files:**
- Modify: `src/lib/db.ts:74-81` (right after the existing `getMyPrediction`)

- [ ] **Step 1: Add `getPrediction`**

In `src/lib/db.ts`, immediately after the `getMyPrediction` function (after line 81), add:

```ts
// Прогноз конкретного игрока на гонку (для drift chart на экране "Результаты").
// RLS: pred_select_after_deadline открывает чужие прогнозы после дедлайна —
// для resulted-гонок дедлайн всегда уже прошёл, так что это всегда читаемо.
export async function getPrediction(raceId: number, userId: string): Promise<string[] | null> {
  return withRetry(async () => {
    const { data, error } = await supabase
      .from('predictions').select('positions').eq('race_id', raceId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data ? (data.positions as string[]) : null;
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(results): getPrediction — прогноз произвольного игрока на гонку"
```

---

### Task 3: Drift chart component

**Files:**
- Create: `src/components/DriftChart.tsx`

(Check first whether `src/components/` exists — if not, create it as part of this task; no `index.ts` barrel needed, this project imports components directly by path.)

- [ ] **Step 1: Write the component**

Create `src/components/DriftChart.tsx`:

```tsx
import { useEffect, useMemo, useRef } from 'react';
import type { Driver } from '../lib/types';
import { scoreDriftSlots, type DriftSlot } from '../lib/scoring';

const WIDTH = 560;
const ROW_H = 32;
const TOP = 36;
const HEIGHT = TOP + ROW_H * 10 + 16;
const LEFT_X = 150;
const RIGHT_X = 410;

const ACCURACY_COLOR: Record<DriftSlot['accuracy'], string> = {
  exact: '#4ade80',
  near: '#00E5FF',
  close: '#E8C15A',
  miss: '#5a6273',
};

interface DriftChartProps {
  prediction: string[] | null;
  actual: string[];
  drivers: Map<string, Driver>;
  playerName: string;
  raceName: string;
  points: number;
  exactHits: number;
}

export default function DriftChart({
  prediction, actual, drivers, playerName, raceName, points, exactHits,
}: DriftChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slots = useMemo(
    () => (prediction ? scoreDriftSlots(prediction, actual) : []),
    [prediction, actual],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !prediction) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    ctx.font = '700 12px "Titillium Web", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#00E5FF';
    ctx.fillText('ПРОГНОЗ', LEFT_X, 18);
    ctx.fillStyle = '#FF2E63';
    ctx.fillText('ФАКТ', RIGHT_X, 18);

    const cpX = (LEFT_X + RIGHT_X) / 2;

    slots.forEach((slot, i) => {
      const yLeft = TOP + i * ROW_H + ROW_H / 2;
      const yRight = slot.actualPos !== null ? TOP + (slot.actualPos - 1) * ROW_H + ROW_H / 2 : yLeft;
      const color = ACCURACY_COLOR[slot.accuracy];
      const driver = drivers.get(slot.code);
      const dotColor = driver?.team_color || '#888';

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(slot.accuracy === 'miss' ? [4, 4] : []);
      ctx.beginPath();
      ctx.moveTo(LEFT_X, yLeft);
      ctx.bezierCurveTo(cpX, yLeft, cpX, yRight, RIGHT_X, yRight);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = color;
      ctx.font = '700 11px "Titillium Web", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(slot.points > 0 ? `+${slot.points}` : '0', cpX, Math.min(yLeft, yRight) - 8);

      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(LEFT_X, yLeft, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e8ebf2';
      ctx.font = '700 12px "Titillium Web", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(slot.code.toUpperCase(), LEFT_X - 14, yLeft + 4);
      ctx.fillStyle = '#8A93A6';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`P${slot.predictedPos}`, 12, yLeft + 4);

      if (slot.actualPos !== null) {
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(RIGHT_X, yRight, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e8ebf2';
        ctx.font = '700 12px "Titillium Web", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${slot.code.toUpperCase()} · P${slot.actualPos}`, RIGHT_X + 14, yRight + 4);
      } else {
        ctx.strokeStyle = '#5a6273';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(RIGHT_X, yRight, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#5a6273';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('мимо топ-10', RIGHT_X + 14, yRight + 4);
      }
    });
  }, [prediction, slots, drivers]);

  if (!prediction) {
    return <div className="drift-empty">{playerName} не поставил(а) прогноз на эту гонку.</div>;
  }

  const withActual = slots.filter((s) => s.actualPos !== null);
  const avgMiss = withActual.length
    ? (
        withActual.reduce((sum, s) => sum + Math.abs((s.actualPos as number) - s.predictedPos), 0) /
        withActual.length
      ).toFixed(1)
    : '—';

  return (
    <div className="drift">
      <h3 className="drift-title">
        Прогноз {playerName} vs факт · {raceName} — {points} очков
      </h3>
      <div className="drift-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <div className="drift-summary">
        <div className="drift-card"><span className="drift-card-v">{points}</span><span className="drift-card-l">очков</span></div>
        <div className="drift-card"><span className="drift-card-v">{exactHits}</span><span className="drift-card-l">точных</span></div>
        <div className="drift-card"><span className="drift-card-v">{avgMiss}</span><span className="drift-card-l">средний промах</span></div>
        <div className="drift-card"><span className="drift-card-v">{withActual.length}/10</span><span className="drift-card-l">в топ-10</span></div>
      </div>
      <div className="drift-legend">
        <span><i className="drift-dot" style={{ background: '#4ade80' }} /> точно</span>
        <span><i className="drift-dot" style={{ background: '#00E5FF' }} /> ±1</span>
        <span><i className="drift-dot" style={{ background: '#E8C15A' }} /> близко</span>
        <span><i className="drift-dot" style={{ background: '#5a6273' }} /> мимо</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds. (`DriftChart` isn't imported anywhere yet, so TS may report it as unused only if `noUnusedLocals` applied to unreferenced exports — it doesn't, that rule is for locals/params within a file, so this is fine standalone.)

- [ ] **Step 3: Commit**

```bash
git add src/components/DriftChart.tsx
git commit -m "feat(results): компонент DriftChart — canvas прогноз vs факт"
```

---

### Task 4: Styles

**Files:**
- Modify: `src/styles/app.css:148-152`

- [ ] **Step 1: Add drift chart styles**

In `src/styles/app.css`, right after the `.finish-name` rule (line 148) and before the existing `@media (max-width: 640px)` block, insert:

```css

.drift { margin-top: 20px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.drift-title { font-family: 'Titillium Web'; font-weight: 700; font-size: 15px; margin: 0 0 12px; }
.drift-canvas-wrap { overflow-x: auto; }
.drift-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 14px; }
.drift-card { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; text-align: center; display: flex; flex-direction: column; gap: 2px; }
.drift-card-v { font-family: 'Titillium Web'; font-weight: 700; font-size: 20px; }
.drift-card-l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.drift-legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; color: var(--muted); }
.drift-legend span { display: inline-flex; align-items: center; gap: 6px; }
.drift-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.drift-empty { margin-top: 20px; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; padding: 20px; text-align: center; }
```

Then extend the existing mobile media query (was lines 150-152, now shifted down by the inserted block) to stack the summary cards two-per-row on narrow screens:

```css
@media (max-width: 640px) {
  .results-grid { grid-template-columns: 1fr; }
  .drift-summary { grid-template-columns: repeat(2, 1fr); }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/app.css
git commit -m "style(results): стили drift chart"
```

---

### Task 5: Wire into the Results page

**Files:**
- Modify: `src/pages/Results.tsx` (full file, 137 lines — rewritten below)

- [ ] **Step 1: Rewrite `src/pages/Results.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { listRaces, getResult, getScores, listUsers, listDrivers, getPrediction } from '../lib/db';
import type { Race, Driver, Score, LeagueUser } from '../lib/types';
import { supabase } from '../lib/supabase';
import DriftChart from '../components/DriftChart';

export default function Results() {
  const [races, setRaces] = useState<Race[] | null>(null);
  const [drivers, setDrivers] = useState<Map<string, Driver>>(new Map());
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [leagueUsers, setLeagueUsers] = useState<LeagueUser[]>([]);
  const [scores, setScores] = useState<Score[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [selPlayer, setSelPlayer] = useState<string | null>(null);
  const [positions, setPositions] = useState<string[] | null>(null);
  const [prediction, setPrediction] = useState<string[] | null>(null);
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
      setLeagueUsers(us);
      setScores(sc);
      const me = userRes.data.user?.id ?? null;
      setMeId(me);
      setSelPlayer(me);
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

  useEffect(() => {
    if (sel == null || selPlayer == null) {
      setPrediction(null);
      return;
    }
    getPrediction(sel, selPlayer).then(setPrediction).catch(() => setPrediction(null));
  }, [sel, selPlayer]);

  const resulted = useMemo(
    () => (races ?? []).filter((r) => r.status === 'resulted').sort((a, b) => b.round - a.round),
    [races],
  );
  const raceScores = useMemo(
    () => scores.filter((s) => s.race_id === sel).sort((a, b) => b.points - a.points),
    [scores, sel],
  );
  const selRace = useMemo(() => resulted.find((r) => r.id === sel) ?? null, [resulted, sel]);
  const selPlayerScore = useMemo(
    () => raceScores.find((s) => s.user_id === selPlayer) ?? null,
    [raceScores, selPlayer],
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
      <h2 className="col-h">Игрок</h2>
      <div className="race-pills">
        {leagueUsers.map((u) => (
          <button
            key={u.id}
            className={'pill' + (u.id === selPlayer ? ' pill-on' : '')}
            onClick={() => setSelPlayer(u.id)}
          >
            {u.display_name}{u.id === meId ? ' (ты)' : ''}
          </button>
        ))}
      </div>
      {selRace && selPlayer && (
        <DriftChart
          prediction={prediction}
          actual={positions ?? []}
          drivers={drivers}
          playerName={users.get(selPlayer) ?? '—'}
          raceName={selRace.name}
          points={selPlayerScore?.points ?? 0}
          exactHits={selPlayerScore?.exact_hits ?? 0}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Results.tsx
git commit -m "feat(results): переключатель игрока + drift chart на экране Результаты"
```

---

### Task 6: End-to-end verification on real data + branch review

No fixtures needed — round 10 (Belgian GP) is a real, already-scored race with 2 real predictions in production. This is a read-only feature (no writes), so no cleanup is required afterward.

- [ ] **Step 1: Run the dev server**

Run: `npm run dev`
Open the printed local URL, log in, go to «Результаты».

- [ ] **Step 2: Verify against Belgian GP (round 10)**

- Select R10 · Belgian (should be selected by default — it's the only resulted+scored race).
- Confirm the player pills row shows both real players (2 predictions exist per the earlier DB check); default selection is "you".
- For each of the 2 real players, click their pill and confirm:
  - The 4 summary cards' "очков" value matches that player's row in the "Очки за гонку" table above.
  - Every line's `+N` label, summed across all 10, equals that same points total.
  - Exact hits (green lines) count matches the "Точных" column.
- Click through the demo races (round 1-9) — player pills should still render, but selecting any player should show the "не поставил(а) прогноз" placeholder (0 predictions exist for those races, confirmed via DB query during design).
- Resize the browser to a narrow (mobile) width — canvas should stay full-size and scroll horizontally inside its wrapper rather than squeezing; summary cards should reflow to 2 columns.

- [ ] **Step 3: Fix any discrepancies found**

If the on-screen point sum doesn't match the table, the bug is almost certainly in `scoreSlot`/`scoreDriftSlots` in `src/lib/scoring.ts` diverging from `score_prediction` in `supabase/migrations/0002_scoring.sql` — compare the two formulas directly. Fix and re-run `npm run build` before re-verifying.

- [ ] **Step 4: Update `docs/plan.md` backlog entry**

In `docs/plan.md` §15, change the `[ЗАПИСАНО 2026-07-20, ВАЖНО] Drift chart` bullet to mark it done — replace the tag with `[СДЕЛАНО 2026-07-21]` and keep the rest of the sentence describing what was built (it still accurately describes the shipped feature).

- [ ] **Step 5: Update `MEMORY.md`**

Add a session-log entry under 2026-07-21 noting: drift chart shipped on Results screen (player selector + canvas), verified against real Belgium GP predictions, backlog item closed.

- [ ] **Step 6: Commit docs**

```bash
git add docs/plan.md MEMORY.md
git commit -m "docs: drift chart — закрыт бэклог, журнал"
```

- [ ] **Step 7: Final branch review**

Before merging to `main`: review the full diff for this feature end-to-end (spec-compliance — does the implementation match `docs/superpowers/specs/2026-07-21-drift-chart-design.md`? — and code-quality). Then proceed via `finishing-a-development-branch`.
