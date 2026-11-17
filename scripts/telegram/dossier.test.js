const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeWeather, selectWinners, previousYearTimes, loadDossier } = require('./dossier');

const race = { season: 2026, round: 21, name: 'Las Vegas Grand Prix', race_datetime_utc: '2026-11-22T04:00:00Z' };
const driver = { givenName: 'Max', familyName: 'Verstappen' };
const result = (year, circuitId = 'vegas') => ({ season: String(year), date: `${year}-11-22`, time: '04:00:00Z', Circuit: { circuitId }, Results: [{ position: '1', Driver: driver, Constructor: { name: 'Red Bull' } }] });
const hourly = { time: ['2026-11-22T03:00','2026-11-22T04:00','2026-11-22T05:00','2026-11-22T06:00'], temperature_2m: [22, 0, -1, 25], precipitation_probability: [90, 0, 20, 100], wind_speed_10m: [9, 2, 3, 10] };

test('weather uses only intersecting UTC hours, retains zero and negative temperatures', () => {
  const value = summarizeWeather({ hourly }, race.race_datetime_utc);
  assert.deepEqual(value.air, [-1, 0]);
  assert.equal(value.rainMax, 20);
  assert.equal(value.windMax, 3);
  assert.equal(value.hours, 2);
});
test('non-hour start includes both partial boundary hours', () => {
  assert.equal(summarizeWeather({ hourly }, '2026-11-22T03:30:00Z').hours, 3);
});
test('missing hour does not masquerade as complete weather coverage', () => {
  assert.equal(summarizeWeather({ hourly: { ...hourly, time: hourly.time.slice(0, 2) } }, race.race_datetime_utc), null);
});
test('null probability stays unavailable, never becomes zero', () => {
  const value = summarizeWeather({ hourly: { ...hourly, precipitation_probability: [0, null, 20, 0] } }, race.race_datetime_utc);
  assert.equal(value.rainMax, null);
  assert.deepEqual(value.air, [-1, 0]);
});
test('last five winners are from same circuit before event, sorted newest first', () => {
  const rows = [2018, 2019, 2020, 2021, 2023, 2024, 2025, 2026].map(y => result(y));
  rows.push(result(2025, 'caesars_palace'));
  assert.deepEqual(selectWinners(rows, 'vegas', race.race_datetime_utc).map(r => r.year), [2025, 2024, 2023, 2021, 2020]);
});
test('previous year means exactly previous season, qualifying takes last completed segment', () => {
  const previous = result(2025);
  previous.Results[0].FastestLap = { rank: '1', Time: { time: '1:33.365' } };
  const qualifying = { ...previous, QualifyingResults: [{ position: '1', Driver: driver, Q1: '1:55.473', Q2: '1:51.379', Q3: '1:47.934' }] };
  assert.deepEqual(previousYearTimes([previous], [qualifying], 2025, 'vegas'), {
    year: 2025, fastest: { time: '1:33.365', driver: 'Max Verstappen' }, pole: { time: '1:47.934', driver: 'Max Verstappen' },
  });
  assert.equal(previousYearTimes([result(2024)], [], 2025, 'vegas').fastest, null);
});

const response = data => ({ ok: true, json: async () => data });
const table = races => ({ MRData: { total: String(races.length), RaceTable: { Races: races } } });
const calendar = { ...result(2026), round: '21', Circuit: { circuitId: 'vegas', circuitName: 'Las Vegas Strip Circuit', Location: { lat: '36.1147', long: '-115.173' } } };

test('source outages preserve circuit facts and independently successful history', async () => {
  const d = await loadDossier(race, { now: new Date('2026-11-17T12:00:00Z'), fetchImpl: async url => {
    if (url.includes('/2026/21.json')) return response(table([calendar]));
    if (url.includes('/circuits/vegas/results/1.json')) return response(table([result(2023), result(2024), result(2025)]));
    throw new Error('offline');
  } });
  assert.equal(d.circuit.id, 'vegas');
  assert.equal(d.facts.lengthKm, 6.201);
  assert.equal(d.winners.length, 3);
  assert.equal(d.weather, null);
  assert.ok(d.warnings.length >= 1);
});
test('round date mismatch never attaches a different event dossier', async () => {
  let calls = 0;
  const d = await loadDossier(race, { fetchImpl: async () => { calls++; return response(table([{ ...calendar, date: '2026-10-01' }])); } });
  assert.equal(d.circuit, null);
  assert.equal(calls, 1);
});
test('outside forecast horizon does not call weather API', async () => {
  const urls = [];
  await loadDossier(race, { now: new Date('2026-10-01T00:00:00Z'), fetchImpl: async url => {
    urls.push(url);
    return response(table(url.includes('/2026/21.json') ? [calendar] : []));
  } });
  assert.equal(urls.some(u => u.includes('open-meteo')), false);
});
