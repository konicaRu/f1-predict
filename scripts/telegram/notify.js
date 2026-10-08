const { q, close, recordRun, sendTelegram, sendTelegramPhoto, readEnv } = require('./lib');

const SITE_URL = 'https://konicaru.github.io/f1-predict';
const BOT_USERNAME = 'che_f1_predict_bot';
const MINI_APP_SHORT_NAME = 'predict'; // зарегистрировано через BotFather /newapp (Task 10)
const DEADLINE_BANNER_URL = `${SITE_URL}/telegram-banner.png`;

// Сайт на GitHub Pages из РФ открывается только через VPN — напоминаем рядом с каждой ссылкой.
function siteLink(path) {
  return `${SITE_URL}${path} (нужен VPN)`;
}

// Формат без короткого имени приложения (t.me/<bot>?startapp=) работает на мобильных, но даёт
// BOT_INVALID на Telegram Desktop (известное ограничение платформы) — нужен полный вид ссылки
// с зарегистрированным Mini App.
function predictButton(raceId) {
  return { inline_keyboard: [[{ text: 'Сделать прогноз', url: `https://t.me/${BOT_USERNAME}/${MINI_APP_SHORT_NAME}?startapp=predict_${raceId}` }]] };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toMskTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Название дня недели дедлайна по МСК — раньше в текстах сообщений было зашито строкой
// «четверг», что давало неверный текст для гонок со сдвинутым уикендом (напр. Azerbaijan GP
// round 15, дедлайн в среду — гонка в субботу вместо воскресенья, см. MEMORY.md 2026-09-15).
function mskWeekday(iso) {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long' });
}

// true, если СЕГОДНЯ (по календарной дате МСК) — день дедлайна ЭТОЙ гонки. Раньше было жёстко
// isMskThursday() — не подходило по той же причине, что и mskWeekday() выше.
function isDeadlineDayMsk(deadlineUtc, date = new Date()) {
  const mskDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  return mskDate(new Date(deadlineUtc)) === mskDate(date);
}

function notVotedNames(users, votedIds) {
  const voted = new Set(votedIds);
  return users
    .filter((u) => !voted.has(u.id))
    .map((u) => u.display_name)
    .sort((a, b) => a.localeCompare(b));
}

// Открытие гонки раньше было полностью ручным (кнопка в Админке) — если про неё забыли,
// напоминания молча не уходят (нет открытой гонки = нечего слать). Раз расписание дедлайнов
// известно заранее, открываем сами: вызывается на каждом запуске notify.js (main()), в том числе
// на самом частом кроне (autoresults/results, раз в 2 часа) — переживает пропуск отдельных
// cron-слотов GitHub Actions (см. инцидент 2026-08-31, пропало 5 слотов подряд за одно утро).
// open_race() идемпотентна (demo->open, no-op если уже open) — безопасно вызывать каждый раз.
async function ensureCurrentWeekOpen() {
  const { rows } = await q(`
    select id, name from races
    where status = 'demo'
      and date_trunc('week', deadline_utc at time zone 'Europe/Moscow')
        = date_trunc('week', now() at time zone 'Europe/Moscow')
  `);
  for (const r of rows) {
    await q('select open_race($1)', [r.id]);
    console.log(`ensureOpen: автоматически открыл ${r.name} (id=${r.id})`);
  }
}

async function thisWeekOpenRaces() {
  const { rows } = await q(`
    select id, round, name, deadline_utc, race_datetime_utc, raceweek_announced_at
    from races
    where status = 'open'
      and date_trunc('week', deadline_utc at time zone 'Europe/Moscow')
        = date_trunc('week', now() at time zone 'Europe/Moscow')
    order by round
  `);
  return rows;
}

// Сравнивает текущий пул гонки с активными по Jolpica и увиденными в OpenF1 пилотами.
// Возвращает, кого добавить и откуда узнали (для админ-сообщения) — отсортировано по driverId
// для детерминированного вывода. openf1Codes может быть null (сессий уикенда ещё нет — это ожидаемо).
function diffPoolAdditions(currentPoolIds, activeDriverIds, openf1Codes, codeToId) {
  const bySource = new Map();
  for (const id of activeDriverIds) {
    if (currentPoolIds.has(id)) continue;
    if (!bySource.has(id)) bySource.set(id, new Set());
    bySource.get(id).add('jolpica');
  }
  if (openf1Codes) {
    for (const code of openf1Codes) {
      const id = codeToId.get(code);
      if (!id || currentPoolIds.has(id)) continue;
      if (!bySource.has(id)) bySource.set(id, new Set());
      bySource.get(id).add('openf1');
    }
  }
  return [...bySource.entries()]
    .map(([driverId, sources]) => ({ driverId, sources: [...sources].sort() }))
    .sort((a, b) => a.driverId.localeCompare(b.driverId));
}

const OPENF1_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // ±3 дня — тот же паттерн, что scripts/autoresults/openf1.js

// Состав пилотов ближайшей по дате сессии этого гоночного уикенда (Practice/Qualifying/Race — любая,
// нужен самый ранний доступный сигнал). Возвращает null, если в окне ±3 дня вообще нет сессий с
// данными (уикенд ещё не начался — это ожидаемо, не ошибка). Бросает исключение при сетевой/HTTP
// ошибке — вызывающий код сам решает, что с этим делать (см. checkDriverPool).
async function fetchOpenF1SessionCodes(raceDatetimeUtc) {
  if (!raceDatetimeUtc) return null;
  const res = await fetch('https://api.openf1.org/v1/sessions?year=2026');
  if (!res.ok) throw new Error(`OpenF1 sessions HTTP ${res.status}`);
  const sessions = await res.json();
  const target = new Date(raceDatetimeUtc).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const s of sessions) {
    const diff = Math.abs(new Date(s.date_start).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  if (!best || bestDiff > OPENF1_WINDOW_MS) return null;

  const driversRes = await fetch(`https://api.openf1.org/v1/drivers?session_key=${best.session_key}`);
  if (!driversRes.ok) throw new Error(`OpenF1 drivers HTTP ${driversRes.status}`);
  const drivers = await driversRes.json();
  return new Set(drivers.map((d) => d.name_acronym).filter(Boolean));
}

// Автопроверка состава: подтягивает Jolpica (importDrivers, безопасно — только active=true,
// никого не деактивирует), сверяет с OpenF1 по ближайшей сессии уикенда (best-effort, часто пусто
// до пятницы — это ожидаемо), расширяет race_driver_pool открытых на этой неделе гонок и шлёт
// уведомление в оба чата, если что-то реально добавилось. Вызывается только из main() при
// mode === 'raceweek' || mode === 'deadline' (см. ниже) — не на каждом 2-часовом autoresults-крон.
// warnings — сюда складываются проглоченные сбои подшагов: прогон не валим, но сторож о них сообщит.
async function checkDriverPool(warnings = []) {
  try {
    const { importDrivers } = require('../import/import.js');
    await importDrivers();
  } catch (e) {
    console.warn('checkDriverPool: importDrivers сорвался, продолжаем с уже имеющимися данными:', e.message);
    warnings.push(`checkDriverPool: синк пилотов из Jolpica сорвался: ${e.message}`);
  } finally {
    try {
      await require('../import/lib').close();
    } catch (_) {
      /* уже закрыт или не открывался */
    }
  }

  const races = await thisWeekOpenRaces();
  if (races.length === 0) {
    console.log('checkDriverPool: нет открытых гонок на этой неделе');
    return;
  }

  const { rows: driverRows } = await q('select id, code, name, active from drivers');
  const activeIds = new Set(driverRows.filter((d) => d.active).map((d) => d.id));
  const codeToId = new Map(driverRows.map((d) => [d.code, d.id]));
  const infoById = new Map(driverRows.map((d) => [d.id, d]));

  for (const race of races) {
    const { rows: poolRows } = await q('select driver_id from race_driver_pool where race_id = $1', [race.id]);
    const currentPoolIds = new Set(poolRows.map((r) => r.driver_id));

    let openf1Codes = null;
    try {
      openf1Codes = await fetchOpenF1SessionCodes(race.race_datetime_utc);
    } catch (e) {
      console.warn(`checkDriverPool: OpenF1 недоступен для ${race.name}:`, e.message);
      warnings.push(`checkDriverPool: OpenF1 недоступен для ${race.name}: ${e.message}`);
    }

    const additions = diffPoolAdditions(currentPoolIds, activeIds, openf1Codes, codeToId);
    if (additions.length === 0) continue;

    const codes = additions.map((a) => infoById.get(a.driverId)?.code || a.driverId);
    const adminLines = additions
      .map((a) => `${infoById.get(a.driverId)?.code || a.driverId} (${infoById.get(a.driverId)?.name || '?'}) — источник: ${a.sources.join('+')}`)
      .join('\n');
    // Шлём ДО записи в БД: если отправка сорвётся, инсерты не произойдут и diffPoolAdditions
    // пересчитает те же additions на следующем прогоне (тот же приём, что у raceweek()).
    await sendTelegram(
      `🔄 Автопроверка состава — ${escapeHtml(race.name)}:\n${escapeHtml(adminLines)}`,
      readEnv('TELEGRAM_ADMIN_CHAT_ID'),
    );
    await sendTelegram(
      `🔄 Состав ${escapeHtml(race.name)} обновлён: добавлен${codes.length > 1 ? 'ы' : ''} ${escapeHtml(codes.join(', '))}.`,
    );

    for (const { driverId, sources } of additions) {
      await q(
        'insert into race_driver_pool(race_id, driver_id, added_reason) values ($1,$2,$3) on conflict do nothing',
        [race.id, driverId, `автопроверка: ${sources.join('+')}`],
      );
    }
    console.log(`checkDriverPool: ${race.name} — добавлено ${codes.join(', ')}`);
  }
}

// Идемпотентна (гейт raceweek_announced_at, тот же приём, что у results()/telegram_announced_at) —
// поэтому безопасно звать на КАЖДОМ запуске notify.js (см. main()), а не только по понедельничному
// крону. Если понедельничный слот пропущен GitHub Actions — анонс всё равно уйдёт при следующем
// прогоне (максимум через ~2ч, самый частый крон в проекте), просто без "🏁 RACE WEEK" в
// правильный день недели.
async function raceweek() {
  const races = (await thisWeekOpenRaces()).filter((r) => !r.raceweek_announced_at);
  if (races.length === 0) {
    console.log('raceweek: анонсировать нечего (нет новой открытой гонки на этой неделе)');
    return;
  }
  for (const r of races) {
    const text =
      `🏁 RACE WEEK! На очереди <b>${escapeHtml(r.name)}</b> (раунд ${r.round}).\n` +
      `Дедлайн прогнозов — ${mskWeekday(r.deadline_utc)} ${toMskTime(r.deadline_utc)} МСК.\n` +
      `Ставь: ${siteLink('/predict')}`;
    await sendTelegram(text);
    await q('update races set raceweek_announced_at = now() where id = $1', [r.id]);
    console.log(`raceweek: отправлено для ${r.name}`);
  }
}

async function deadline() {
  const races = (await thisWeekOpenRaces()).filter((r) => new Date(r.deadline_utc) > new Date());
  if (races.length === 0) {
    console.log('deadline: нет открытой гонки с дедлайном впереди, ничего не шлём');
    return;
  }
  for (const r of races) {
    let text =
      `⏰ Не забудь сделать прогноз на <b>${escapeHtml(r.name)}</b>!\n` +
      `Дедлайн — ${mskWeekday(r.deadline_utc)} ${toMskTime(r.deadline_utc)} МСК.\n` +
      siteLink('/predict');
    if (isDeadlineDayMsk(r.deadline_utc)) {
      const { rows: predRows } = await q('select user_id from predictions where race_id = $1', [r.id]);
      const { rows: userRows } = await q('select id, display_name from users');
      const missing = notVotedNames(userRows, predRows.map((p) => p.user_id));
      text +=
        missing.length === 0
          ? '\n\nВсе уже сделали прогноз, красавцы! 👍'
          : `\n\nЕщё не сделали: ${missing.map(escapeHtml).join(', ')}`;
    }
    await sendTelegramPhoto(DEADLINE_BANNER_URL, text, predictButton(r.id));
    console.log(`deadline: отправлено для ${r.name}`);
  }
}

async function driverCodeMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((d) => [d.id, d.code]));
}

function codeFor(id, codeOf) {
  const code = codeOf.get(id);
  if (!code) console.warn('нет кода для пилота', id);
  return code || id;
}

function podiumText(positions, codeOf) {
  return positions
    .slice(0, 3)
    .map((id) => codeFor(id, codeOf))
    .join('-');
}

function roundWinnerLine(scoreRows) {
  if (scoreRows.length === 0) return null;
  const top = scoreRows[0].points;
  const winners = scoreRows.filter((s) => s.points === top).map((s) => escapeHtml(s.user));
  return `🏆 Лучший прогноз тура — ${winners.join(', ')} (${top} очков)!`;
}

function rankStandings(rows) {
  const sorted = [...rows].sort(
    (a, b) =>
      b.points - a.points ||
      b.exact - a.exact ||
      b.best_race - a.best_race ||
      a.display_name.localeCompare(b.display_name),
  );
  let rank = 0;
  let prev = null;
  return sorted.map((r, i) => {
    if (!prev || r.points !== prev.points || r.exact !== prev.exact || r.best_race !== prev.best_race) {
      rank = i + 1;
    }
    prev = r;
    return { ...r, rank };
  });
}

// Кто куда сдвинулся при пересмотре результата: «GAS 3→7, HAD 4→3». Сначала по новой позиции,
// выбывшие из топ-10 — в конце. Пусто, если ничего не изменилось.
function resultDiff(before, after, codeOf) {
  const posOf = (arr, id) => (arr.indexOf(id) === -1 ? null : arr.indexOf(id) + 1);
  const ids = [...new Set([...after, ...before])];
  return ids
    .map((id) => ({ id, from: posOf(before, id), to: posOf(after, id) }))
    .filter((m) => m.from !== m.to)
    .sort((a, b) => (a.to ?? 99) - (b.to ?? 99))
    .map((m) => `${codeFor(m.id, codeOf)} ${m.from ?? 'вне топ-10'}→${m.to ?? 'вне топ-10'}`)
    .join(', ');
}

// Причина, с которой autoresults/fetch.js заносит пересмотренный результат (см. recheck там).
const RECHECK_REASON = 'auto-recheck';

async function results() {
  const { rows } = await q(`
    select id, round, name
    from races
    where status = 'resulted' and scored = true and telegram_announced_at is null
    order by round
  `);
  if (rows.length === 0) {
    console.log('results: новых финальных результатов нет');
    return;
  }
  const codeOf = await driverCodeMap();

  const { rows: standingRows } = await q(`
    select u.id, u.display_name,
           coalesce(sum(cs.points), 0) as points,
           coalesce(sum(cs.exact_hits), 0) as exact,
           coalesce(max(cs.points), 0) as best_race
    from users u
    left join (
      select s.user_id, s.race_id, s.points, s.exact_hits
      from scores s
      join races r on r.id = s.race_id
      where r.scored = true
    ) cs on cs.user_id = u.id
    group by u.id, u.display_name
  `);
  const standingsText = rankStandings(standingRows)
    .map((sr) => `${sr.rank}. ${escapeHtml(sr.display_name)} — ${sr.points}`)
    .join('\n');

  for (const r of rows) {
    const { rows: resRows } = await q('select positions from results where race_id = $1', [r.id]);
    const resultPositions = resRows[0].positions;
    const top10 = resultPositions.map((id, i) => `${i + 1}. ${codeFor(id, codeOf)}`).join('  ');

    const { rows: scoreRows } = await q(
      `
      select s.user_id, u.display_name as "user", s.points, s.exact_hits
      from scores s
      join users u on u.id = s.user_id
      where s.race_id = $1
      order by s.points desc
    `,
      [r.id],
    );
    const { rows: predRows } = await q('select user_id, positions from predictions where race_id = $1', [r.id]);
    const predOf = new Map(predRows.map((p) => [p.user_id, p.positions]));

    const scoresText = scoreRows
      .map((s, i) => {
        const podium = podiumText(predOf.get(s.user_id), codeOf);
        return `${i + 1}. ${escapeHtml(s.user)} — подиум ${podium} → ${s.points} (${s.exact_hits} точных)`;
      })
      .join('\n');

    const winnerLine = roundWinnerLine(scoreRows);

    // Повторное объявление после автопересмотра (штраф после финиша): fetch.js сбросил
    // telegram_announced_at и записал правку с причиной RECHECK_REASON — показываем, что изменилось.
    // Холостые записи (before = after: ретрай q() или перезанос тем же) пропускаем, иначе diff пуст.
    const { rows: lastChange } = await q(
      `select before, after, reason from result_changes
       where race_id = $1 and before is distinct from after
       order by changed_at desc, id desc limit 1`,
      [r.id],
    );
    const ch = lastChange[0];
    const isRecheck = ch && ch.before && ch.reason && ch.reason.startsWith(RECHECK_REASON);
    const header = isRecheck
      ? `🔁 Результат <b>${escapeHtml(r.name)}</b> пересмотрен (штрафы после финиша), очки пересчитаны.\n` +
        `Изменилось: ${resultDiff(ch.before, ch.after, codeOf)}\n\n`
      : `🏁 Финиш <b>${escapeHtml(r.name)}</b>!\n\n`;

    const text =
      header +
      `Топ-10:\n${top10}\n\n` +
      `Прогнозы и очки:\n${scoresText}\n\n` +
      (winnerLine ? `${winnerLine}\n\n` : '') +
      `Общий зачёт сезона:\n${standingsText}`;
    await sendTelegram(text);
    await q('update races set telegram_announced_at = now() where id = $1', [r.id]);
    console.log(`results: отправлено для ${r.name}`);
  }
}

async function remind() {
  const { rows } = await q(`
    select id, round, name
    from races
    where status = 'open' and race_datetime_utc < now()
    order by round
  `);
  if (rows.length === 0) {
    console.log('remind: просроченных гонок нет');
    return;
  }
  for (const r of rows) {
    const text =
      `⚠️ Автопоиск не нашёл результат <b>${escapeHtml(r.name)}</b> — занеси вручную в Админке.\n` +
      siteLink('/admin');
    await sendTelegram(text);
    console.log(`remind: отправлено для ${r.name}`);
  }
}

async function adminflush() {
  const adminChatId = readEnv('TELEGRAM_ADMIN_CHAT_ID');
  const { rows } = await q('select id, text from admin_notification_queue order by created_at');
  if (rows.length === 0) {
    console.log('adminflush: очередь пуста');
    return;
  }
  for (const row of rows) {
    await sendTelegram(row.text, adminChatId);
    await q('delete from admin_notification_queue where id = $1', [row.id]);
  }
  console.log(`adminflush: отправлено и удалено ${rows.length}`);
}

// Тихие часы для тревог — 23:00-10:00 МСК, как у сторожа (supabase/functions/watchdog/checks.ts).
function isAlertQuietHours(date = new Date()) {
  const h = Number(date.toLocaleString('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }));
  return h >= 23 || h < 10;
}

function toMskDateTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const WATCHDOG_STALE_MS = 60 * 60 * 1000; // сторож ходит раз в 15 мин — час тишины значит, что он мёртв
const ALERT_REMIND_MS = 6 * 60 * 60 * 1000;

// Обратное наблюдение. Сторож живёт в Supabase (pg_cron) и сообщает обо всём, кроме собственной
// смерти — её видно только отсюда, из независимой инфраструктуры GitHub Actions. Повторы гасит тот же
// журнал watchdog_incidents, а закроет инцидент и пришлёт «восстановилось» сам оживший сторож.
async function checkWatchdogAlive(now = new Date()) {
  const { rows } = await q("select max(ran_at) as last from job_runs where job = 'watchdog' and ok");
  const last = rows[0].last;
  if (!last) return; // сторож ещё ни разу не отработал успешно (до деплоя) — тревожить не о чем
  if (now - new Date(last) < WATCHDOG_STALE_MS) return;

  const details =
    `Сторож (pg_cron → Edge Function watchdog) не отмечался успешно с ${toMskDateTime(last)} МСК — ` +
    `проверки не выполняются. Смотреть: Supabase Dashboard → Edge Functions → watchdog → Logs.`;
  await q(
    `insert into watchdog_incidents (key, details) values ('watchdog_silent', $1)
     on conflict (key) where resolved_at is null do update set details = excluded.details, last_seen_at = now()`,
    [details],
  );
  const { rows: open } = await q(
    "select id, notified_at from watchdog_incidents where key = 'watchdog_silent' and resolved_at is null",
  );
  const incident = open[0];
  if (!incident || isAlertQuietHours(now)) return;
  if (incident.notified_at && now - new Date(incident.notified_at) < ALERT_REMIND_MS) return;
  await sendTelegram(`🚨 <b>Сторож F1 Predict</b>\n\n🔴 ${escapeHtml(details)}`, readEnv('TELEGRAM_ADMIN_CHAT_ID'));
  await q('update watchdog_incidents set notified_at = now() where id = $1', [incident.id]);
}

async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results, remind, adminflush };
  if (!modes[mode]) {
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results|remind|adminflush`);
    process.exit(1);
  }
  const job = `notify:${mode}`;
  // Проглоченные сбои best-effort-подшагов: прогон из-за них не валим, но пишем в пульс —
  // сторож пришлёт админу разовое предупреждение (раньше они уходили только в лог Actions).
  const warnings = [];
  try {
    await ensureCurrentWeekOpen();
    await raceweek(); // идемпотентна — подстраховка, если понедельничный слот пропал (см. её комментарий)
    // Раньше очередь разгружал только один крон-слот раз в сутки (07:05 UTC) — если именно он
    // пропадал (баг GitHub Actions, см. MEMORY.md; живьём поймано 2026-10-08: пропало ~4 часа
    // подряд, включая этот слот, два уведомления о прогнозах зависли в очереди на часы), очередь
    // стояла до следующего утра. adminflush() идемпотентна (пустая очередь — no-op), поэтому теперь
    // зовём на КАЖДОМ прогоне (их 12+/неделю, включая /2ч results) — любой другой уцелевший слот
    // разгрузит очередь вместо пропавшего.
    try {
      await adminflush();
    } catch (e) {
      console.warn('adminflush: сорвался целиком, продолжаем основной режим:', e.message);
      warnings.push(`adminflush: ${e.message}`);
    }
    if (mode === 'raceweek' || mode === 'deadline') {
      // Best-effort, как и её собственные подшаги (importDrivers/OpenF1) — падение автопроверки
      // состава не должно рвать основной режим этого крон-слота (deadline-напоминание и т.п.).
      try {
        await checkDriverPool(warnings);
      } catch (e) {
        console.warn('checkDriverPool: сорвалась целиком, продолжаем основной режим:', e.message);
        warnings.push(`checkDriverPool: ${e.message}`);
      }
      // Раньше aiplayer жил только на одном отдельном крон-слоте раз в неделю — если тот единственный
      // слот пропадал (баг GitHub Actions, см. MEMORY.md, живьём поймано 2026-09-23), GridBot молча
      // не участвовал в гонке. Теперь зовём на каждом raceweek/deadline прогоне (их 5 в неделю) —
      // сам no-op, если уже поставил прогноз или дедлайн прошёл (гейты внутри predict.js main()).
      try {
        const { main: runAiPlayer } = require('../ai-player/predict.js');
        const aiWarnings = (await runAiPlayer()) || [];
        warnings.push(...aiWarnings.map((w) => `aiplayer: ${w}`));
      } catch (e) {
        console.warn('aiplayer: сорвался целиком, продолжаем основной режим:', e.message);
        warnings.push(`aiplayer: ${e.message}`);
      }
    }
    await modes[mode]();
    try {
      await checkWatchdogAlive();
    } catch (e) {
      warnings.push(`проверка сторожа: ${e.message}`);
    }
    await recordRun(job, true, warnings);
  } catch (e) {
    // Если упала сама БД, пульс тоже не запишется — тогда сработает шаг if: failure() в workflow
    // (прямое сообщение в Telegram), а сторож заметит отсутствие пульса.
    await recordRun(job, false, [e.message, ...warnings]);
    throw e;
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });
}

module.exports = { mskWeekday, isDeadlineDayMsk, isAlertQuietHours, notVotedNames, podiumText, roundWinnerLine, rankStandings, predictButton, diffPoolAdditions, resultDiff };
