// Тест чистой логики predict.js (без сети/БД): валидация ответа модели и фолбэк-эвристика.
const { isValidTop10, fallbackTop10, escapeHtml } = require('./predict');

const pool = [
  { id: 'd1', code: 'VER', standing: 1 },
  { id: 'd2', code: 'NOR', standing: 2 },
  { id: 'd3', code: 'LEC', standing: 3 },
  { id: 'd4', code: 'HAM', standing: 4 },
  { id: 'd5', code: 'PIA', standing: 5 },
  { id: 'd6', code: 'RUS', standing: 6 },
  { id: 'd7', code: 'SAI', standing: 7 },
  { id: 'd8', code: 'ALO', standing: null },
  { id: 'd9', code: 'GAS', standing: null },
  { id: 'd10', code: 'STR', standing: 8 },
  { id: 'd11', code: 'ANT', standing: 9 },
];
const validTop10 = ['VER', 'NOR', 'LEC', 'HAM', 'PIA', 'RUS', 'SAI', 'ALO', 'GAS', 'STR'];

const cases = [
  ['валидный топ-10 из пула', isValidTop10(validTop10, pool), true],
  ['не 10 элементов', isValidTop10(validTop10.slice(0, 9), pool), false],
  ['дубль вместо одного из кодов', isValidTop10([...validTop10.slice(0, 9), 'VER'], pool), false],
  ['код не из пула', isValidTop10([...validTop10.slice(0, 9), 'XXX'], pool), false],
  ['не массив', isValidTop10('VER,NOR', pool), false],
];

let pass = 0, fail = 0;
for (const [name, actual, expected] of cases) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ожидали ${expected}, получили ${actual}`);
}

const fb = fallbackTop10(pool);
{
  // 9 гонщиков с реальным standing (VER..ANT) + ALO (standing=null, но первый по алфавиту среди
  // null) = 10; GAS (тоже null, но проигрывает ALO по алфавиту) — 11-й, за бортом топ-10.
  const ok = fb.length === 10 && fb[0] === 'VER' && fb[fb.length - 1] === 'ALO'
    && new Set(fb).size === 10 && !fb.includes('GAS');
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  fallbackTop10: топ по standing, без места — в конец  — ${fb.join('-')}`);
}

{
  const ok = escapeHtml('<b>x</b> & "y"') === '&lt;b&gt;x&lt;/b&gt; &amp; "y"';
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  escapeHtml экранирует < > &`);
}

console.log(`\nВСЕГО: ${pass} PASS, ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
