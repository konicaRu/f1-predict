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
    } else {
      return Response.json({ error: `неизвестный event_type: ${body.event_type}` }, { status: 400 });
    }

    const text = buildMessage(resolved);

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
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) {
      return Response.json({ error: `Telegram API error: ${JSON.stringify(data)}` }, { status: 500 });
    }
    return Response.json({ sent: true });
  }),
};
