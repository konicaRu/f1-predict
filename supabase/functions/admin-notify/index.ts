// supabase/functions/admin-notify/index.ts
import { withSupabase } from 'npm:@supabase/server';
import { buildMessage, isQuietHours } from './format.ts';
import type { ResolvedEvent } from './format.ts';
import { buildJokePrompt, generateJoke, isDuplicate } from './joke.ts';
import type { RaceHistory } from './joke.ts';

const ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');

// Сколько прошлых шуток про участника показать модели как «так уже шутили». Больше пяти смысла
// нет: промпт пухнет, а закономерностей в истории всё равно конечное число.
const PAST_JOKES_LIMIT = 5;

// Возвращает шутку про участника или null, если пошутить не вышло. Никогда не бросает наружу
// так, чтобы потерялось само уведомление: уведомление о прогнозе важнее шутки.
async function makeJoke(
  supabaseAdmin: any,
  userId: string,
  raceId: number,
  displayName: string,
  raceName: string,
  season: unknown,
): Promise<string | null> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    console.warn('admin-notify: GEMINI_API_KEY не настроен, шутка пропущена');
    return null;
  }
  if (typeof season !== 'number') {
    console.warn('admin-notify: сезон гонки неизвестен, шутка пропущена');
    return null;
  }

  // Антизлоупотребление. Эндпоинт намеренно открыт под публичным anon-ключом (см. комментарий
  // у fetch ниже), поэтому событие может быть и выдуманным. Пока худшим случаем был спам в личку,
  // это было приемлемо; с Gemini худшим случаем становится ещё и выжигание квоты платного API.
  // Нет реального прогноза в БД — нет и обращения к модели.
  const { data: pred } = await supabaseAdmin
    .from('predictions')
    .select('race_id')
    .eq('user_id', userId)
    .eq('race_id', raceId)
    .maybeSingle();
  if (!pred) {
    console.warn(`admin-notify: прогноза (user=${userId}, race=${raceId}) нет в БД, шутка пропущена`);
    return null;
  }

  const [races, preds, results, scoreRows, drivers] = await Promise.all([
    supabaseAdmin.from('races').select('id, round, name').eq('season', season).eq('scored', true).order('round'),
    supabaseAdmin.from('predictions').select('race_id, positions').eq('user_id', userId),
    supabaseAdmin.from('results').select('race_id, positions'),
    supabaseAdmin.from('scores').select('race_id, points, exact_hits').eq('user_id', userId),
    supabaseAdmin.from('drivers').select('id, code, name'),
  ]);

  // Без этой проверки сбой любого из запросов даёт data = null -> пустая история -> ветерану
  // молча уезжает промпт новичка. Молчаливая подмена хуже отсутствия шутки: лучше отступить.
  const failed = [
    ['races', races], ['predictions', preds], ['results', results],
    ['scores', scoreRows], ['drivers', drivers],
  ].filter(([, r]: any) => r.error);
  if (failed.length > 0) {
    console.error(
      `admin-notify: история для шутки не собралась: ${
        failed.map(([name, r]: any) => `${name}: ${r.error.message}`).join('; ')
      }`,
    );
    return null;
  }

  const codeOf = new Map((drivers.data ?? []).map((d: any) => [d.id, d.code]));
  const driverNames = (drivers.data ?? []).map((d: any) => ({ code: d.code, name: d.name }));
  const label = (ids: unknown) =>
    Array.isArray(ids) ? ids.map((id) => codeOf.get(id) ?? String(id)).join('-') : '';
  const predBy = new Map((preds.data ?? []).map((p: any) => [p.race_id, p.positions]));
  const resultBy = new Map((results.data ?? []).map((r: any) => [r.race_id, r.positions]));
  const scoreBy = new Map<number, { points: number; exact_hits: number }>(
    (scoreRows.data ?? []).map((s: any) => [s.race_id, { points: s.points, exact_hits: s.exact_hits }]),
  );

  // Только зачётные гонки, по которым уже есть и прогноз, и результат, и посчитанные очки.
  // Текущую гонку исключаем явно — её содержимое в промпт попадать не должно в принципе.
  const history: RaceHistory[] = [];
  for (const r of races.data ?? []) {
    if (r.id === raceId) continue;
    const predicted = predBy.get(r.id);
    const actual = resultBy.get(r.id);
    const score = scoreBy.get(r.id);
    if (!predicted || !actual || !score) continue;
    history.push({
      round: r.round,
      race_name: r.name,
      predicted: label(predicted),
      actual: label(actual),
      points: score.points,
      exact_hits: score.exact_hits,
    });
  }

  const stats = {
    played: history.length,
    total: (races.data ?? []).length,
    avg: history.length === 0
      ? 0
      : Math.round(history.reduce((sum, h) => sum + h.points, 0) / history.length),
    hits: history.reduce((sum, h) => sum + h.exact_hits, 0),
  };

  const { data: pastRows } = await supabaseAdmin
    .from('prediction_jokes')
    .select('text')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(PAST_JOKES_LIMIT);
  const pastJokes: string[] = (pastRows ?? []).map((r: any) => r.text);

  let joke = await generateJoke(
    buildJokePrompt(displayName, raceName, history, stats, driverNames, pastJokes),
    apiKey,
  );
  if (isDuplicate(joke, pastJokes)) {
    // Одна повторная попытка: забракованный вариант дописываем в список «так уже шутили», иначе
    // модель с высокой вероятностью выдаст его же. Второй дубль принимаем как есть — повтор лучше,
    // чем пустое место, и последнее слово всё равно за админом: он решает, пересылать ли.
    console.warn('admin-notify: шутка повторяет прошлую, перегенерируем один раз');
    joke = await generateJoke(
      buildJokePrompt(displayName, raceName, history, stats, driverNames, [...pastJokes, joke]),
      apiKey,
    );
  }

  const { error: saveError } = await supabaseAdmin
    .from('prediction_jokes')
    .upsert({ user_id: userId, race_id: raceId, text: joke }, { onConflict: 'user_id,race_id' });
  if (saveError) {
    // Не роняем шутку из-за проблемы с логом — она уже сгенерирована и полезна прямо сейчас.
    // Потеряется только защита от повтора на следующей гонке.
    console.error(`admin-notify: не удалось сохранить шутку: ${saveError.message}`);
  }
  return joke;
}

export default {
  // Намеренно без вторичной аутентификации сверх publishable-ключа (в отличие от
  // telegram-auth/index.ts, который добавляет HMAC-проверку поверх той же обёртки).
  // Любой, у кого есть anon-ключ (он и так публичный, зашит в бандл фронтенда),
  // может дёрнуть этот эндпоинт напрямую с произвольным event_type/payload.
  // Осознанный риск, принят на code review: худший случай — спам в личку админа
  // в Telegram (можно замьютить/заблокировать), утечки данных нет. Не оверсайт.
  fetch: withSupabase({ auth: 'publishable' }, async (req, ctx) => {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      return Response.json({ error: 'TELEGRAM_BOT_TOKEN не настроен' }, { status: 500 });
    }
    if (!ADMIN_CHAT_ID) {
      return Response.json({ error: 'TELEGRAM_ADMIN_CHAT_ID не настроен' }, { status: 500 });
    }

    let body: { event_type?: string; payload?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'некорректный JSON' }, { status: 400 });
    }

    const { supabaseAdmin } = ctx;
    const usersTable = supabaseAdmin.from('users') as any;
    const racesTable = supabaseAdmin.from('races') as any;
    let resolved: ResolvedEvent;

    if (body.event_type === 'registration') {
      const displayName = body.payload?.display_name;
      resolved = {
        event_type: 'registration',
        display_name: typeof displayName === 'string' ? displayName : '(без имени)',
      };
    } else if (body.event_type === 'prediction') {
      const { data: user, error: userError } = await usersTable
        .select('display_name')
        .eq('id', body.payload?.user_id)
        .maybeSingle();
      if (userError) {
        console.error(`admin-notify: ошибка lookup users (id=${body.payload?.user_id}):`, userError.message);
      }
      const { data: race, error: raceError } = await racesTable
        .select('name, season')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      const displayName = user?.display_name ?? '(неизвестный участник)';
      const raceNameText = race?.name ?? '(неизвестная гонка)';

      // Шутка — украшение, а не суть события. Любой сбой (нет ключа, Gemini лежит, таймаут,
      // мусор в ответе) гасим здесь и уходим со старым сухим текстом: админ обязан узнать
      // о прогнозе в любом случае.
      let joke: string | null = null;
      try {
        joke = await makeJoke(
          supabaseAdmin,
          String(body.payload?.user_id),
          Number(body.payload?.race_id),
          displayName,
          raceNameText,
          race?.season,
        );
      } catch (e) {
        console.warn(`admin-notify: шутка не сгенерирована: ${(e as Error).message}`);
      }

      resolved = {
        event_type: 'prediction',
        display_name: displayName,
        race_name: raceNameText,
        joke: joke ?? undefined,
      };
    } else if (body.event_type === 'result') {
      const { data: race, error: raceError } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      resolved = { event_type: 'result', race_name: race?.name ?? '(неизвестная гонка)' };
    } else if (body.event_type === 'pool_change') {
      const driversTable = supabaseAdmin.from('drivers') as any;
      const poolTable = supabaseAdmin.from('race_driver_pool') as any;
      const { data: race, error: raceError } = await racesTable
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      const { data: driver, error: driverError } = await driversTable
        .select('code, name')
        .eq('id', body.payload?.driver_id)
        .maybeSingle();
      if (driverError) {
        console.error(`admin-notify: ошибка lookup drivers (id=${body.payload?.driver_id}):`, driverError.message);
      }
      // Не доверяем action/reason из payload напрямую — сообщение может описывать только то, что
      // РЕАЛЬНО сейчас в БД, иначе кто угодно с публичным anon-ключом мог бы разослать в общий чат
      // произвольный выдуманный текст под видом настоящей замены пилота.
      const { data: poolRow, error: poolError } = await poolTable
        .select('out_reason, added_reason')
        .eq('race_id', body.payload?.race_id)
        .eq('driver_id', body.payload?.driver_id)
        .maybeSingle();
      if (poolError) {
        console.error(`admin-notify: ошибка lookup race_driver_pool (race_id=${body.payload?.race_id}, driver_id=${body.payload?.driver_id}):`, poolError.message);
      }
      if (!poolRow) {
        return Response.json({ error: 'pool_change: пилот не найден в пуле этой гонки' }, { status: 404 });
      }
      const action = poolRow.out_reason ? 'out' : 'added';
      const reason = (action === 'out' ? poolRow.out_reason : poolRow.added_reason) ?? undefined;
      resolved = {
        event_type: 'pool_change',
        race_name: race?.name ?? '(неизвестная гонка)',
        driver_code: driver?.code ?? '?',
        driver_name: driver?.name ?? '(неизвестный пилот)',
        action,
        reason,
      };
    } else {
      return Response.json({ error: `неизвестный event_type: ${body.event_type}` }, { status: 400 });
    }

    const text = buildMessage(resolved);

    // pool_change — редкое и важное для игроков сообщение (замена/травма пилота), в отличие от
    // registration/prediction (породивших правило тихих часов) откладывать на утро не нужно —
    // уходит в общий чат сразу и безусловно, независимо от тихих часов админ-чата ниже.
    if (resolved.event_type === 'pool_change') {
      const generalChatId = Deno.env.get('TELEGRAM_CHAT_ID');
      if (!generalChatId) {
        return Response.json({ error: 'TELEGRAM_CHAT_ID не настроен' }, { status: 500 });
      }
      const generalRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: generalChatId, text, parse_mode: 'HTML' }),
      });
      const generalData = await generalRes.json();
      if (!generalData.ok) {
        // Не прерываем запрос — реальное изменение пула уже произошло, и админ должен узнать
        // о нём независимо от того, ушло ли сообщение в общий чат игрокам.
        console.error(`admin-notify: Telegram API error (общий чат): ${JSON.stringify(generalData)}`);
      }
    }

    if (isQuietHours(new Date())) {
      const { error } = await (supabaseAdmin.from('admin_notification_queue') as any).insert({ text });
      if (error) {
        return Response.json({ error: `queue insert: ${error.message}` }, { status: 500 });
      }
      return Response.json({ queued: true });
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) {
      return Response.json({ error: `Telegram API error: ${JSON.stringify(data)}` }, { status: 500 });
    }
    return Response.json({ sent: true });
  }),
};
