import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { evaluate, isAlertQuietHours, mskWeekKey, planNotifications } from './checks.ts';
import type { Incident, JobRun, Snapshot, WatchedRace } from './checks.ts';

// МСК = UTC+3 круглый год.
const NOW = new Date('2026-10-08T09:53:00Z'); // чт 12:53 МСК — момент инцидента 2026-10-08

function run(job: string, ranAt: string, ok = true, errors: string[] = [], id = 1): JobRun {
  return { id, job, ran_at: ranAt, ok, errors };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    now: NOW,
    runs: [run('notify:results', '2026-10-08T08:05:00Z')],
    everHadGhaRun: true,
    keepalivePingedAt: '2026-10-08T06:17:00Z',
    queueOldestAt: null,
    races: [],
    ...over,
  };
}

function race(over: Partial<WatchedRace> = {}): WatchedRace {
  return {
    id: 20,
    name: 'Singapore Grand Prix',
    status: 'open',
    deadline_utc: '2026-10-08T20:00:00Z', // чт 23:00 МСК
    race_datetime_utc: '2026-10-11T12:00:00Z',
    raceweek_announced_at: '2026-10-05T07:05:00Z',
    gridbot_predicted: true,
    has_result: false,
    ...over,
  };
}

const keys = (s: Snapshot) => evaluate(s).map((f) => f.key).sort();

Deno.test('isAlertQuietHours: 22:59 МСК — можно, 23:00 — тихо', () => {
  assertEquals(isAlertQuietHours(new Date('2026-10-08T19:59:00Z')), false);
  assertEquals(isAlertQuietHours(new Date('2026-10-08T20:00:00Z')), true);
});

Deno.test('isAlertQuietHours: 09:59 МСК — тихо, 10:00 — можно', () => {
  assertEquals(isAlertQuietHours(new Date('2026-10-08T06:59:00Z')), true);
  assertEquals(isAlertQuietHours(new Date('2026-10-08T07:00:00Z')), false);
});

Deno.test('mskWeekKey: понедельник и воскресенье одной недели совпадают, следующий понедельник — нет', () => {
  const mon = mskWeekKey(new Date('2026-10-05T00:30:00Z')); // пн 03:30 МСК
  const sun = mskWeekKey(new Date('2026-10-11T20:00:00Z')); // вс 23:00 МСК
  const nextMon = mskWeekKey(new Date('2026-10-11T21:30:00Z')); // пн 00:30 МСК
  assertEquals(mon, sun);
  assert(mon !== nextMon);
});

Deno.test('evaluate: здоровое состояние — проблем нет', () => {
  assertEquals(evaluate(snap({ races: [race()] })), []);
});

Deno.test('evaluate: сценарий 2026-10-08 — последний прогон 05:50, сейчас 09:53 → GitHub молчит', () => {
  const f = evaluate(snap({ runs: [run('notify:results', '2026-10-08T05:50:40Z')] }));
  assertEquals(f.map((x) => x.key), ['gha_silent']);
  assert(f[0].details.includes('08.10 08:50 МСК'));
});

Deno.test('evaluate: прогон 3 ч назад — это ещё опоздание GitHub, не тревога', () => {
  assertEquals(keys(snap({ runs: [run('notify:results', '2026-10-08T06:53:00Z')] })), []);
});

Deno.test('evaluate: до первого пульса нового кода «GitHub молчит» не поднимаем', () => {
  assertEquals(keys(snap({ runs: [], everHadGhaRun: false })), []);
});

Deno.test('evaluate: пульс был когда-то, но в окне 48 ч пусто → GitHub молчит', () => {
  assertEquals(keys(snap({ runs: [] })), ['gha_silent']);
});

Deno.test('evaluate: последний прогон задачи упал → job_failed', () => {
  const s = snap({
    runs: [
      run('notify:results', '2026-10-08T06:05:00Z', true),
      run('notify:results', '2026-10-08T08:05:00Z', false, ['Connection terminated unexpectedly']),
    ],
  });
  const f = evaluate(s);
  assertEquals(f.map((x) => x.key), ['job_failed:notify:results']);
  assert(f[0].details.includes('Connection terminated unexpectedly'));
});

Deno.test('evaluate: упал, но следующий прогон успешный → инцидента нет', () => {
  const s = snap({
    runs: [
      run('notify:results', '2026-10-08T06:05:00Z', false, ['boom']),
      run('notify:results', '2026-10-08T08:05:00Z', true),
    ],
  });
  assertEquals(keys(s), []);
});

Deno.test('evaluate: ошибка упавшего GH-прогона не дублируется предупреждением', () => {
  const s = snap({ runs: [run('notify:results', '2026-10-08T08:05:00Z', false, ['boom'])] });
  assertEquals(keys(s), ['job_failed:notify:results']);
});

Deno.test('evaluate: одно и то же предупреждение из разных прогонов — один инцидент', () => {
  const s = snap({
    runs: [
      run('notify:results', '2026-10-08T06:05:00Z', true, ['adminflush: Telegram 429'], 1),
      run('notify:results', '2026-10-08T08:05:00Z', true, ['adminflush: Telegram 429'], 2),
    ],
  });
  const warn = evaluate(s).filter((f) => f.key.startsWith('warn:'));
  assertEquals(warn.length, 1);
});

Deno.test('evaluate: пропавшая шутка admin-notify — разовый инцидент', () => {
  const s = snap({
    runs: [
      run('notify:results', '2026-10-08T08:05:00Z'),
      run('admin-notify', '2026-10-08T06:03:15Z', true, ['шутка для Iceman: Gemini HTTP 503'], 2),
    ],
  });
  const f = evaluate(s);
  assertEquals(f.length, 1);
  assert(f[0].key.startsWith('warn:admin-notify:'));
  assert(f[0].details.includes('Iceman'));
});

Deno.test('evaluate: keepalive молчит больше 26 ч', () => {
  assertEquals(keys(snap({ keepalivePingedAt: '2026-10-07T06:00:00Z' })), ['keepalive_stale']);
});

Deno.test('evaluate: застрявшая очередь — тревога только днём 12:00-22:00 МСК', () => {
  const queued = { queueOldestAt: '2026-10-08T04:16:00Z' };
  assertEquals(keys(snap(queued)), ['queue_stuck']); // 12:53 МСК
  const morning = new Date('2026-10-08T08:30:00Z'); // 11:30 МСК — adminflush ещё может догнать
  assertEquals(keys(snap({ ...queued, now: morning, runs: [run('notify:results', '2026-10-08T08:05:00Z')] })), []);
});

Deno.test('evaluate: GridBot без прогноза за 6 ч до дедлайна', () => {
  const at = new Date('2026-10-08T15:00:00Z'); // за 5 ч до дедлайна
  const s = snap({ now: at, runs: [run('notify:results', '2026-10-08T14:05:00Z')], races: [race({ gridbot_predicted: false })] });
  assertEquals(keys(s), ['gridbot_missing:20']);
});

Deno.test('evaluate: GridBot без прогноза, но до дедлайна ещё 10 ч — рано', () => {
  assertEquals(keys(snap({ races: [race({ gridbot_predicted: false })] })), []);
});

Deno.test('evaluate: результат не занесён через 12 ч после гонки', () => {
  const at = new Date('2026-10-12T01:00:00Z'); // гонка 11.10 12:00 UTC, прошло 13 ч
  const s = snap({
    now: at,
    runs: [run('notify:results', '2026-10-12T00:05:00Z')],
    keepalivePingedAt: '2026-10-11T18:17:00Z',
    races: [race({ status: 'open', has_result: false })],
  });
  assertEquals(keys(s), ['result_missing:20']);
});

Deno.test('evaluate: анонс недели — в пн 13:00 МСК ещё рано, в 14:00 тревога', () => {
  const r = race({ raceweek_announced_at: null, deadline_utc: '2026-10-08T20:00:00Z' });
  const mon13 = new Date('2026-10-05T10:00:00Z');
  const mon14 = new Date('2026-10-05T11:00:00Z');
  const base = { keepalivePingedAt: '2026-10-05T06:17:00Z', races: [r] };
  assertEquals(keys(snap({ ...base, now: mon13, runs: [run('notify:results', '2026-10-05T08:05:00Z')] })), []);
  assertEquals(keys(snap({ ...base, now: mon14, runs: [run('notify:results', '2026-10-05T10:05:00Z')] })), ['raceweek_missing:20']);
});

Deno.test('evaluate: в день дедлайна к 21:00 МСК не было напоминания', () => {
  const at = new Date('2026-10-08T18:30:00Z'); // чт 21:30 МСК, дедлайн в 23:00
  const s = snap({ now: at, runs: [run('notify:results', '2026-10-08T18:05:00Z')], races: [race()] });
  assertEquals(keys(s), ['deadline_reminder_missing:20']);
});

Deno.test('evaluate: напоминание в день дедлайна было — тревоги нет', () => {
  const at = new Date('2026-10-08T18:30:00Z');
  const s = snap({
    now: at,
    runs: [run('notify:deadline', '2026-10-08T07:05:00Z'), run('notify:results', '2026-10-08T18:05:00Z', true, [], 2)],
    races: [race()],
  });
  assertEquals(keys(s), []);
});

Deno.test('evaluate: напоминание о дедлайне не проверяем до первого пульса нового кода', () => {
  const at = new Date('2026-10-08T18:30:00Z');
  assertEquals(keys(snap({ now: at, runs: [], everHadGhaRun: false, races: [race()] })), []);
});

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: 1,
    key: 'gha_silent',
    details: 'GitHub Actions молчит',
    opened_at: '2026-10-08T09:50:00Z',
    notified_at: null,
    resolved_at: null,
    resolution_notified_at: null,
    ...over,
  };
}

Deno.test('planNotifications: в тихие часы ничего не шлём и ничего не помечаем', () => {
  const night = new Date('2026-10-08T21:00:00Z'); // 00:00 МСК
  assertEquals(planNotifications([incident()], [], night), { text: null, notifiedIds: [], resolutionNotifiedIds: [] });
});

Deno.test('planNotifications: новый инцидент — в разделе «Новое»', () => {
  const p = planNotifications([incident()], [], NOW);
  assert(p.text!.includes('🔴 <b>Новое</b>'));
  assert(p.text!.includes('GitHub Actions молчит'));
  assertEquals(p.notifiedIds, [1]);
});

Deno.test('planNotifications: напоминание не раньше чем через 6 ч', () => {
  const recent = incident({ notified_at: '2026-10-08T05:00:00Z' }); // 4.9 ч назад
  const old = incident({ id: 2, notified_at: '2026-10-08T03:00:00Z' }); // 6.9 ч назад
  const p = planNotifications([recent, old], [], NOW);
  assertEquals(p.notifiedIds, [2]);
  assert(p.text!.includes('Всё ещё не починено'));
});

Deno.test('planNotifications: разовый инцидент без напоминаний', () => {
  const warn = incident({ key: 'warn:admin-notify:abc', notified_at: '2026-10-07T00:00:00Z' });
  assertEquals(planNotifications([warn], [], NOW).text, null);
});

Deno.test('planNotifications: восстановилось и «было в тихие часы»', () => {
  const recovered = incident({ id: 3, notified_at: '2026-10-08T08:00:00Z', resolved_at: '2026-10-08T09:40:00Z' });
  const passed = incident({ id: 4, key: 'keepalive_stale', details: 'Keepalive молчит', opened_at: '2026-10-08T00:00:00Z', resolved_at: '2026-10-08T03:00:00Z' });
  const p = planNotifications([], [recovered, passed], NOW);
  assert(p.text!.includes('✅ <b>Восстановилось</b>'));
  assert(p.text!.includes('Был сбой в тихие часы'));
  assertEquals(p.resolutionNotifiedIds, [3, 4]);
});

Deno.test('planNotifications: экранирует HTML в тексте инцидента', () => {
  const p = planNotifications([incident({ details: 'ошибка <script> & co' })], [], NOW);
  assert(p.text!.includes('ошибка &lt;script&gt; &amp; co'));
});

Deno.test('planNotifications: длинное сообщение режется по строке, теги не разрываются', () => {
  const many = Array.from({ length: 60 }, (_, i) => incident({ id: i + 1, key: `k${i}`, details: 'х'.repeat(90) }));
  const t = planNotifications(many, [], NOW).text!;
  assert(t.length <= 4100);
  assertEquals(t.split('<b>').length, t.split('</b>').length);
});
