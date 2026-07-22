const { q, close, sendTelegram } = require('./lib');

const SITE_URL = 'https://konicaru.github.io/f1-predict';

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

function isMskThursday(date = new Date()) {
  return date.toLocaleString('en-US', { timeZone: 'Europe/Moscow', weekday: 'short' }) === 'Thu';
}

function notVotedNames(users, votedIds) {
  const voted = new Set(votedIds);
  return users
    .filter((u) => !voted.has(u.id))
    .map((u) => u.display_name)
    .sort((a, b) => a.localeCompare(b));
}

async function thisWeekOpenRaces() {
  const { rows } = await q(`
    select id, round, name, deadline_utc
    from races
    where status = 'open'
      and date_trunc('week', deadline_utc at time zone 'Europe/Moscow')
        = date_trunc('week', now() at time zone 'Europe/Moscow')
    order by round
  `);
  return rows;
}

async function raceweek() {
  const races = await thisWeekOpenRaces();
  if (races.length === 0) {
    console.log('raceweek: нет открытой гонки на этой неделе, ничего не шлём');
    return;
  }
  for (const r of races) {
    const text =
      `🏁 RACE WEEK! На очереди <b>${escapeHtml(r.name)}</b> (раунд ${r.round}).\n` +
      `Дедлайн прогнозов — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `Ставь: ${SITE_URL}/predict`;
    await sendTelegram(text);
    console.log(`raceweek: отправлено для ${r.name}`);
  }
}

async function deadline() {
  const races = (await thisWeekOpenRaces()).filter((r) => new Date(r.deadline_utc) > new Date());
  if (races.length === 0) {
    console.log('deadline: нет открытой гонки с дедлайном впереди, ничего не шлём');
    return;
  }
  const thursday = isMskThursday();
  for (const r of races) {
    let text =
      `⏰ Не забудь сделать прогноз на <b>${escapeHtml(r.name)}</b>!\n` +
      `Дедлайн — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `${SITE_URL}/predict`;
    if (thursday) {
      const { rows: predRows } = await q('select user_id from predictions where race_id = $1', [r.id]);
      const { rows: userRows } = await q('select id, display_name from users');
      const missing = notVotedNames(userRows, predRows.map((p) => p.user_id));
      text +=
        missing.length === 0
          ? '\n\nВсе уже сделали прогноз, красавцы! 👍'
          : `\n\nЕщё не сделали: ${missing.map(escapeHtml).join(', ')}`;
    }
    await sendTelegram(text);
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

    const text =
      `🏁 Финиш <b>${escapeHtml(r.name)}</b>!\n\n` +
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
      `${SITE_URL}/admin`;
    await sendTelegram(text);
    console.log(`remind: отправлено для ${r.name}`);
  }
}

async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results, remind };
  if (!modes[mode]) {
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results|remind`);
    process.exit(1);
  }
  await modes[mode]();
  await close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });
}

module.exports = { isMskThursday, notVotedNames, podiumText, roundWinnerLine, rankStandings };
