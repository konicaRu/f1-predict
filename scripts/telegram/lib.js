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

let client = null;
async function ensure() {
  if (client) return client;
  client = new Client({
    connectionString: readEnv('SUPABASE_DB_URL'),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  return client;
}

async function q(text, params) {
  const c = await ensure();
  return c.query(text, params);
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

// Фото по URL (не upload) + caption вместо простого текстового сообщения — caption ограничен
// 1024 символами Telegram (у sendMessage — 4096), это учтено в вызывающем коде.
async function sendTelegramPhoto(photoUrl, caption, replyMarkup) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');
  const body = { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

module.exports = { readEnv, q, close, sendTelegram, sendTelegramPhoto };
