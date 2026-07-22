# Страница «Правила» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Новая вкладка «Правила» (`/rules`) с полным изложением формулы очков, таблицей весов, 7 примерами с эмодзи, стратегией и тайбрейкером сезона.

**Architecture:** Один новый статический React-компонент `src/pages/Rules.tsx` (без запросов к БД — весь контент захардкожен как константы прямо в файле, таблица весов рендерится из уже существующего `WEIGHTS` в `src/lib/scoring.ts`, а не дублируется). Подключается новым роутом в `src/App.tsx` и новой вкладкой в `src/components/Shell.tsx`. Новый блок CSS-классов `.rules-*` в `src/styles/app.css` по образцу уже существующих `.drift-*`/`.lb`.

**Tech Stack:** React (TSX), React Router (`react-router-dom`), CSS (существующие переменные `--panel`, `--panel2`, `--line`, `--volt`, `--muted`, `--txt`).

---

### Task 1: Страница «Правила» + подключение в навигацию

**Files:**
- Create: `src/pages/Rules.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Shell.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: Создать компонент страницы**

Создать `src/pages/Rules.tsx`:

```tsx
import { WEIGHTS } from '../lib/scoring';

interface RuleExample {
  emoji: string;
  title: string;
  desc: string;
  result: string;
}

const EXAMPLES: RuleExample[] = [
  { emoji: '🎯', title: 'Точно.', desc: 'Норрис на P1, приехал P1', result: '25 + 3 = 28' },
  { emoji: '👍', title: 'Почти точно (ошибка 1 место).', desc: 'Леклер на P2, приехал P3', result: '18 − 2 = 16' },
  { emoji: '📉', title: 'Недооценил.', desc: 'Расселл на P5, приехал P2', result: '10 − 6 = 4' },
  { emoji: '📈', title: 'Переоценил, но не зря.', desc: 'Ферстаппен на P1, приехал P4', result: '25 − 6 = 19' },
  { emoji: '💥', title: 'Большой промах.', desc: 'Гасли на P3, приехал P9', result: '15 − 12 = 3' },
  { emoji: '❌', title: 'Мимо топ-10.', desc: 'Боттас на P8, финишировал 14-м', result: '0' },
  { emoji: '🕳️', title: 'Обрезано до нуля.', desc: 'Алонсо на P10, приехал P3', result: '1 − 14 = −13 → 0' },
];

const STRATEGY: string[] = [
  'Рисковать наверху выгодно: даже промах на P1 (25 базовых очков) при ошибке в 3 места всё равно даёт 19 очков.',
  'Внизу жёстче: P10 стоит всего 1 очко, точное попадание — 4 (1+3), а промах даже на 1 место — уже 0.',
  'Главный скилл — угадать не только КТО попадёт в топ-10, но и НА КАКОМ МЕСТЕ. Состав без правильного порядка почти ничего не стоит.',
  'Реалистично хороший результат за гонку — 70–90 очков из максимума 131.',
];

export default function Rules() {
  return (
    <div className="rules">
      <h1 className="rules-title">🏁 Как считаются очки</h1>

      <div className="rules-table-wrap">
        <table className="rules-table">
          <thead>
            <tr>
              {WEIGHTS.map((_, i) => (
                <th key={i}>P{i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {WEIGHTS.map((w, i) => (
                <td key={i}>{w}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <pre className="rules-formula">{`очки = вес(твоей позиции) − 2 × |реальная позиция − твоя позиция|
если попал ТОЧНО — плюс 3 очка
очки не бывают отрицательными — минимум 0`}</pre>

      <p className="rules-why">
        Очки считаются по позиции, на которую ты поставил пилота (Y), а не по той, что он занял на
        самом деле (X). Так награждается смелость и точность твоей ставки: поставил на P1 и угадал —
        получаешь ценность P1. Если бы считали по факту, было бы выгоднее угадывать очевидного
        фаворита на первом месте, а сложные ставки в середине и хвосте почти ничего бы не стоили.
      </p>

      <div className="rules-examples">
        {EXAMPLES.map((ex, i) => (
          <div className="rules-example" key={i}>
            <span className="rules-example-emoji">{ex.emoji}</span>
            <div>
              <strong>{ex.title}</strong> {ex.desc} → <code>{ex.result}</code>
            </div>
          </div>
        ))}
      </div>

      <h2 className="col-h">🧠 Стратегия</h2>
      <ul className="rules-strategy">
        {STRATEGY.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>

      <p className="rules-tiebreak">
        🏆 <strong>Тайбрейкер сезона:</strong> при равной сумме очков за сезон решает — сначала у кого
        больше точных попаданий (когда предсказанное место совпало с реальным), если и это равно — у
        кого лучший результат в одной отдельной гонке.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Подключить роут**

В `src/App.tsx` добавить импорт сразу после `import Results from './pages/Results';` (строка 12):

```tsx
import Rules from './pages/Rules';
```

И добавить роут сразу после `<Route path="/results" element={<Results />} />` (строка 30):

```tsx
            <Route path="/rules" element={<Rules />} />
```

- [ ] **Step 3: Добавить вкладку в навигацию**

В `src/components/Shell.tsx` заменить массив `tabs` (строки 4-9):

```tsx
const tabs = [
  { to: '/calendar', label: 'Календарь' },
  { to: '/predict', label: 'Прогноз' },
  { to: '/standings', label: 'Зачёт' },
  { to: '/results', label: 'Результаты' },
];
```

на:

```tsx
const tabs = [
  { to: '/calendar', label: 'Календарь' },
  { to: '/predict', label: 'Прогноз' },
  { to: '/standings', label: 'Зачёт' },
  { to: '/results', label: 'Результаты' },
  { to: '/rules', label: 'Правила' },
];
```

- [ ] **Step 4: Добавить стили**

В `src/styles/app.css` добавить перед блоком `@media (max-width: 640px) { ... }` (сейчас начинается на
строке 164, сразу после `.drift-explain-text { ... }`):

```css
.rules { max-width: 760px; }
.rules-title { font-family: 'Titillium Web'; font-weight: 700; font-size: 24px; margin: 0 0 16px; }
.rules-table-wrap { overflow-x: auto; margin-bottom: 16px; }
.rules-table { width: 100%; min-width: 480px; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.rules-table th, .rules-table td { text-align: center; padding: 8px; border-bottom: 1px solid var(--line); font-size: 13px; }
.rules-table th { font-family: 'Titillium Web'; font-weight: 700; color: var(--muted); text-transform: uppercase; font-size: 11px; }
.rules-table td { font-family: 'Titillium Web'; font-weight: 700; }
.rules-formula { background: var(--panel); border-left: 3px solid var(--volt); border-radius: 8px; padding: 12px 14px; font-family: 'Titillium Web', monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; margin: 0 0 16px; }
.rules-why { color: var(--muted); font-size: 13px; line-height: 1.6; margin: 0 0 20px; }
.rules-examples { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.rules-example { display: flex; gap: 10px; align-items: flex-start; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
.rules-example-emoji { font-size: 18px; flex: 0 0 auto; }
.rules-example code { background: var(--panel2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.rules-strategy { color: var(--muted); font-size: 13px; line-height: 1.7; margin: 0 0 20px; padding-left: 20px; }
.rules-tiebreak { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; font-size: 13px; line-height: 1.6; }
```

Также добавить `.rules-table` в существующий мобильный `@media (max-width: 640px)` блок не требуется —
горизонтальный скролл уже обеспечен `.rules-table-wrap` (тот же паттерн, что `.drift-canvas-wrap`).

- [ ] **Step 5: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 6: Ручная проверка в браузере**

Run: `npm run dev`
Открыть приложение, залогиниться, убедиться что в навигации появилась вкладка «Правила» последней.
Перейти на неё, проверить:
- Заголовок «🏁 Как считаются очки».
- Таблица весов показывает 10 значений `25 18 15 12 10 8 6 4 2 1` под заголовками P1–P10.
- Блок формулы читается, моноширинный.
- Абзац «почему по ставке, а не по факту» на месте.
- Все 7 примеров показаны с эмодзи, именами пилотов и правильными числами (28, 16, 4, 19, 3, 0, 0).
- Раздел «🧠 Стратегия» — 4 пункта списком.
- Блок «🏆 Тайбрейкер сезона» в конце.
- Сузить окно до ~375px (мобильная эмуляция в devtools) — таблица весов скроллится по горизонтали
  вместо того чтобы сжимать текст в нечитаемое, остальной текст переносится нормально.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Rules.tsx src/App.tsx src/components/Shell.tsx src/styles/app.css
git commit -m "feat: страница «Правила» — как считаются очки"
```
