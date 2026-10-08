// Чистая логика сторожа: снимок состояния -> список проблем, инциденты -> что отправить админу.
// Без БД и сети — всё это покрыто checks.test.ts. Ввод-вывод — в index.ts.

export type JobRun = { id: number; job: string; ran_at: string; ok: boolean; errors: string[] };

export type WatchedRace = {
  id: number;
  name: string;
  status: string;
  deadline_utc: string;
  race_datetime_utc: string | null;
  raceweek_announced_at: string | null;
  gridbot_predicted: boolean;
  has_result: boolean;
};

export type Snapshot = {
  now: Date;
  runs: JobRun[]; // пульс за последние RUNS_WINDOW_HOURS
  // Был ли хоть один пульс GitHub Actions за всю историю. До первого прогона нового кода
  // (пока не запушен) таблица пуста — без этого гейта сторож сразу кричал бы «GitHub молчит».
  everHadGhaRun: boolean;
  keepalivePingedAt: string | null;
  queueOldestAt: string | null;
  races: WatchedRace[]; // status in ('open','closed')
};

export type Failing = { key: string; details: string };

export type Incident = {
  id: number;
  key: string;
  details: string;
  opened_at: string;
  notified_at: string | null;
  resolved_at: string | null;
  resolution_notified_at: string | null;
};

export type Plan = { text: string | null; notifiedIds: number[]; resolutionNotifiedIds: number[] };

const H = 60 * 60 * 1000;

export const RUNS_WINDOW_HOURS = 48;
// Слот results идёт каждые 2 ч, но GitHub сам опаздывает до ~2 ч под нагрузкой (живьём неделя
// 2026-10-01..07: запуски в 08:31, 14:25, 17:22 вместо :05). 4 ч — уже не опоздание, а пропажа.
export const GHA_SILENT_HOURS = 4;
export const KEEPALIVE_STALE_HOURS = 26; // слоты 2 раза в сутки + запас на опоздание
export const GRIDBOT_DEADLINE_HOURS = 6;
export const RESULT_MISSING_HOURS = 12;
export const REMIND_HOURS = 6;

// Задачи GitHub Actions — «состояние» (последний прогон упал = инцидент до следующего успешного).
export function isGhaJob(job: string): boolean {
  return job.startsWith('notify:') || job === 'autoresults';
}

// Разовые инциденты (предупреждения и сбои событийных задач): одно сообщение, без напоминаний
// и без «восстановилось» — закрываются сами, когда прогон уходит из окна пульса.
export function isOneShot(key: string): boolean {
  return key.startsWith('warn:');
}

type MskParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function mskParts(date: Date): MskParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')],
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function mskYmd(date: Date): string {
  const p = mskParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Понедельник МСК-недели, в которую попадает дата — ключ для «та же неделя».
export function mskWeekKey(date: Date): string {
  const p = mskParts(date);
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day) - (p.weekday - 1) * 24 * H);
  return monday.toISOString().slice(0, 10);
}

export function fmtMsk(iso: string): string {
  const p = mskParts(new Date(iso));
  return `${pad(p.day)}.${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// Тихие часы для тревог — 23:00-10:00 МСК (решение пользователя 2026-10-08). Отличаются от тихих
// часов обычных admin-уведомлений (22-10, format.ts в admin-notify) — это сознательно.
export function isAlertQuietHours(date: Date): boolean {
  const h = mskParts(date).hour;
  return h >= 23 || h < 10;
}

// Короткий стабильный хеш текста — ключ разового инцидента: одно и то же предупреждение из разных
// прогонов (напр. каждые 2 ч) схлопывается в один инцидент, а не шлёт сообщение на каждый прогон.
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function clip(s: string, max = 300): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function hoursAgo(iso: string, now: Date): string {
  return ((now.getTime() - Date.parse(iso)) / H).toFixed(1);
}

export function evaluate(s: Snapshot): Failing[] {
  const out = new Map<string, Failing>();
  const add = (key: string, details: string) => {
    if (!out.has(key)) out.set(key, { key, details });
  };
  const now = s.now.getTime();
  const msk = mskParts(s.now);

  // 1. GitHub Actions не запускается вообще — главный сценарий 2026-10-08.
  const gha = s.runs.filter((r) => isGhaJob(r.job));
  if (s.everHadGhaRun) {
    const last = gha.reduce<JobRun | null>((a, r) => (!a || Date.parse(r.ran_at) > Date.parse(a.ran_at) ? r : a), null);
    if (!last) {
      add('gha_silent', `GitHub Actions молчит больше ${RUNS_WINDOW_HOURS} ч — напоминания, автозабор результатов и разгрузка очереди не выполняются.`);
    } else if (now - Date.parse(last.ran_at) > GHA_SILENT_HOURS * H) {
      add(
        'gha_silent',
        `GitHub Actions молчит: последний прогон автоматики был ${fmtMsk(last.ran_at)} МСК (${hoursAgo(last.ran_at, s.now)} ч назад). ` +
          `Напоминания, автозабор результатов и разгрузка очереди не выполняются.`,
      );
    }
  }

  // 2. Последний прогон задачи GitHub Actions упал — инцидент до следующего успешного прогона.
  const latest = new Map<string, JobRun>();
  for (const r of gha) {
    const prev = latest.get(r.job);
    if (!prev || Date.parse(r.ran_at) > Date.parse(prev.ran_at)) latest.set(r.job, r);
  }
  for (const [job, r] of latest) {
    if (!r.ok) add(`job_failed:${job}`, `Прогон ${job} упал ${fmtMsk(r.ran_at)} МСК: ${clip(r.errors.join('; ')) || 'без текста ошибки'}`);
  }

  // 3. Проглоченные ошибки best-effort-подшагов и сбои событийных задач (admin-notify, сам сторож).
  for (const r of s.runs) {
    if (isGhaJob(r.job) && !r.ok) continue; // уже покрыто job_failed
    for (const e of r.errors) {
      if (!e) continue;
      add(`warn:${r.job}:${hashText(e)}`, `${r.job} (${fmtMsk(r.ran_at)} МСК): ${clip(e)}`);
    }
  }

  // 4. Keepalive — если он стоит неделю, бесплатный Supabase засыпает целиком.
  if (!s.keepalivePingedAt || now - Date.parse(s.keepalivePingedAt) > KEEPALIVE_STALE_HOURS * H) {
    add(
      'keepalive_stale',
      s.keepalivePingedAt
        ? `Keepalive не пинговал БД с ${fmtMsk(s.keepalivePingedAt)} МСК. После 7 дней без активности бесплатный Supabase засыпает.`
        : 'Keepalive ни разу не пинговал БД.',
    );
  }

  // 5. Очередь admin-уведомлений застряла. Записи попадают туда только в тихие часы 22-10 и
  // должны уйти в 10:05; к полудню их там быть не должно.
  if (s.queueOldestAt && msk.hour >= 12 && msk.hour < 22 && now - Date.parse(s.queueOldestAt) > H) {
    add('queue_stuck', `В очереди admin-уведомлений висят сообщения с ${fmtMsk(s.queueOldestAt)} МСК — adminflush их не разослал.`);
  }

  for (const r of s.races) {
    const deadline = Date.parse(r.deadline_utc);
    const deadlineAhead = r.status === 'open' && deadline > now;

    // 6. GridBot не поставил прогноз, а дедлайн близко.
    if (deadlineAhead && deadline - now < GRIDBOT_DEADLINE_HOURS * H && !r.gridbot_predicted) {
      add(`gridbot_missing:${r.id}`, `GridBot не поставил прогноз на ${r.name}, до дедлайна меньше ${GRIDBOT_DEADLINE_HOURS} ч.`);
    }

    // 7. Результат не занесён спустя полсуток после гонки.
    if (r.race_datetime_utc && now - Date.parse(r.race_datetime_utc) > RESULT_MISSING_HOURS * H && !r.has_result) {
      add(
        `result_missing:${r.id}`,
        `Результат ${r.name} не занесён — гонка закончилась больше ${RESULT_MISSING_HOURS} ч назад. Если автозабор не справится, занести вручную в Админке.`,
      );
    }

    // 8. Анонс недели не ушёл: понедельничный слот 10:05 МСК + самовосстановление на каждом прогоне.
    if (
      deadlineAhead &&
      !r.raceweek_announced_at &&
      mskWeekKey(new Date(deadline)) === mskWeekKey(s.now) &&
      (msk.weekday > 1 || msk.hour >= 14)
    ) {
      add(`raceweek_missing:${r.id}`, `Анонс RACE WEEK для ${r.name} не ушёл в общий чат.`);
    }

    // 9. В день дедлайна не было ни одного успешного напоминания (слоты 10:05 и 19:05 МСК).
    // Зависит от пульса GitHub Actions — до первого прогона нового кода не проверяем.
    if (s.everHadGhaRun && deadlineAhead && mskYmd(new Date(deadline)) === mskYmd(s.now) && msk.hour >= 21) {
      const today = mskYmd(s.now);
      const sent = s.runs.some((x) => x.job === 'notify:deadline' && x.ok && mskYmd(new Date(x.ran_at)) === today);
      if (!sent) {
        add(
          `deadline_reminder_missing:${r.id}`,
          `В день дедлайна ${r.name} не ушло ни одного напоминания — список «кто ещё не проголосовал» участники не получили.`,
        );
      }
    }
  }

  return [...out.values()];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TELEGRAM_LIMIT = 4000; // у sendMessage 4096, оставляем запас

export function planNotifications(open: Incident[], resolvedPending: Incident[], now: Date): Plan {
  if (isAlertQuietHours(now)) return { text: null, notifiedIds: [], resolutionNotifiedIds: [] };

  const fresh = open.filter((i) => !i.notified_at);
  const remind = open.filter(
    (i) => i.notified_at && !isOneShot(i.key) && now.getTime() - Date.parse(i.notified_at) >= REMIND_HOURS * H,
  );
  const recovered = resolvedPending.filter((i) => !isOneShot(i.key) && i.notified_at);
  const passed = resolvedPending.filter((i) => !isOneShot(i.key) && !i.notified_at);

  const sections: string[] = [];
  const bullets = (items: Incident[], suffix: (i: Incident) => string = () => '') =>
    items.map((i) => `• ${escapeHtml(i.details)}${suffix(i)}`).join('\n');

  if (fresh.length) sections.push(`🔴 <b>Новое</b>\n${bullets(fresh)}`);
  if (remind.length) sections.push(`⏰ <b>Всё ещё не починено</b>\n${bullets(remind, (i) => ` (с ${fmtMsk(i.opened_at)})`)}`);
  if (recovered.length) {
    sections.push(`✅ <b>Восстановилось</b>\n${bullets(recovered, (i) => ` (было с ${fmtMsk(i.opened_at)} по ${fmtMsk(i.resolved_at!)})`)}`);
  }
  if (passed.length) {
    sections.push(
      `ℹ️ <b>Был сбой в тихие часы, уже прошёл</b>\n${bullets(passed, (i) => ` (с ${fmtMsk(i.opened_at)} по ${fmtMsk(i.resolved_at!)})`)}`,
    );
  }

  let text: string | null = null;
  if (sections.length) {
    text = `🚨 <b>Сторож F1 Predict</b>\n\n${sections.join('\n\n')}`;
    // Режем по переводу строки, а не посимвольно: каждая пара <b>…</b> живёт в одной строке,
    // разрезанный тег Telegram отверг бы целиком (parse_mode HTML) — и сторож падал бы каждые 15 мин.
    if (text.length > TELEGRAM_LIMIT) text = `${text.slice(0, text.lastIndexOf('\n', TELEGRAM_LIMIT))}\n…(обрезано)`;
  }

  return {
    text,
    notifiedIds: [...fresh, ...remind].map((i) => i.id),
    // Разовые сюда тоже попадают — помечаем без сообщения, чтобы не тащить их каждые 15 минут.
    resolutionNotifiedIds: resolvedPending.map((i) => i.id),
  };
}
