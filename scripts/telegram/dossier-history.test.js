const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDossierMessage } = require('./dossier-message');
const { windLabel } = require('./dossier-card');
const { loadDossier } = require('./dossier');
const fixture = require('../../docs/mockups/telegram-dossier-live.json');
const race = { ...fixture.race, id: 42 };
const history = { year: 2025, safetyCars: 0, virtualSafetyCars: 2, redFlags: 0,
  strategy: { typicalStops: 1, compounds: ['MEDIUM', 'HARD', 'SOFT'], mainSequence: ['MEDIUM', 'HARD'], winnerPitLap: 25 },
  sources: [{ name: 'FIA', url: 'https://www.fia.com/history' }, { name: 'Pirelli', url: 'https://press.pirelli.com/history' }] };

test('both formats show historical counts, strategy and start immediately after track title', () => {
  const d = { ...fixture.dossier, previousRaceHistory: history, weather: { ...fixture.dossier.weather, windDirection: 90 } };
  for (const format of ['card', 'legacy']) {
    const m = buildDossierMessage(race, d, { mode: 'deadline', format });
    assert.match(m.richHtml, /Сейфти-кар \(SC\): 0/);
    assert.match(m.richHtml, /Виртуальный сейфти-кар \(VSC\): 2/);
    assert.match(m.richHtml, /Красные флаги: 0/);
    assert.match(m.richHtml, /1 пит-стоп/);
    assert.match(m.richHtml, /Medium → Hard/);
    assert.match(m.richHtml, /Soft/);
    assert.match(m.richHtml, /Последние победители/);
    assert.doesNotMatch(m.richHtml, /откуда дует|стрелка|←|↓/);
    if (format === 'card') {
      assert.match(m.cardHtml, /<h1>LAS VEGAS<\/h1>\s*<[^>]+>СТАРТ: 22 НОЯБРЯ.*07:00 МСК/);
      assert.match(m.cardHtml, /ВИРТУАЛЬНЫЙ/);
      assert.match(m.cardHtml, /1 ПИТ-СТОП/);
      assert.doesNotMatch(m.cardHtml, /откуда дует|стрелка|←|↓/);
    } else {
      assert.match(m.bannerHtml, /LAS VEGAS[\s\S]*22 НОЯБРЯ.*07:00 МСК/);
    }
  }
  assert.equal(windLabel(90), 'Восточный');
});

test('unknown or wrong-year history never becomes zero or attaches another race history', () => {
  for (const value of [undefined, { ...history, year: 2024 }]) {
    const m = buildDossierMessage(race, { ...fixture.dossier, previousRaceHistory: value });
    assert.match(m.richHtml, /Нейтрализации.*2025/);
    assert.match(m.richHtml, /Нет подтверждённых данных/);
    assert.doesNotMatch(m.richHtml, /Сейфти-кар \(SC\): 0/);
  }
});

test('history attaches only to confirmed circuit and immediately preceding season', async () => {
  const load = async season => loadDossier({ ...race, season, race_datetime_utc: `${season}-11-22T04:00:00Z` }, { includeHistory: true, fetchImpl: async url => {
    if (url.includes(`/${season}/21.json`)) return { ok: true, json: async () => ({ MRData: { total: '1', RaceTable: { Races: [{ season: String(season), round: '21', date: `${season}-11-22`, time: '04:00:00Z', Circuit: { circuitId: 'vegas', circuitName: 'Vegas' } }] } } }) };
    throw new Error('other sources offline');
  } });
  const d = await load(2026);
  assert.equal(d.previousRaceHistory.virtualSafetyCars, 2);
  assert.equal(d.previousRaceHistory.safetyCars, 0);
  assert.ok(d.sources.some(s => s.name === 'FIA'));
  assert.equal((await load(2027)).previousRaceHistory, null);
});
