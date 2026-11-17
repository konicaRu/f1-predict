const factsByCircuit = require('./data/circuits.json');
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const HOUR = 3600000;
const nameOf = d => [d?.givenName, d?.familyName].filter(Boolean).join(' ');
const raceTime = r => Date.parse(`${r.date}T${r.time || '00:00:00Z'}`);
const validNumber = v => typeof v === 'number' && Number.isFinite(v);

function summarizeWeather(data, startIso) {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || !Array.isArray(data?.hourly?.time)) return null;
  const first = Math.floor(start / HOUR) * HOUR;
  const end = Math.ceil((start + 2 * HOUR) / HOUR) * HOUR;
  const hourly = data.hourly;
  const indices = [];
  for (let t = first; t < end; t += HOUR) {
    const i = hourly.time.findIndex(s => Date.parse(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`) === t);
    if (i < 0) return null;
    indices.push(i);
  }
  const values = (key, valid = () => true) => {
    const xs = indices.map(i => hourly[key]?.[i]);
    return xs.every(x => validNumber(x) && valid(x)) ? xs : null;
  };
  const air = values('temperature_2m', x => x >= -80 && x <= 65);
  const rain = values('precipitation_probability', x => x >= 0 && x <= 100);
  const wind = values('wind_speed_10m', x => x >= 0);
  if (!air && !rain && !wind) return null;
  return { air: air ? [Math.min(...air), Math.max(...air)] : null, rainMax: rain ? Math.max(...rain) : null,
    windMax: wind ? Math.max(...wind) : null, hours: indices.length, start: new Date(start).toISOString(), end: new Date(start + 2 * HOUR).toISOString() };
}

function selectWinners(rows, circuitId, before) {
  const cutoff = Date.parse(before);
  return rows.filter(r => r.Circuit?.circuitId === circuitId && raceTime(r) < cutoff && r.Results?.some(x => x.position === '1'))
    .sort((a, b) => raceTime(b) - raceTime(a)).slice(0, 5).map(r => {
      const winner = r.Results.find(x => x.position === '1');
      return { year: Number(r.season), date: r.date, driver: nameOf(winner.Driver), team: winner.Constructor?.name || '' };
    });
}

function previousYearTimes(results, qualifying, year, circuitId) {
  const matching = rows => rows.filter(r => Number(r.season) === year && r.Circuit?.circuitId === circuitId);
  // Если на трассе было два этапа за сезон, берём последний и ищем его квалификацию.
  const race = matching(results).sort((a, b) => raceTime(b) - raceTime(a))[0];
  const qRace = matching(qualifying).find(r => !race || (r.round === race.round && r.date === race.date));
  const fastest = race?.Results?.find(r => r.FastestLap?.rank === '1' && /^\d+:\d{2}\.\d{3}$/.test(r.FastestLap.Time?.time));
  const pole = qRace?.QualifyingResults?.find(r => r.position === '1');
  const poleTime = [pole?.Q3, pole?.Q2, pole?.Q1].find(s => /^\d+:\d{2}\.\d{3}$/.test(s));
  return { year, fastest: fastest ? { time: fastest.FastestLap.Time.time, driver: nameOf(fastest.Driver) } : null,
    pole: poleTime ? { time: poleTime, driver: nameOf(pole.Driver) } : null };
}

async function loadDossier(race, { fetchImpl = fetch, now = new Date(), includeHistory = true } = {}) {
  const d = { circuit: null, facts: null, winners: [], previous: null, weather: null, trackTemperature: null,
    fetchedAt: now.toISOString(), warnings: [], sources: [] };
  async function json(url) {
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'F1Predict/1.0' }, signal: AbortSignal.timeout(6500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async function racesAt(endpoint) {
    const url = `${JOLPICA}/${endpoint}.json?limit=100`;
    const data = await json(url);
    if (!Array.isArray(data.MRData?.RaceTable?.Races)) throw new Error('Неверный ответ Jolpica');
    const total = Number(data.MRData.total);
    if (total > 100) {
      const tail = await json(`${url}&offset=${Math.max(0, total - 100)}`);
      if (!Array.isArray(tail.MRData?.RaceTable?.Races)) throw new Error('Неверная страница Jolpica');
      return tail.MRData.RaceTable.Races;
    }
    return data.MRData.RaceTable.Races;
  }
  const safe = async (label, fn, fallback) => {
    try { return await fn(); } catch (e) { d.warnings.push(`${label}: ${e.message}`); return fallback; }
  };
  const season = Number(race.season);
  const round = Number(race.round);
  if (!Number.isInteger(season) || season < 1950 || !Number.isInteger(round) || round < 1 || !Number.isFinite(Date.parse(race.race_datetime_utc))) {
    d.warnings.push('Нет корректных сезона, раунда или времени старта');
    return d;
  }
  const calendar = await safe('Календарь', () => racesAt(`${season}/${round}`), []);
  const event = calendar.find(r => Number(r.season) === season && Number(r.round) === round && Math.abs(raceTime(r) - Date.parse(race.race_datetime_utc)) <= 6 * HOUR);
  const id = event?.Circuit?.circuitId;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) { d.warnings.push('Трасса и дата этапа не подтверждены календарём'); return d; }
  d.circuit = { id, name: event.Circuit.circuitName };
  d.facts = factsByCircuit[id] || null;
  d.sources.push({ name: 'Jolpica', url: `${JOLPICA}/${season}/${round}.json` });
  if (d.facts) d.sources.push({ name: 'Formula 1', url: d.facts.source });
  const latitude = Number(event.Circuit.Location?.lat);
  const longitude = Number(event.Circuit.Location?.long);
  const until = Date.parse(race.race_datetime_utc) - now.getTime();
  const hasCoordinates = event.Circuit.Location?.lat != null && event.Circuit.Location?.long != null &&
    Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  const [history, previous, qualifying, weather, track] = await Promise.all([
    includeHistory ? safe('Победители', () => racesAt(`circuits/${id}/results/1`), null) : null,
    includeHistory ? safe('Гонка прошлого года', () => racesAt(`${season - 1}/circuits/${id}/results`), []) : [],
    includeHistory ? safe('Квалификация прошлого года', () => racesAt(`${season - 1}/circuits/${id}/qualifying/1`), []) : [],
    hasCoordinates && until > 0 && until < 15 * 24 * HOUR ? safe('Погода', async () => {
      const params = new URLSearchParams({ latitude, longitude, hourly: 'temperature_2m,precipitation_probability,wind_speed_10m', timezone: 'UTC', wind_speed_unit: 'ms', forecast_days: '16' });
      const value = summarizeWeather(await json(`https://api.open-meteo.com/v1/forecast?${params}`), race.race_datetime_utc);
      if (!value) throw new Error('Нет полного покрытия часов гонки');
      return { ...value, fetchedAt: now.toISOString() };
    }, null) : null,
    // Только фактический свежий замер той же трассы. До первых сессий он отсутствует.
    d.facts?.openf1Location ? safe('Полотно', async () => {
      const sessions = await json(`https://api.openf1.org/v1/sessions?year=${season}`);
      if (!Array.isArray(sessions)) throw new Error('Неверный ответ OpenF1');
      const session = sessions.filter(s => s.location === d.facts.openf1Location && Date.parse(s.date_start) <= now &&
        now - Date.parse(s.date_end) <= 24 * HOUR && Date.parse(s.date_start) >= Date.parse(race.race_datetime_utc) - 4 * 24 * HOUR)
        .sort((a,b) => Date.parse(b.date_start) - Date.parse(a.date_start))[0];
      if (!session) return null;
      const samples = await json(`https://api.openf1.org/v1/weather?session_key=${session.session_key}`);
      if (!Array.isArray(samples)) throw new Error('Неверные замеры OpenF1');
      const sample = samples.filter(s => validNumber(s.track_temperature) && Date.parse(s.date) <= now && now - Date.parse(s.date) <= 24 * HOUR)
        .sort((a,b) => Date.parse(b.date) - Date.parse(a.date))[0];
      return sample ? { value: sample.track_temperature, at: sample.date, session: session.session_name } : null;
    }, null) : null,
  ]);
  d.winners = history === null ? null : selectWinners(history, id, race.race_datetime_utc);
  d.previous = previousYearTimes(previous, qualifying, season - 1, id);
  d.weather = weather;
  d.trackTemperature = track;
  if (weather) d.sources.push({ name: 'Open-Meteo', url: 'https://open-meteo.com/' });
  if (track) d.sources.push({ name: 'OpenF1', url: 'https://openf1.org/' });
  return d;
}

module.exports = { summarizeWeather, selectWinners, previousYearTimes, loadDossier };
