const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDossierMessage, deliverDossier } = require('./dossier-message');
const race = { id: 42, name: '<Las & Vegas>', season: 2026, round: 21, deadline_utc: '2026-11-19T20:00:00Z', race_datetime_utc: '2026-11-22T04:00:00Z' };
const dossier = { circuit: { id: 'vegas', name: 'Vegas' }, facts: require('./data/circuits.json').vegas,
  winners: [{ year: 2025, driver: 'Max <V>', team: 'Red Bull' }], previous: { year: 2025, fastest: { time: '1:33.365', driver: 'Max' }, pole: { time: '1:47.934', driver: 'Lando' } },
  weather: { air: [0, 1], rainMax: 0, windMax: 2, fetchedAt: '2026-11-17T10:00:00Z' }, trackTemperature: null, sources: [] };

test('rich and fallback messages escape names, preserve zero weather and Moscow dates', () => {
  const m = buildDossierMessage(race, dossier);
  assert.match(m.richHtml, /&lt;Las &amp; Vegas&gt;/);
  assert.match(m.richHtml, /Max &lt;V&gt;/);
  assert.match(m.richHtml, /22 ноября.*07:00/);
  assert.match(m.richHtml, /до 0%/);
  assert.match(m.richHtml, /Полотно: свежих замеров пока нет/);
  assert.match(m.richHtml, /разных условиях/);
  assert.match(m.richHtml, /tg:\/\/photo\?id=dossier_banner/);
  assert.doesNotMatch(m.fallbackHtml, /<h\d|<details|<table|<img/);
  assert.ok(m.fallbackHtml.length < 4096);
});
test('missing sources produce honest message without invented numbers or geometry', () => {
  const m = buildDossierMessage(race, { circuit: null, winners: null, sources: [] });
  assert.match(m.richHtml, /временно недоступно/);
  assert.match(m.richHtml, /Почасовой прогноз пока недоступен/);
  assert.doesNotMatch(m.richHtml, /6,201|1:33.365/);
});
test('deadline includes updated weather and escaped missing names, omits full history', () => {
  const m = buildDossierMessage(race, dossier, { mode: 'deadline', missing: ['A<&', 'Б'] });
  assert.match(m.richHtml, /Ещё не сделали/);
  assert.match(m.richHtml, /A&lt;&amp;/);
  assert.match(m.richHtml, /до 0%/);
  assert.doesNotMatch(m.richHtml, /Последние победители/);
});
test('multipart renders the full card and sends exactly one photo with predict keyboard', async () => {
  const calls = [];
  const message = { cardHtml: '<html>card</html>', photoCaption: 'caption', fallbackHtml: 'text' };
  const replyMarkup = { inline_keyboard: [[{ text: '🏁 Сделать прогноз', url: 'https://t.me/che_f1_predict_bot/predict?startapp=predict_42' }]] };
  await deliverDossier(message, { token: 'test-token', chatId: 'test-chat', replyMarkup,
    renderCard: async html => { assert.equal(html, message.cardHtml); return Buffer.from('png'); }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendPhoto$/);
  const form = calls[0].options.body;
  assert.equal(form.get('photo').type, 'image/png');
  assert.equal(form.get('caption'), 'caption');
  assert.deepEqual(JSON.parse(form.get('reply_markup')), replyMarkup);
  assert.equal(form.get('chat_id'), 'test-chat');
});
test('explicit API unsupported response falls back once with valid ordinary HTML', async () => {
  const calls = [];
  await deliverDossier({ cardHtml: '<h2>x</h2>', photoCaption: 'x', fallbackHtml: '<b>x</b>' }, { token: 't', chatId: 'c', renderCard: async () => Buffer.from('png'), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: calls.length > 1, json: async () => calls.length === 1 ? { ok: false, error_code: 404, description: 'Not Found' } : { ok: true } };
  } });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /sendMessage$/);
  assert.equal(JSON.parse(calls[1].options.body).text, '<b>x</b>');
});
test('ambiguous network timeout never sends fallback or duplicates', async () => {
  let calls = 0;
  await assert.rejects(deliverDossier({ cardHtml: '<p>x</p>', fallbackHtml: 'x' }, { token: 't', chatId: 'c', renderCard: async () => Buffer.from('png'), fetchImpl: async () => { calls++; throw new Error('timeout'); } }), /timeout/);
  assert.equal(calls, 1);
});

test('renderer failure sends text once with the same keyboard and reports a warning', async () => {
  const calls = [], warnings = [];
  const keyboard = { inline_keyboard: [[{ text: 'Прогноз', url: 'https://example.com' }]] };
  await deliverDossier({ cardHtml: 'card', fallbackHtml: '<b>Прогноз открыт</b>' }, {
    token: 't', chatId: 'c', replyMarkup: keyboard, onFallback: w => warnings.push(w),
    renderCard: async () => { throw new Error('browser unavailable'); },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { json: async () => ({ ok: true }) }; },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.text, '<b>Прогноз открыт</b>');
  assert.deepEqual(body.reply_markup, keyboard);
  assert.match(warnings[0], /browser unavailable/);
});

test('server error does not send a duplicate through fallback', async () => {
  let calls = 0;
  await assert.rejects(deliverDossier({ cardHtml: 'x', fallbackHtml: 'x' }, {
    token: 't', chatId: 'c', renderCard: async () => Buffer.from('png'),
    fetchImpl: async () => { calls++; return { status: 503, json: async () => ({ ok: false, error_code: 503 }) }; },
  }), /503/);
  assert.equal(calls, 1);
});

test('automatic messages carry the current full card, caption and safe unavailable date', () => {
  const m = buildDossierMessage(race, dossier, { mode: 'deadline', missing: ['A<&'] });
  assert.match(m.cardHtml, /ПОСЛЕДНИЕ ПОБЕДИТЕЛИ/);
  assert.match(m.cardHtml, /Max &lt;V&gt;/i);
  assert.match(m.photoCaption, /Не забудь сделать прогноз/);
  assert.match(m.photoCaption, /A<&/);
  assert.ok(m.photoCaption.length <= 1024);
  const empty = buildDossierMessage(race, { circuit: null, sources: [] });
  assert.doesNotMatch(empty.cardHtml, /Invalid Date|NaN/);
});
