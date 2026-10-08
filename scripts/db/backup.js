// scripts/db/backup.js — полная резервная копия данных лиги перед рискованными правками.
//
//   node scripts/db/backup.js      -> C:/claude_code_projects/f1_predict_backups/<дата>_<время>_MSK/
//
// По JSON-файлу на таблицу (массив строк как есть) + manifest.json + RESTORE.md. Схемы в копии нет —
// её целиком воспроизводят миграции supabase/migrations из коммита, записанного в manifest.json.
// Восстановление — scripts/db/restore.js (через json_populate_recordset(null::<таблица>, ...):
// строки собираются по типу самой таблицы, jsonb/массивы/uuid/timestamptz возвращаются точь-в-точь).
//
// Почему порциями по ~2.5 КБ, а не pg_dump / psql \copy / одним запросом: с машины разработчика
// (через VPN) ответы пулера Supabase больше нескольких КБ теряются — запрос виснет навсегда
// (живьём 2026-10-08: ответ на 8 КБ повис, на 1 КБ — 70 мс; pg_dump и \copy падали так же).
// Мелкие порции проходят; зависшую порцию обрывает query_timeout, и она повторяется на свежем соединении.
//
// Каждая порция сверяется с тем же куском живой таблицы (по первичному ключу) тем же
// преобразованием, что пойдёт при восстановлении — EXCEPT ALL в обе стороны, без записи в БД.
// Копия годна, только если расхождений ноль и число строк совпало с count(*).
//
// Копия кладётся ВНЕ репозитория: репо публичное, а в копии личные данные и хеши паролей
// (auth.users) — в git она не должна попасть ни при каком раскладе.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const BACKUP_ROOT = process.env.BACKUP_ROOT || 'C:/claude_code_projects/f1_predict_backups';
const PAGE_BYTES = 2500;

// Порядок = порядок восстановления (сначала то, на что ссылаются внешние ключи).
const TABLES = [
  'auth.users',
  'auth.identities',
  'public.users',
  'public.drivers',
  'public.races',
  'public.race_driver_pool',
  'public.predictions',
  'public.results',
  'public.result_changes',
  'public.invite_codes',
  'public.telegram_links',
  'public.app_settings',
  'public.keepalive',
  'public.admin_notification_queue',
  'public.prediction_jokes',
  'public.job_runs',
  'public.watchdog_incidents',
  'cron.job',
];
// Сторож пишет сюда каждые 15 минут — расхождение на пару строк между порциями ожидаемо.
const VOLATILE = new Set(['public.job_runs', 'public.watchdog_incidents']);

function dbUrl() {
  return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
}

// Свежее соединение на каждую попытку; query_timeout рвёт зависший ответ. Только чтение — повтор безопасен.
async function query(text, params) {
  let last;
  for (let a = 1; a <= 6; a++) {
    const c = new Client({
      connectionString: dbUrl(),
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      query_timeout: 15000,
    });
    c.on('error', () => {});
    try {
      await c.connect();
      return await c.query(text, params);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * a));
    } finally {
      try { await c.end(); } catch (_) { /* уже закрыто */ }
    }
  }
  throw last;
}

async function primaryKey(table) {
  const { rows } = await query(
    `select string_agg(quote_ident(a.attname), ', ' order by array_position(i.indkey, a.attnum)) as pk
     from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = $1::regclass and i.indisprimary`,
    [table],
  );
  if (!rows[0].pk) throw new Error(`у ${table} нет первичного ключа — порционная выгрузка невозможна`);
  return rows[0].pk;
}

async function backupTable(table, dir) {
  const pk = await primaryKey(table);
  const { rows: st } = await query(
    `select count(*)::int as n, coalesce(avg(length(row_to_json(x)::text)), 0)::int as avg from ${table} x`,
  );
  const total = st[0].n;
  const pageRows = Math.max(1, Math.floor(PAGE_BYTES / Math.max(1, st[0].avg)));

  const all = [];
  let diff = 0;
  for (let offset = 0; offset < total; offset += pageRows) {
    const { rows } = await query(
      `select coalesce(json_agg(x order by ${pk}), '[]'::json) as data
       from (select * from ${table} order by ${pk} limit $1 offset $2) x`,
      [pageRows, offset],
    );
    const page = rows[0].data;
    // Сверка порции с тем же куском живой таблицы.
    const { rows: cmp } = await query(
      `with b as (select * from json_populate_recordset(null::${table}, $1::json)),
            l as (select * from ${table} order by ${pk} limit $2 offset $3)
       select (select count(*) from (select * from b except all select * from l) x)::int
            + (select count(*) from (select * from l except all select * from b) y)::int as diff`,
      [JSON.stringify(page), pageRows, offset],
    );
    diff += cmp[0].diff;
    all.push(...page);
  }

  const json = JSON.stringify(all);
  fs.writeFileSync(path.join(dir, `${table}.json`), json);
  return { rows: all.length, total, diff, sha256: crypto.createHash('sha256').update(json).digest('hex') };
}

async function main() {
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', '_').replace(/:/g, '').slice(0, 15);
  const dir = path.join(BACKUP_ROOT, `${stamp}_MSK`);
  fs.mkdirSync(dir, { recursive: true });

  const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const manifest = {
    created_at: new Date().toISOString(),
    git_head: git('rev-parse', 'HEAD'),
    uncommitted_migrations: git('status', '--short', 'supabase/migrations') || null,
    migrations: fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort(),
    tables: {},
  };

  let ok = true;
  for (const t of TABLES) {
    const r = await backupTable(t, dir);
    const match = r.diff === 0 && r.rows === r.total;
    if (!match && !VOLATILE.has(t)) ok = false;
    manifest.tables[t] = { rows: r.rows, sha256: r.sha256, verified: match };
    const verdict = match
      ? 'совпадает с живой'
      : `РАСХОЖДЕНИЕ (строк ${r.rows} из ${r.total}, отличий ${r.diff})${VOLATILE.has(t) ? ' — таблица сторожа, ожидаемо' : ''}`;
    console.log(`${t.padEnd(34)} ${String(r.rows).padStart(5)} строк  ${verdict}`);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(__dirname, 'RESTORE.md'), path.join(dir, 'RESTORE.md'));
  console.log(`\n${ok ? 'КОПИЯ ГОДНА' : 'КОПИЯ С РАСХОЖДЕНИЯМИ — НЕ ПОЛАГАТЬСЯ'}: ${dir}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
