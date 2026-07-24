const fs = require('fs'); const path = require('path');
const { Client } = require('pg');

function readEnv(key) {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} не найден в .env`);
  return m[1].trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const transient = e => e.code === undefined || e.code === '57014' ||
  /terminated|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|network/i.test(e.message || '');

let client = null;
async function ensure() {
  if (client) return client;
  client = new Client({ connectionString: readEnv('SUPABASE_DB_URL'), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000, keepAlive: true });
  client.on('error', () => { client = null; });
  await client.connect();
  return client;
}
async function q(text, params) {
  for (let a = 1; a <= 6; a++) {
    try { const c = await ensure(); return await c.query(text, params); }
    catch (e) {
      try { if (client) await client.end(); } catch (_) { /* уже закрыт */ }
      client = null;
      if (!transient(e) || a === 6) throw e;
      await sleep(1200 * a);
    }
  }
}
async function close() { if (client) { try { await client.end(); } catch (_) { /* уже закрыт */ } client = null; } }

// Jolpica REST с ретраем. p пример: '2025/driverStandings'
async function fetchJolpica(p) {
  const url = `https://api.jolpi.ca/ergast/f1/${p}.json?limit=100`;
  for (let a = 1; a <= 5; a++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { if (a === 5) throw e; await sleep(800 * a); }
  }
}

// Gemini API, структурированный JSON-режим — модель обязана вернуть top10 (10 кодов) + reasoning.
async function askGemini(prompt) {
  const apiKey = readEnv('GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          top10: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 10, maxItems: 10 },
          reasoning: { type: 'STRING' },
        },
        required: ['top10', 'reasoning'],
      },
    },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Gemini: пустой ответ');
  return JSON.parse(text);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(text) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

module.exports = { readEnv, q, close, fetchJolpica, askGemini, escapeHtml, sendTelegram };
