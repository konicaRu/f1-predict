const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Читает переменную напрямую из корневого .env (без пакета dotenv — по образцу scripts/export/lib.js).
function readEnv(key) {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} не найден в .env`);
  return m[1].trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (e) =>
  e.code === undefined || e.code === '57014' || /terminated|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|network/i.test(e.message || '');

let client = null;
async function ensure() {
  if (client) return client;
  client = new Client({
    connectionString: readEnv('SUPABASE_DB_URL'),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    keepAlive: true,
  });
  // Без этого обработчика обрыв простаивающего соединения (напр. пока checkDriverPool() занят
  // долгим importDrivers()) кидает необработанный 'error' на EventEmitter и валит весь процесс —
  // тот же паттерн, что уже есть в scripts/import/lib.js.
  client.on('error', () => {
    client = null;
  });
  await client.connect();
  return client;
}

// Ретраит транзиентные обрывы соединения — тот же паттерн, что scripts/import/lib.js.
// Живьём воспроизведено: соединение, простаивавшее пока checkDriverPool() ждал долгий
// importDrivers() (сетевые вызовы к Jolpica), рвётся пулером Supabase и следующий же q()
// на этом клиенте падает с "Connection terminated unexpectedly" — без ретрая это убивало
// весь прогон notify.js (raceweek/deadline), не только автопроверку состава.
async function q(text, params) {
  for (let a = 1; a <= 6; a++) {
    try {
      const c = await ensure();
      return await c.query(text, params);
    } catch (e) {
      try {
        if (client) await client.end();
      } catch (_) {
        /* уже закрыт */
      }
      client = null;
      if (!transient(e) || a === 6) throw e;
      await sleep(1200 * a);
    }
  }
}

async function close() {
  if (client) {
    try {
      await client.end();
    } catch (_) {
      /* уже закрыт */
    }
    client = null;
  }
}

async function sendTelegram(text, chatIdOverride) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = chatIdOverride ?? readEnv('TELEGRAM_CHAT_ID');
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

// Caption ограничен 1024 символами Telegram (у sendMessage — 4096), это учтено в вызывающем коде.
//
// Скачиваем файл сами и грузим как multipart, а не передаём photoUrl напрямую — Telegram живьём
// (2026-09-10) стабильно отвечал 400 "failed to get HTTP URL content" на баннер с GitHub Pages,
// хотя файл нормально отдавался (200, 525КБ, 2400×800 — все лимиты Telegram по URL-фото с запасом).
// Известная нестабильность их собственного фетчера по URL, не проблема на нашей стороне — обходим,
// не полагаясь на их сеть.
async function sendTelegramPhoto(photoUrl, caption, replyMarkup) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');

  const imgRes = await fetch(photoUrl);
  if (!imgRes.ok) throw new Error(`Не удалось скачать баннер ${photoUrl}: HTTP ${imgRes.status}`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([imgBuf]), 'banner.png');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

module.exports = { readEnv, q, close, sendTelegram, sendTelegramPhoto };
