const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { google } = require('googleapis');

// Читает переменную напрямую из корневого .env (без пакета dotenv — по образцу scripts/import/lib.js).
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

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', '..', p);
}

function sheetsClient() {
  const keyFile = resolveFromRoot(readEnv('GOOGLE_SERVICE_ACCOUNT_KEY_PATH'));
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

module.exports = { readEnv, q, close, sheetsClient };
