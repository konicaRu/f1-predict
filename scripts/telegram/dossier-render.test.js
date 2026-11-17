// Реальный Chromium, публичный сохранённый fixture. Без .env, БД и Telegram.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { buildDossierMessage, deliverDossier } = require('./dossier-message');
const { renderDossierCard } = require('./render-dossier-card');
const fixture = require('../../docs/mockups/telegram-dossier-live.json');

test('production path renders PNG and sends the actual card bytes to photo transport', { timeout: 60000 }, async () => {
  const race = { ...fixture.race, id: 42 };
  const d = { ...fixture.dossier, weather: { ...fixture.dossier.weather, windDirection: 47 } };
  const m = buildDossierMessage(race, d, { mode: 'deadline', missing: ['Тестовый участник'] });
  let image, calls = 0;
  await deliverDossier(m, {
    token: 'test-token', chatId: 'test-chat', replyMarkup: { inline_keyboard: [[{ text: '🏁 Сделать прогноз', url: 'https://t.me/che_f1_predict_bot/predict?startapp=predict_42' }]] },
    renderCard: async html => {
      image = await renderDossierCard(html, process.env.DOSSIER_CHROME_PATH ? { executablePath: process.env.DOSSIER_CHROME_PATH } : {});
      return image;
    },
    onFallback: warning => assert.fail(warning),
    fetchImpl: async (url, options) => {
      calls++;
      assert.match(url, /sendPhoto$/);
      const file = options.body.get('photo');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), image);
      assert.match(options.body.get('caption'), /Тестовый участник/);
      return { json: async () => ({ ok: true }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.equal(image.readUInt32BE(16), 1080);
  assert.ok(image.readUInt32BE(20) > 1500 && image.readUInt32BE(20) < 6000);
  assert.ok(image.length < 10 * 1024 * 1024);
  if (process.env.DOSSIER_RENDER_OUTPUT) fs.writeFileSync(process.env.DOSSIER_RENDER_OUTPUT, image);
});
