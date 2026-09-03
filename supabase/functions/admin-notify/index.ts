// supabase/functions/admin-notify/index.ts
import { withSupabase } from 'npm:@supabase/server';
import { buildMessage, isQuietHours } from './format.ts';
import type { ResolvedEvent } from './format.ts';

const ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');

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
        .select('name')
        .eq('id', body.payload?.race_id)
        .maybeSingle();
      if (raceError) {
        console.error(`admin-notify: ошибка lookup races (id=${body.payload?.race_id}):`, raceError.message);
      }
      resolved = {
        event_type: 'prediction',
        display_name: user?.display_name ?? '(неизвестный участник)',
        race_name: race?.name ?? '(неизвестная гонка)',
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
        .select('out_reason')
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
      const reason = poolRow.out_reason ?? undefined;
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
