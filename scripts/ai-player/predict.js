const { q, close, fetchJolpica, askGemini, escapeHtml, sendTelegram } = require('./lib');

const PAST_SEASONS = [2023, 2024, 2025];

async function openRaceThisWeek() {
  const { rows } = await q(`
    select id, round, name, season, deadline_utc
    from races
    where status = 'open'
      and date_trunc('week', deadline_utc at time zone 'Europe/Moscow')
        = date_trunc('week', now() at time zone 'Europe/Moscow')
    order by round
    limit 1
  `);
  return rows[0] || null;
}

async function poolDrivers(raceId) {
  const { rows } = await q(`
    select d.id, d.code, d.name, d.team, d.standing
    from race_driver_pool p
    join drivers d on d.id = p.driver_id
    where p.race_id = $1
    order by coalesce(d.standing, 999), d.code
  `, [raceId]);
  return rows;
}

async function seasonResults(season) {
  const { rows } = await q(`
    select r.round, r.name, res.positions
    from results res
    join races r on r.id = res.race_id
    where r.season = $1 and res.positions is not null
    order by r.round
  `, [season]);
  return rows;
}

// Map(driverId -> Map(season -> {position, points})). Сезон, где гонщика нет в списке -> не участвовал.
async function pastSeasonStandings(driverIds) {
  const out = new Map(driverIds.map((id) => [id, new Map()]));
  for (const season of PAST_SEASONS) {
    let data;
    try {
      data = await fetchJolpica(`${season}/driverStandings`);
    } catch (e) {
      console.warn(`aiplayer: Jolpica ${season} standings недоступны: ${e.message}`);
      continue;
    }
    const list = (data && data.MRData && data.MRData.StandingsTable
      && data.MRData.StandingsTable.StandingsLists && data.MRData.StandingsTable.StandingsLists[0]
      && data.MRData.StandingsTable.StandingsLists[0].DriverStandings) || [];
    for (const entry of list) {
      const id = entry.Driver.driverId;
      if (out.has(id)) {
        out.get(id).set(season, { position: Number(entry.position), points: Number(entry.points) });
      }
    }
  }
  return out;
}

function buildPrompt(race, pool, driverCodeOf, ownResults, standingsMap) {
  const poolLines = pool.map((d) => {
    const seasons = standingsMap.get(d.id);
    const isRookie = seasons.size === 0;
    if (isRookie) {
      return `- ${d.code} (${d.name}, ${d.team || 'без команды'}) — НОВИЧОК в F1, данных о прошлых `
        + `сезонах F1 нет; используй свои общие знания о его карьере в младших сериях (напр. Ф2/Ф3), `
        + `если они у тебя есть`;
    }
    const history = PAST_SEASONS.map((s) => {
      const st = seasons.get(s);
      return st ? `${s}: P${st.position} (${st.points} очк.)` : `${s}: не участвовал`;
    }).join(', ');
    return `- ${d.code} (${d.name}, ${d.team || 'без команды'}): ${history}`;
  }).join('\n');

  const ownLines = ownResults.length === 0
    ? 'ещё не было завершённых гонок в этом сезоне'
    : ownResults.map((r) => `Раунд ${r.round} (${r.name}): топ-10 = `
        + r.positions.map((id) => driverCodeOf.get(id) || id).join('-')).join('\n');

  return `Ты — участник фан-лиги прогнозов Формулы-1. Составь прогноз топ-10 для гонки `
    + `"${race.name}" (раунд ${race.round}, сезон ${race.season}).\n\n`
    + `Состав пилотов этой гонки (ровно из этого списка выбери топ-10, никого другого):\n${poolLines}\n\n`
    + `Результаты уже прошедших гонок этого сезона:\n${ownLines}\n\n`
    + `Верни ровно 10 РАЗНЫХ кодов пилотов из списка выше, в порядке от P1 до P10, плюс короткое `
    + `(1-2 предложения) объяснение по-русски, почему именно так.`;
}

function isValidTop10(top10, pool) {
  if (!Array.isArray(top10) || top10.length !== 10) return false;
  const poolCodes = new Set(pool.map((d) => d.code));
  const unique = new Set(top10);
  if (unique.size !== 10) return false;
  return top10.every((code) => poolCodes.has(code));
}

function fallbackTop10(pool) {
  return [...pool]
    .sort((a, b) => (a.standing ?? 999) - (b.standing ?? 999) || a.code.localeCompare(b.code))
    .slice(0, 10)
    .map((d) => d.code);
}

async function gridBotUserId() {
  const { rows } = await q(`select id from users where display_name = 'GridBot'`);
  if (rows.length === 0) throw new Error('GridBot не найден в users — применена ли миграция 0014?');
  return rows[0].id;
}

async function savePrediction(userId, raceId, codeToDriverId, top10Codes) {
  const positions = top10Codes.map((code) => codeToDriverId.get(code));
  await q(
    `insert into predictions (user_id, race_id, positions) values ($1, $2, $3::jsonb)
     on conflict (user_id, race_id) do update set positions = excluded.positions, updated_at = now()`,
    [userId, raceId, JSON.stringify(positions)],
  );
}

async function main() {
  const race = await openRaceThisWeek();
  if (!race) {
    console.log('aiplayer: нет открытой гонки с дедлайном на этой неделе, пропускаем');
    await close();
    return;
  }

  const pool = await poolDrivers(race.id);
  const codeToDriverId = new Map(pool.map((d) => [d.code, d.id]));
  const driverCodeOf = new Map(pool.map((d) => [d.id, d.code]));
  const ownResults = await seasonResults(race.season);
  const standingsMap = await pastSeasonStandings(pool.map((d) => d.id));

  let top10Codes;
  let reasoning = null;
  try {
    const prompt = buildPrompt(race, pool, driverCodeOf, ownResults, standingsMap);
    const answer = await askGemini(prompt);
    if (isValidTop10(answer.top10, pool)) {
      top10Codes = answer.top10;
      reasoning = answer.reasoning;
    } else {
      console.warn('aiplayer: ответ Gemini не прошёл валидацию, используем fallback');
      top10Codes = fallbackTop10(pool);
    }
  } catch (e) {
    console.warn(`aiplayer: Gemini недоступна (${e.message}), используем fallback`);
    top10Codes = fallbackTop10(pool);
  }

  const userId = await gridBotUserId();
  await savePrediction(userId, race.id, codeToDriverId, top10Codes);
  console.log(`aiplayer: прогноз на "${race.name}" сохранён — ${top10Codes.join('-')}`);

  if (reasoning) {
    const text = `🤖 GridBot поставил на <b>${escapeHtml(race.name)}</b>: ${top10Codes.join('-')}\n`
      + `Почему: ${escapeHtml(reasoning)}`;
    try {
      await sendTelegram(text);
      console.log('aiplayer: объяснение отправлено в Telegram');
    } catch (e) {
      console.warn(`aiplayer: не удалось отправить в Telegram: ${e.message}`);
    }
  }

  await close();
}

module.exports = { isValidTop10, fallbackTop10, escapeHtml, buildPrompt };

if (require.main === module) {
  main().catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });
}
