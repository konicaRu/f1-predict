// Шутка-комментарий к прогнозу участника (спека — MEMORY.md, сессия 2026-09-23).
//
// Главное ограничение, ради которого всё и устроено именно так: шутка строится ТОЛЬКО на прошлых,
// уже отыгранных прогнозах. Содержимое свежего прогноза сюда не попадает вообще — иначе админ,
// переслав сообщение в общий чат до дедлайна, сломал бы принцип слепого прогноза (конституция,
// «чужие прогнозы скрыты до дедлайна»). Защита структурная, а не «попросили модель не болтать».

export type RaceHistory = {
  round: number;
  race_name: string;
  predicted: string; // коды через дефис, напр. 'ANT-HAM-PIA-...'
  actual: string;
  points: number;
  exact_hits: number;
};

export type DriverName = { code: string; name: string };

export type JokeStats = {
  played: number; // в скольких зачётных гонках участвовал
  total: number; // сколько зачётных гонок было всего
  avg: number; // средние очки за гонку
  hits: number; // всего точных попаданий
};

const STYLE =
  `Ты — язвительный, но добрый комментатор закрытой фан-лиги прогнозов Формулы-1 для компании друзей.\n` +
  `Напиши короткий прикол про участника: 2-3 предложения, по-русски, живым молодёжным языком, с F1-тематикой.\n` +
  `Можно сленг, мемы, эмодзи (1-2, не больше). Подкалывай по-дружески, без грубости и без перехода на личности —\n` +
  `это реальные друзья, которые прочитают это в общем чате. Шути про СТАТИСТИКУ и ПРИВЫЧКИ в прогнозах, а не про человека.\n` +
  `Верни только текст шутки, без заголовков и без markdown.`;

// Прошлые шутки идут в промпт списком: программная проверка на дубль (isDuplicate) ловит только
// совсем уж близкие повторы, а не повтор одной и той же МЫСЛИ другими словами. Просить модель
// не повторяться — дешевле и работает лучше, чем перегенерировать по кругу.
function avoidBlock(pastJokes: string[]): string {
  if (pastJokes.length === 0) return '';
  const list = pastJokes.map((j, i) => `${i + 1}. ${j}`).join('\n');
  return (
    `\n\nПро этого участника уже шутили так:\n${list}\n\n` +
    `Придумай ЧТО-ТО ДРУГОЕ: другую закономерность, другой угол, другую подачу. ` +
    `Не пересказывай эти шутки своими словами и не бери ту же самую тему.`
  );
}

// Без расшифровки модель угадывает имя по трёхбуквенному коду и врёт: на прогоне 2026-09-23
// назвала LIN «Лэнсом Строллом», хотя это Arvid Lindblad. Шутка с выдуманным пилотом бесполезна —
// её нельзя переслать в чат, где все знают состав. Даём словарь и запрещаем угадывать.
function legendBlock(history: RaceHistory[], drivers: DriverName[]): string {
  const used = new Set(history.flatMap((h) => [...h.predicted.split('-'), ...h.actual.split('-')]));
  const known = drivers.filter((d) => used.has(d.code));
  if (known.length === 0) return '';
  const list = known.map((d) => `${d.code} — ${d.name}`).join(', ');
  return (
    `\n\nРасшифровка кодов пилотов: ${list}.\n` +
    `Используй ТОЛЬКО эту расшифровку. Не угадывай имя пилота по коду — если кода нет в списке, не упоминай его.`
  );
}

export function buildVeteranPrompt(
  displayName: string,
  raceName: string,
  history: RaceHistory[],
  stats: JokeStats,
  drivers: DriverName[],
  pastJokes: string[],
): string {
  const lines = history
    .map(
      (h) =>
        `Раунд ${h.round} (${h.race_name}): поставил ${h.predicted}; ` +
        `реальный результат ${h.actual}; получил ${h.points} очков, точных попаданий ${h.exact_hits}`,
    )
    .join('\n');

  return (
    `${STYLE}\n\n` +
    `Участник: ${displayName}\n` +
    `Он только что поставил прогноз на гонку "${raceName}". СОДЕРЖАНИЕ этого нового прогноза тебе ` +
    `неизвестно и упоминать его нельзя — шути ТОЛЬКО про его прошлые прогнозы.\n\n` +
    `История его прошлых прогнозов:\n${lines}` +
    legendBlock(history, drivers) +
    `\n\n` +
    `Сводка: сыграл ${stats.played} гонок из ${stats.total} возможных, ` +
    `пропустил ${stats.total - stats.played}; в среднем ${stats.avg} очков за гонку; ` +
    `всего точных попаданий ${stats.hits}.\n\n` +
    `Найди в этих данных смешную закономерность (любимый пилот, который вечно подводит; одна и та же ` +
    `ставка из гонки в гонку; ноль точных попаданий; прогулы) и обыграй её.` +
    avoidBlock(pastJokes)
  );
}

export function buildRookiePrompt(displayName: string, raceName: string): string {
  return (
    `${STYLE}\n\n` +
    `Участник: ${displayName}\n` +
    `Он только что поставил свой САМЫЙ ПЕРВЫЙ прогноз в лиге (гонка "${raceName}") — никакой истории, ` +
    `никакой статистики, хвастаться пока нечем. СОДЕРЖАНИЕ его прогноза тебе неизвестно и упоминать его нельзя.\n\n` +
    `Обыграй именно это: новичок, чистый лист, нулевая статистика, вся слава (и весь позор) впереди. ` +
    `Можно сравнить с дебютом новичка в Ф1.`
  );
}

export function buildJokePrompt(
  displayName: string,
  raceName: string,
  history: RaceHistory[],
  stats: JokeStats,
  drivers: DriverName[],
  pastJokes: string[],
): string {
  return history.length === 0
    ? buildRookiePrompt(displayName, raceName)
    : buildVeteranPrompt(displayName, raceName, history, stats, drivers, pastJokes);
}

// Приводим к «смысловому скелету»: без регистра, эмодзи, пунктуации и лишних пробелов.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Доля общих слов (Жаккар). Порог 0.6 подобран как «две шутки про одно и то же разными словами»:
// у осмысленно разных шуток пересечение держится ниже 0.4 (общие только служебные слова и имя),
// у перефразировок — выше 0.7. Точное совпадение строк ловить бессмысленно: модель почти никогда
// не повторяет текст буквально, она повторяет мысль.
export function similarity(a: string, b: string): number {
  const wa = new Set(normalize(a).split(' ').filter(Boolean));
  const wb = new Set(normalize(b).split(' ').filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}

export function isDuplicate(candidate: string, pastJokes: string[], threshold = 0.6): boolean {
  return pastJokes.some((j) => similarity(candidate, j) >= threshold);
}

// 429 (лимит) и 5xx (перегрузка) у Gemini проходят сами — живьём поймано на прогоне 2026-09-23,
// модель ответила 503 «experiencing high demand». 4xx кроме 429 — наша ошибка, ретрай бессмысленен.
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askOnce(prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  // Таймаут обязателен: fetch() не размыкается сам, если соединение подвисло (урок 2026-09-23).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { joke: { type: 'STRING' } },
            required: ['joke'],
          },
        },
      }),
    });
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
      (err as { transient?: boolean }).transient = isTransientStatus(res.status);
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini: пустой ответ');
    const joke = JSON.parse(text).joke;
    if (typeof joke !== 'string' || joke.trim() === '') throw new Error('Gemini: пустая шутка');
    return joke.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Вызов Gemini со своей схемой ответа (askGemini из scripts/ai-player/lib.js прибит к top10+reasoning).
export async function generateJoke(
  prompt: string,
  apiKey: string,
  timeoutMs = 20000,
  attempts = 3,
): Promise<string> {
  for (let a = 1; a <= attempts; a++) {
    try {
      return await askOnce(prompt, apiKey, timeoutMs);
    } catch (e) {
      // Оборванная сеть и сработавший таймаут — тоже транзиентные: у них нет HTTP-статуса вовсе.
      const transient = (e as { transient?: boolean }).transient ?? true;
      if (!transient || a === attempts) throw e;
      console.warn(`admin-notify: Gemini попытка ${a}/${attempts} не удалась (${(e as Error).message}), повтор`);
      await sleep(800 * a);
    }
  }
  throw new Error('недостижимо');
}
