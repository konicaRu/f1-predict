const { test } = require('node:test');
const assert = require('node:assert/strict');
const { raceweek, deadline } = require('./notify');
const race = { id: 42, season: 2026, round: 21, name: 'Las Vegas Grand Prix', deadline_utc: '2026-11-19T20:00:00Z', race_datetime_utc: '2026-11-22T04:00:00Z', raceweek_announced_at: null };
const empty = { circuit: null, winners: null, sources: [], warnings: [] };

test('announcement marks only after successful delivery, skips already announced races', async () => {
  const events = [];
  await raceweek({ getRaces: async () => [race, { ...race, id: 43, raceweek_announced_at: '2026-11-16' }],
    getDossier: async () => empty, send: async m => { assert.match(m.richHtml, /Приём прогнозов открыт/); events.push('send'); },
    markAnnounced: async id => events.push(`mark:${id}`) });
  assert.deepEqual(events, ['send', 'mark:42']);
});
test('failed send does not mark announcement as delivered', async () => {
  let marked = false;
  await assert.rejects(raceweek({ getRaces: async () => [race], getDossier: async () => empty,
    send: async () => { throw new Error('network'); }, markAnnounced: async () => { marked = true; } }), /network/);
  assert.equal(marked, false);
});
test('dossier failure still delivers base announcement and records warning', async () => {
  let sent = false;
  const warnings = [];
  await raceweek({ getRaces: async () => [race], getDossier: async () => { throw new Error('source down'); }, warnings,
    send: async m => { sent = true; assert.match(m.richHtml, /временно недоступно/); }, markAnnounced: async () => {} });
  assert.equal(sent, true);
  assert.match(warnings[0], /source down/);
});
test('each reminder fetches weather anew, expired races excluded, missing names only on deadline day', async () => {
  let loaded = 0, missing = 0, sent = 0;
  const options = { getRaces: async () => [race, { ...race, deadline_utc: '2026-11-01T00:00:00Z' }], now: new Date('2026-11-19T10:00:00Z'),
    getDossier: async (_, opts) => { loaded++; assert.equal(opts.includeHistory, false); return empty; },
    getMissing: async () => { missing++; return ['Iceman']; },
    send: async m => { sent++; assert.match(m.richHtml, /Iceman/); assert.doesNotMatch(m.richHtml, /Последние победители/); } };
  await deadline(options); await deadline(options);
  assert.deepEqual([loaded, missing, sent], [2, 2, 2]);
  await deadline({ ...options, now: new Date('2026-11-18T10:00:00Z'), send: async m => assert.doesNotMatch(m.richHtml, /Ещё не сделали/) });
  assert.equal(missing, 2);
});
