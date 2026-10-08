const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Читает переменную напрямую из корневого .env (по образцу scripts/telegram/lib.js).
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

// Пульс для сторожа (миграция 0028), тот же контракт, что в scripts/telegram/lib.js: best-effort,
// никогда не бросает — отсутствие пульса сторож и так заметит.
async function recordRun(job, ok, errors = []) {
  try {
    await q('insert into job_runs (job, ok, errors, run_key) values ($1, $2, $3, $4) on conflict (run_key) do nothing', [
      job,
      ok,
      errors.map((e) => String(e).slice(0, 500)),
      require('crypto').randomUUID(),
    ]);
  } catch (e) {
    console.warn(`recordRun: не удалось записать пульс ${job}: ${e.message}`);
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

module.exports = { readEnv, q, close, recordRun };
