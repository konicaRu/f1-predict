const { q, close, sendTelegram } = require('./lib');

const SITE_URL = 'https://konicaru.github.io/f1-predict';

function toMskTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
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
      `🏁 RACE WEEK! На очереди <b>${r.name}</b> (раунд ${r.round}).\n` +
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
  for (const r of races) {
    const text =
      `⏰ Не забудь поставить прогноз на <b>${r.name}</b>!\n` +
      `Дедлайн — четверг ${toMskTime(r.deadline_utc)} МСК.\n` +
      `${SITE_URL}/predict`;
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
  for (const r of rows) {
    const { rows: resRows } = await q('select positions from results where race_id = $1', [r.id]);
    const positions = resRows[0].positions;
    const top10 = positions.map((id, i) => `${i + 1}. ${codeFor(id, codeOf)}`).join('  ');

    const { rows: scoreRows } = await q(
      `
      select u.display_name as "user", s.points, s.exact_hits
      from scores s
      join users u on u.id = s.user_id
      where s.race_id = $1
      order by s.points desc
    `,
      [r.id],
    );
    const scoresText = scoreRows
      .map((s, i) => `${i + 1}. ${s.user} — ${s.points} (${s.exact_hits} точных)`)
      .join('\n');

    const text = `🏁 Финиш <b>${r.name}</b>!\n\nТоп-10:\n${top10}\n\nОчки за гонку:\n${scoresText}`;
    await sendTelegram(text);
    await q('update races set telegram_announced_at = now() where id = $1', [r.id]);
    console.log(`results: отправлено для ${r.name}`);
  }
}

async function main() {
  const mode = process.argv[2];
  const modes = { raceweek, deadline, results };
  if (!modes[mode]) {
    console.error(`ERR неизвестный режим "${mode}", ожидается raceweek|deadline|results`);
    process.exit(1);
  }
  await modes[mode]();
  await close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
