# Drift chart — визуализация прогноз vs факт

Дата: 2026-07-21
Статус: утверждено

## Зачем

Игроки видят только итоговое число очков за гонку — непонятно, КАК оно
начислено и насколько точным был прогноз. Дизайн диаграммы уже описан в
`docs/plan.md` §16.8 (два столбца ПРОГНОЗ/ФАКТ, кривые Безье, цвет по
точности) — реализуем его. Запись в бэклоге: `docs/plan.md` §15,
`[ЗАПИСАНО 2026-07-20, ВАЖНО] Drift chart`.

Проверка не на фикстуре: Бельгия (round 10) — первая настоящая зачётная
гонка, есть реальный прогноз и результат.

## Где живёт

Встраивается в существующий экран «Результаты» (`src/pages/Results.tsx`),
под уже имеющимся блоком (факт топ-10 слева + таблица очков справа —
без изменений). Ниже добавляется:

1. Переключатель игрока — тот же паттерн, что переключатель гонки
   (`.pill`/`.pill-on`), список из `listUsers()` (уже загружается на
   странице как `users`). Дефолт — текущий пользователь (`meId`).
2. Canvas-диаграмма для пары (выбранная гонка, выбранный игрок).

Переключение гонки или игрока перезагружает прогноз выбранного игрока
и перерисовывает диаграмму.

## Данные

- `src/lib/db.ts`: новая функция
  `getPrediction(raceId: string, userId: string): Promise<string[] | null>` —
  запрос к `predictions` (`.eq('race_id', raceId).eq('user_id', userId)`).
  RLS уже открывает чужие прогнозы после дедлайна
  (`pred_select_after_deadline`), доп. политик не требуется. `null`, если
  строки нет (игрок не успел проголосовать).
- Факт-топ-10 и очки берутся из уже загруженных на странице `positions`
  (из `getResult`) и `scores` — без изменений.

## Разбивка очков по слотам

В БД есть только `score_prediction(prediction, actual)` — отдаёт общий
итог (`points`, `exact_hits`), не разбивку по позициям. Для подписей
`+28`/`+16` на линиях и раскраски диаграммы нужна разбивка по каждому
из 10 слотов — считаем на фронте.

Новый файл `src/lib/scoring.ts`:

```typescript
export const WEIGHTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export type SlotAccuracy = 'exact' | 'near' | 'close' | 'miss';

export interface DriftSlot {
  code: string;        // код пилота, заявленный в слоте Y
  predictedPos: number; // Y, 1..10
  actualPos: number | null; // X, null если пилот вне топ-10
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

Это дублирует формулу из `CLAUDE.md` (референс) чисто для отображения —
источник истины по итоговым очкам остаётся SQL (`score_prediction`,
уже используется для таблицы очков рядом). Формула зафиксирована в
конституции §1 — при её изменении нужно поправить оба места.

## Компонент диаграммы

Новый `src/components/DriftChart.tsx`:

- Props: `prediction: string[] | null`, `actual: string[]`,
  `drivers: Map<string, Driver>`, `playerName: string`, `raceName: string`,
  `points: number`, `exactHits: number`.
- Если `prediction === null` → рендерит заглушку `«{playerName} не
  поставил(а) прогноз на эту гонку»` вместо canvas.
- Иначе — canvas по спецификации `docs/plan.md` §16.8:
  - Заголовок «Прогноз {playerName} vs факт · {raceName} — {points} очков».
  - Фиксированная ширина ~560px, обёрнут в `<div style="overflow-x:auto">`
    для мобилы (горизонтальный скролл, без пересчёта геометрии).
  - Два столбца (ПРОГНОЗ cyan / ФАКТ hot), 10 строк P1–P10.
  - `bezierCurveTo` между позицией прогноза и фактической. Цвет:
    `exact` → `#4ade80`, `near` (±1) → cyan, `close` → gold, `miss`
    (мимо/вне топ-10) → серый пунктир.
  - Подпись очков слота над линией.
  - Точки — цветом команды пилота (`driver.team_color`).
  - Под canvas — 4 карточки сводки: очки, точных попаданий, средний
    промах (`avg(|X−Y|)` по слотам, где `X` есть), сколько из 10
    попали в топ-10 (`actualPos !== null`).
  - Легенда: 4 цветных точки с подписями (точно / ±1 / близко / мимо).

## Тестирование

- Unit-тест на `scoreSlot`/`scoreDriftSlots` (чистые функции) — примеры
  из конституции (точное попадание, промах на 1-2 позиции, вне топ-10).
- Ручная проверка в браузере на реальных данных: Бельгия (round 10),
  оба реальных прогноза лиги — сверить числа на диаграмме с таблицей
  очков рядом (они должны совпасть с суммой по слотам).
- TDD (тест первым) не обязателен — правило конституции §5 про TDD
  относится к бэкенду/SQL; здесь используем тесты как проверку чистой
  функции, без строгого red-green.

## Вне охвата

- Не трогаем формулу очков в SQL — только визуальное дублирование.
- Не добавляем переключатель игрока никуда, кроме экрана «Результаты».
- Демо-гонки (round 1-9) без прогнозов — переключатель игрока покажет
  заглушку «нет прогноза» для всех, это ожидаемо и не требует отдельной
  обработки.
