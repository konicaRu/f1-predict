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

// P9 diff=1 (weight=2 → 2-2=0 очков) должен классифицироваться как 'miss', не 'near'
check('P9 близкий промах в 0 очков -> miss', scoreSlot(9, 8), { points: 0, exact: false });
const edgeSlots = scoreDriftSlots(
  ['-', '-', '-', '-', '-', '-', '-', '-', 'x'],
  ['-', '-', '-', '-', '-', '-', '-', 'x', '-'],
);
check('P9 diff=1 с нулём очков классифицируется как miss', edgeSlots[8].accuracy, 'miss');

const closeSlots = scoreDriftSlots(['y'], ['-', '-', '-', 'y']);
check('P1 промах на 3 позиции с очками > 0 классифицируется как close', closeSlots[0].accuracy, 'close');

console.log('scoring.test.ts: все проверки прошли');
