// supabase/functions/watchdog/index.ts — сторож. Запускается pg_cron раз в 15 минут (миграция 0028).
// Собирает снимок состояния, сверяет с журналом инцидентов и шлёт админу одно сводное сообщение:
// новые проблемы и напоминания раз в 6 ч (о восстановлении не сообщаем). Логика решений — в checks.ts (тесты).
import { withSupabase } from 'npm:@supabase/server';
import { evaluate, isOneShot, planNotifications, RUNS_WINDOW_HOURS } from './checks.ts';
import type { Incident, JobRun, Snapshot, WatchedRace } from './checks.ts';

const H = 60 * 60 * 1000;
const RETENTION_DAYS = 30;

// supabase-js не бросает на ошибках запроса — превращаем их в исключение, чтобы сбой чтения
// не выглядел как «всё хорошо, проблем нет» (молчаливая ложная зелень хуже упавшего сторожа).
function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

async function gatherSnapshot(db: any, now: Date): Promise<Snapshot> {
  const since = new Date(now.getTime() - RUNS_WINDOW_HOURS * H).toISOString();
  const runs = must<JobRun[]>(
    await db.from('job_runs').select('id, job, ran_at, ok, errors').gte('ran_at', since).order('ran_at', { ascending: false }).limit(2000),
    'job_runs',
  );
  // notify.js отмечается на каждом прогоне GitHub Actions (results — раз в 2 ч), поэтому
  // наличие хоть одной notify-строки за всю историю = «пульс GitHub уже подключён».
  const anyNotify = must<{ id: number }[]>(await db.from('job_runs').select('id').like('job', 'notify:%').limit(1), 'job_runs/any');
  const keepalive = must<{ pinged_at: string } | null>(
    await db.from('keepalive').select('pinged_at').eq('id', 1).maybeSingle(),
    'keepalive',
  );
  const queue = must<{ created_at: string }[]>(
    await db.from('admin_notification_queue').select('created_at').order('created_at').limit(1),
    'admin_notification_queue',
  );
  const raceRows = must<Omit<WatchedRace, 'gridbot_predicted' | 'has_result'>[]>(
    await db
      .from('races')
      .select('id, name, status, deadline_utc, race_datetime_utc, raceweek_announced_at')
      .in('status', ['open', 'closed']),
    'races',
  );

  let races: WatchedRace[] = [];
  if (raceRows.length > 0) {
    const ids = raceRows.map((r) => r.id);
    const gridbot = must<{ id: string } | null>(
      await db.from('users').select('id').eq('display_name', 'GridBot').maybeSingle(),
      'users/GridBot',
    );
    const predicted = gridbot
      ? must<{ race_id: number }[]>(
          await db.from('predictions').select('race_id').eq('user_id', gridbot.id).in('race_id', ids),
          'predictions/GridBot',
        )
      : [];
    const results = must<{ race_id: number }[]>(await db.from('results').select('race_id').in('race_id', ids), 'results');
    const predictedSet = new Set(predicted.map((p) => Number(p.race_id)));
    const resultSet = new Set(results.map((r) => Number(r.race_id)));
    races = raceRows.map((r) => ({
      ...r,
      id: Number(r.id),
      // GridBot-аккаунт пропал — не тревожим про его прогноз (сам факт пропажи увидим по варнингу aiplayer).
      gridbot_predicted: gridbot ? predictedSet.has(Number(r.id)) : true,
      has_result: resultSet.has(Number(r.id)),
    }));
  }

  return {
    now,
    runs: runs.map((r) => ({ ...r, errors: r.errors ?? [] })),
    everHadGhaRun: anyNotify.length > 0,
    keepalivePingedAt: keepalive?.pinged_at ?? null,
    queueOldestAt: queue[0]?.created_at ?? null,
    races,
  };
}

async function sendTelegram(text: string): Promise<void> {
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
  if (!botToken || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID не настроены');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram API: ${JSON.stringify(data)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function runWatchdog(db: any) {
  const now = new Date();
  const nowIso = now.toISOString();
  const failing = evaluate(await gatherSnapshot(db, now));
  const failingByKey = new Map(failing.map((f) => [f.key, f]));

  // Сверка: новые проблемы открываем, исчезнувшие закрываем.
  const open = must<Incident[]>(await db.from('watchdog_incidents').select('*').is('resolved_at', null), 'incidents/open');
  const openByKey = new Map(open.map((i) => [i.key, i]));
  for (const f of failing) {
    const existing = openByKey.get(f.key);
    if (existing) {
      must(await db.from('watchdog_incidents').update({ details: f.details, last_seen_at: nowIso }).eq('id', existing.id), 'incidents/touch');
    } else {
      const res = await db.from('watchdog_incidents').insert({ key: f.key, details: f.details });
      // 23505 — параллельный запуск сторожа (pg_cron + ручной вызов) уже открыл тот же инцидент.
      if (res.error && res.error.code !== '23505') throw new Error(`incidents/insert: ${res.error.message}`);
    }
  }
  for (const i of open) {
    if (failingByKey.has(i.key)) continue;
    // Разовые закрываются сразу помеченными; остальным пометку ставит planNotifications (тоже без сообщения).
    const patch = isOneShot(i.key) ? { resolved_at: nowIso, resolution_notified_at: nowIso } : { resolved_at: nowIso };
    must(await db.from('watchdog_incidents').update(patch).eq('id', i.id), 'incidents/resolve');
  }

  const openNow = must<Incident[]>(await db.from('watchdog_incidents').select('*').is('resolved_at', null), 'incidents/open2');
  const pending = must<Incident[]>(
    await db.from('watchdog_incidents').select('*').not('resolved_at', 'is', null).is('resolution_notified_at', null),
    'incidents/pending',
  );
  const plan = planNotifications(openNow, pending, now);

  // Сначала отправка, потом пометки: если Telegram не принял, инциденты останутся «не сообщёнными»
  // и уйдут на следующем запуске, а не потеряются.
  if (plan.text) await sendTelegram(plan.text);
  if (plan.notifiedIds.length) {
    must(await db.from('watchdog_incidents').update({ notified_at: nowIso }).in('id', plan.notifiedIds), 'incidents/notified');
  }
  if (plan.resolutionNotifiedIds.length) {
    must(
      await db.from('watchdog_incidents').update({ resolution_notified_at: nowIso }).in('id', plan.resolutionNotifiedIds),
      'incidents/resolution_notified',
    );
  }

  // Уборка истории — таблицы иначе растут бесконечно (~100 строк пульса в сутки).
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * H).toISOString();
  must(await db.from('job_runs').delete().lt('ran_at', cutoff), 'job_runs/prune');
  must(await db.from('watchdog_incidents').delete().lt('resolved_at', cutoff), 'incidents/prune');

  return { failing: failing.map((f) => f.key), sent: Boolean(plan.text) };
}

export default {
  // Тот же уровень защиты, что у admin-notify: publishable-ключ, без вторичной авторизации.
  // Вызвать сторожа может кто угодно с anon-ключом, но он лишь перепроверяет реальное состояние
  // БД — выдумать тревогу через тело запроса нельзя (тело игнорируется), а повторы гасит журнал.
  fetch: withSupabase({ auth: 'publishable' }, async (_req, ctx) => {
    const db = ctx.supabaseAdmin as any;
    try {
      const result = await runWatchdog(db);
      await db.from('job_runs').insert({ job: 'watchdog', ok: true, errors: [] });
      return Response.json(result);
    } catch (e) {
      const msg = (e as Error).message;
      console.error('watchdog:', msg);
      // Собственный сбой пишем в пульс: следующий успешный запуск покажет его разовым
      // предупреждением, а notify.js в GitHub увидит, что сторож давно не отмечался успешно.
      await db.from('job_runs').insert({ job: 'watchdog', ok: false, errors: [msg] });
      return Response.json({ error: msg }, { status: 500 });
    }
  }),
};
