const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runShowcase, isShowcaseWindow } = require('./showcase');
const fixture = require('../../docs/mockups/telegram-dossier-live.json');
const race = { ...fixture.race, id: 42 };
const now = new Date('2026-11-19T06:00:00Z');
function setup() {
  const claimed = new Set(), sent = [], finished = [];
  return { claimed, sent, finished, options: { now, clock: () => now, getRace: async () => race,
    getDossier: async () => ({ ...fixture.dossier, previousRaceHistory: require('./data/race-history.json').vegas['2025'] }),
    claim: async format => { if (claimed.has(format)) return false; claimed.add(format); return true; },
    finish: async (format, ok) => finished.push([format, ok]),
    send: async (message, keyboard) => { sent.push({ message, keyboard }); return { ok: true }; } } };
}
test('one-time showcase is limited to 19 November 2026 09:00–10:00 Moscow', () => {
  for (const [at, want] of [
    ['2026-11-19T05:59:59Z', false], ['2026-11-19T06:00:00Z', true],
    ['2026-11-19T06:59:59Z', true], ['2026-11-19T07:00:00Z', false],
    ['2026-11-18T06:00:00Z', false], ['2027-11-19T06:00:00Z', false],
  ]) assert.equal(isShowcaseWindow(new Date(at)), want, at);
});
test('showcase sends each production format once with real race keyboard; rerun sends nothing', async () => {
  const { options, sent, finished } = setup();
  await runShowcase(options); await runShowcase(options);
  assert.deepEqual(sent.map(s => s.message.format), ['card', 'legacy']);
  for (const s of sent) assert.equal(s.keyboard.inline_keyboard[0][0].url, 'https://t.me/che_f1_predict_bot/predict?startapp=predict_42');
  assert.deepEqual(finished, [['card', true], ['legacy', true]]);
});
test('early and read-only checks never claim or send, and missing race fails before claims', async () => {
  const { options, claimed, sent } = setup();
  assert.equal((await runShowcase({ ...options, now: new Date('2026-11-18T06:00:00Z') })).skipped, true);
  await runShowcase({ ...options, checkOnly: true });
  assert.deepEqual([...claimed], []); assert.equal(sent.length, 0);
  await assert.rejects(runShowcase({ ...options, getRace: async () => null }), /открытая гонка/);
  assert.deepEqual([...claimed], []);
});
test('ambiguous first send is not retried and does not prevent delivery of the other format', async () => {
  const { options, claimed, finished } = setup();
  const attempts = [];
  options.send = async m => { attempts.push(m.format); if (m.format === 'card') throw new Error('timeout'); };
  await assert.rejects(runShowcase(options), /card.*timeout/);
  assert.deepEqual(attempts, ['card', 'legacy']);
  assert.deepEqual([...claimed], ['card', 'legacy']);
  assert.deepEqual(finished, [['card', false], ['legacy', true]]);
  await runShowcase(options);
  assert.deepEqual(attempts, ['card', 'legacy']);
});
test('concurrent runs reserve each format before Telegram delivery', async () => {
  const { options, sent } = setup();
  await Promise.all([runShowcase(options), runShowcase(options)]);
  assert.deepEqual(sent.map(s => s.message.format).sort(), ['card', 'legacy']);
});

test('missed window on the appointed day fails visibly instead of reporting a successful skip', async () => {
  const { options, claimed } = setup();
  await assert.rejects(runShowcase({ ...options, now: new Date('2026-11-19T07:00:00Z') }), /Пропущено окно/);
  assert.equal(claimed.size, 0);
});
test('loading that crosses the cutoff cannot reserve or send either format', async () => {
  const { options, claimed, sent } = setup();
  await assert.rejects(runShowcase({ ...options, clock: () => new Date('2026-11-19T07:00:00Z') }), /окно/);
  assert.equal(claimed.size, 0); assert.equal(sent.length, 0);
});
test('outbound guard is passed through after rendering, late delivery never starts', async () => {
  const { options } = setup();
  let current = now, delivered = 0;
  await assert.rejects(runShowcase({ ...options, clock: () => current,
    send: async (message, keyboard, onFallback, transport) => {
      current = new Date('2026-11-19T07:00:00Z');
      await transport.beforeSend(); delivered++;
    },
  }), /окно/);
  assert.equal(delivered, 0);
});
