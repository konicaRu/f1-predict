import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildJokePrompt, buildRookiePrompt, buildVeteranPrompt, isDuplicate, similarity } from './joke.ts';
import type { JokeStats, RaceHistory } from './joke.ts';

const HISTORY: RaceHistory[] = [
  {
    round: 10,
    race_name: 'Belgian Grand Prix',
    predicted: 'ANT-HAM-PIA',
    actual: 'ANT-LEC-VER',
    points: 69,
    exact_hits: 1,
  },
  {
    round: 11,
    race_name: 'Hungarian Grand Prix',
    predicted: 'ANT-VER-HAM',
    actual: 'NOR-VER-ANT',
    points: 82,
    exact_hits: 2,
  },
];

const STATS: JokeStats = { played: 2, total: 5, avg: 76, hits: 3 };

const DRIVERS = [
  { code: 'ANT', name: 'Andrea Kimi Antonelli' },
  { code: 'HAM', name: 'Lewis Hamilton' },
  { code: 'PIA', name: 'Oscar Piastri' },
  { code: 'LEC', name: 'Charles Leclerc' },
  { code: 'VER', name: 'Max Verstappen' },
  { code: 'NOR', name: 'Lando Norris' },
  { code: 'LIN', name: 'Arvid Lindblad' },
];

Deno.test('buildJokePrompt: без истории -> промпт новичка', () => {
  const prompt = buildJokePrompt('Костя', 'Azerbaijan Grand Prix', [], STATS, DRIVERS, []);
  assertEquals(prompt, buildRookiePrompt('Костя', 'Azerbaijan Grand Prix'));
  assertStringIncludes(prompt, 'САМЫЙ ПЕРВЫЙ прогноз');
});

Deno.test('buildJokePrompt: с историей -> промпт ветерана', () => {
  const prompt = buildJokePrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []);
  assertEquals(prompt, buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []));
  assertStringIncludes(prompt, 'История его прошлых прогнозов');
});

Deno.test('buildVeteranPrompt: переносит историю и сводку в текст', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []);
  assertStringIncludes(prompt, 'Раунд 10 (Belgian Grand Prix): поставил ANT-HAM-PIA');
  assertStringIncludes(prompt, 'реальный результат ANT-LEC-VER');
  assertStringIncludes(prompt, 'получил 69 очков, точных попаданий 1');
  assertStringIncludes(prompt, 'сыграл 2 гонок из 5 возможных, пропустил 3');
  assertStringIncludes(prompt, 'в среднем 76 очков за гонку');
  assertStringIncludes(prompt, 'всего точных попаданий 3');
});

Deno.test('buildVeteranPrompt: запрещает упоминать свежий прогноз', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []);
  assertStringIncludes(prompt, 'СОДЕРЖАНИЕ этого нового прогноза тебе неизвестно');
  assertStringIncludes(prompt, 'шути ТОЛЬКО про его прошлые прогнозы');
});

Deno.test('buildRookiePrompt: запрещает упоминать свежий прогноз', () => {
  const prompt = buildRookiePrompt('Костя', 'Azerbaijan Grand Prix');
  assertStringIncludes(prompt, 'СОДЕРЖАНИЕ его прогноза тебе неизвестно');
});

Deno.test('buildVeteranPrompt: без прошлых шуток блока «так уже шутили» нет', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []);
  assert(!prompt.includes('уже шутили так'));
});

Deno.test('buildVeteranPrompt: прошлые шутки уходят в промпт нумерованным списком', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, [
    'Опять ANT на первом месте',
    'Снова ставка на Мерседес',
  ]);
  assertStringIncludes(prompt, 'уже шутили так');
  assertStringIncludes(prompt, '1. Опять ANT на первом месте');
  assertStringIncludes(prompt, '2. Снова ставка на Мерседес');
  assertStringIncludes(prompt, 'Придумай ЧТО-ТО ДРУГОЕ');
});

Deno.test('buildVeteranPrompt: даёт расшифровку кодов и запрещает угадывать имена', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []);
  assertStringIncludes(prompt, 'ANT — Andrea Kimi Antonelli');
  assertStringIncludes(prompt, 'HAM — Lewis Hamilton');
  assertStringIncludes(prompt, 'Не угадывай имя пилота по коду');
});

Deno.test('buildVeteranPrompt: в расшифровку попадают только встречающиеся в истории пилоты', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, DRIVERS, []);
  // NOR есть в результате раунда 11, LIN в истории не встречается ни разу.
  assertStringIncludes(prompt, 'NOR — Lando Norris');
  assert(!prompt.includes('Arvid Lindblad'));
});

Deno.test('buildVeteranPrompt: пустой справочник пилотов -> блока расшифровки нет', () => {
  const prompt = buildVeteranPrompt('Dim', 'Azerbaijan Grand Prix', HISTORY, STATS, [], []);
  assert(!prompt.includes('Расшифровка кодов'));
});

Deno.test('similarity: одинаковый текст -> 1', () => {
  assertEquals(similarity('Опять ANT первым!', 'опять ant первым'), 1);
});

Deno.test('similarity: игнорирует регистр, пунктуацию и эмодзи', () => {
  assertEquals(similarity('Дим, опять ANT на P1! 🤩', 'дим опять ant на p1'), 1);
});

Deno.test('similarity: совсем разные шутки -> низкое значение', () => {
  const a = 'Опять ANT на первом месте, это уже традиция';
  const b = 'Прогулял половину сезона и вернулся как ни в чём не бывало';
  assert(similarity(a, b) < 0.2, `ожидали < 0.2, получили ${similarity(a, b)}`);
});

Deno.test('similarity: пустая строка -> 0', () => {
  assertEquals(similarity('', 'что-то'), 0);
});

Deno.test('isDuplicate: ловит перефразировку прошлой шутки', () => {
  const past = ['Дим, твоя любовь к ANT на первом месте уже стала легендой лиги'];
  assert(isDuplicate('Твоя любовь к ANT на первом месте уже легенда лиги, Дим', past));
});

Deno.test('isDuplicate: пропускает шутку на другую тему', () => {
  const past = ['Дим, твоя любовь к ANT на первом месте уже стала легендой лиги'];
  assert(!isDuplicate('Сыграл две гонки из пяти и ещё что-то доказывает 😅', past));
});

Deno.test('isDuplicate: пустая история -> дублей нет', () => {
  assert(!isDuplicate('Любая шутка', []));
});
