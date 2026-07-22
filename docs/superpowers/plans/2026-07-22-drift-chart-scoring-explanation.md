# Объяснение начисления очков в drift chart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Под легендой цветов точности в `DriftChart.tsx` добавить сворачиваемую подсказку «Почему такие очки?», которая по клику раскрывает объяснение формулы с примером.

**Architecture:** Один новый `useState<boolean>` в компоненте `DriftChart`, один toggle-элемент и один условно рендерящийся абзац текста в JSX, два новых CSS-класса по образцу существующих `.drift-*`. Ни данные, ни другие компоненты не затрагиваются — чисто презентационное изменение одного файла + стили.

**Tech Stack:** React (TSX), CSS (существующие CSS-переменные `--volt`/`--muted` из `src/styles/app.css`).

---

### Task 1: Toggle «Почему такие очки?» + стили

**Files:**
- Modify: `src/components/DriftChart.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: Добавить состояние toggle**

В `src/components/DriftChart.tsx` заменить строку 32:

```tsx
  const canvasRef = useRef<HTMLCanvasElement>(null);
```

на:

```tsx
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [explainOpen, setExplainOpen] = useState(false);
```

Обновить импорт хуков (строка 1) — добавить `useState`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
```

- [ ] **Step 2: Добавить toggle и текст под легендой**

Заменить конец JSX-разметки (сейчас строки 156-162):

```tsx
      <div className="drift-legend">
        <span><i className="drift-dot" style={{ background: '#4ade80' }} /> точно</span>
        <span><i className="drift-dot" style={{ background: '#00E5FF' }} /> ±1</span>
        <span><i className="drift-dot" style={{ background: '#E8C15A' }} /> близко</span>
        <span><i className="drift-dot" style={{ background: '#5a6273' }} /> мимо / 0 очков</span>
      </div>
    </div>
  );
}
```

на:

```tsx
      <div className="drift-legend">
        <span><i className="drift-dot" style={{ background: '#4ade80' }} /> точно</span>
        <span><i className="drift-dot" style={{ background: '#00E5FF' }} /> ±1</span>
        <span><i className="drift-dot" style={{ background: '#E8C15A' }} /> близко</span>
        <span><i className="drift-dot" style={{ background: '#5a6273' }} /> мимо / 0 очков</span>
      </div>
      <button className="drift-explain-toggle" onClick={() => setExplainOpen((v) => !v)}>
        Почему такие очки? {explainOpen ? '▴' : '▾'}
      </button>
      {explainOpen && (
        <p className="drift-explain-text">
          Очки зависят от места, на которое ты поставил пилота, а не от того, где он финишировал на
          самом деле. Например: поставил на P9 (макс. 2 очка) и промахнулся на 2 позиции — штраф
          съедает всё, будет 0. А промах на P1 (25 очков) прощается щедрее.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Добавить стили**

В `src/styles/app.css` сразу после блока стилей drift chart (после строки `.drift-empty { ... }`,
идущей за `.drift-dot`) добавить:

```css
.drift-explain-toggle { display: block; margin-top: 10px; background: none; border: none; padding: 0; color: var(--volt); font-size: 12px; cursor: pointer; }
.drift-explain-text { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
```

- [ ] **Step 4: Проверить типы и сборку**

Run: `npx tsc --noEmit`
Expected: без ошибок (нет пре-существующих ошибок в проекте, новых тоже быть не должно).

- [ ] **Step 5: Ручная проверка в браузере**

Run: `npm run dev`
Открыть «Результаты» на `http://localhost:5173` (или порт, который выведет Vite), выбрать гонку с
прогнозом (например Бельгия, round 10). Под легендой цветов должна появиться ссылка
«Почему такие очки? ▾». Проверить:
- По клику раскрывается абзац текста, стрелка меняется на ▴.
- Повторный клик сворачивает текст обратно, стрелка возвращается на ▾.
- На узкой ширине окна (мобильная эмуляция в devtools, ~375px) текст читается, не переполняет
  контейнер.

- [ ] **Step 6: Commit**

```bash
git add src/components/DriftChart.tsx src/styles/app.css
git commit -m "feat(results): сворачиваемая подсказка \"Почему такие очки?\" в drift chart"
```
