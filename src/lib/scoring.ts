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
