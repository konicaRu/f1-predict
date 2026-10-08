// scripts/db/restore.js — восстановление таблиц из копии scripts/db/backup.js.
//
//   node scripts/db/restore.js <папка-копии> <таблица> [<таблица> ...]            -> только сравнение, живые таблицы не трогает
//   node scripts/db/restore.js <папка-копии> <таблица> [<таблица> ...] --apply    -> заменить данные таблиц копией
//
// Таблицы — как в manifest.json, со схемой: public.predictions, public.results ...
//
// Как устроено (и почему так). С машины разработчика (через VPN) до пулера Supabase не проходят
// сообщения больше ~8 КБ (живьём 2026-10-08: отправка 8 КБ — OK, 16 КБ — обрыв), а таблица пула
// пилотов уже 13 КБ. Поэтому данные сначала заливаются мелкими порциями в служебную таблицу
// public._restore_staging (каждая порция — отдельный безопасный к повтору insert), а сама замена
// идёт ОДНИМ маленьким сообщением BEGIN…COMMIT, которое берёт строки оттуда: сервер исполнит его
// целиком или откатит целиком — полузалитой таблицы не будет даже при обрыве связи.
// Внутри замены: пользовательские триггеры выключены (иначе каждая строка predictions/results/users
// дёрнет admin-notify — лавина уведомлений), вычисляемые колонки пропускаются, счётчики id
// выставляются по максимуму, внешние ключи работают. В конце служебная таблица удаляется.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const CHUNK_BYTES = 6000; // с запасом до порога ~8 КБ
const STAGING = 'public._restore_staging';

function dbUrl() {
  return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
}

async function query(text, params, { retry = true } = {}) {
  let last;
  for (let a = 1; a <= (retry ? 6 : 1); a++) {
    const c = new Client({
      connectionString: dbUrl(),
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
      query_timeout: 30000,
    });
    c.on('error', () => {});
    try {
      await c.connect();
      return await c.query(text, params);
    } catch (e) {
      last = e;
      if (retry) await new Promise((r) => setTimeout(r, 500 * a));
    } finally {
      try { await c.end(); } catch (_) { /* уже закрыто */ }
    }
  }
  throw last;
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Порции JSON-массива, каждая не длиннее CHUNK_BYTES (кроме одиночной строки, если она сама больше).
function chunks(rows) {
  const out = [];
  let cur = [];
  let size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > CHUNK_BYTES) {
      out.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(r);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function compare(batch, t) {
  const { rows } = await query(
    `with b as (select r.* from ${STAGING} s cross join lateral json_populate_recordset(null::${t}, s.data) r
                where s.batch = $1 and s.table_name = $2)
     select (select count(*) from b)::int as backup_rows, (select count(*) from ${t})::int as live_rows,
            (select count(*) from (select * from b except all select * from ${t}) x)::int as only_backup,
            (select count(*) from (select * from ${t} except all select * from b) y)::int as only_live`,
    [batch, t],
  );
  return rows[0];
}

async function cleanup(batch) {
  await query(`delete from ${STAGING} where batch = $1`, [batch]);
  // Удаляем служебную таблицу, если в ней не осталось чужих порций (параллельный запуск).
  await query(`do $$ begin if not exists (select 1 from ${STAGING}) then drop table ${STAGING}; end if; end $$`);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [dir, ...tables] = args.filter((a) => a !== '--apply');
  if (!dir || tables.length === 0) {
    console.error('usage: node scripts/db/restore.js <папка-копии> <схема.таблица> [...] [--apply]');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const order = Object.keys(manifest.tables);
  for (const t of tables) if (!order.includes(t)) throw new Error(`${t} нет в manifest.json этой копии`);
  const sorted = [...tables].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // Служебная таблица: только service-role (RLS без политик + revoke), как остальные служебные.
  await query(
    `create table if not exists ${STAGING} (batch uuid not null, table_name text not null, chunk int not null,
       data json not null, primary key (batch, table_name, chunk));
     alter table ${STAGING} enable row level security;
     revoke all on ${STAGING} from anon, authenticated;`,
  );
  const batch = crypto.randomUUID();

  try {
    for (const t of sorted) {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), 'utf8'));
      const parts = chunks(rows);
      for (let i = 0; i < parts.length; i++) {
        await query(
          `insert into ${STAGING} (batch, table_name, chunk, data) values ($1, $2, $3, $4::json) on conflict do nothing`,
          [batch, t, i, JSON.stringify(parts[i])],
        );
      }
    }

    for (const t of sorted) {
      const r = await compare(batch, t);
      console.log(`${t.padEnd(30)} копия ${r.backup_rows}, сейчас ${r.live_rows}; вернётся строк: ${r.only_backup}, уйдёт строк: ${r.only_live}`);
    }
    if (!apply) {
      console.log('\nЭто был только просмотр, живые таблицы не тронуты. Чтобы заменить данные — тот же вызов с --apply.');
      return;
    }

    const meta = {};
    for (const t of sorted) {
      const [schema, name] = t.split('.');
      const { rows } = await query(
        `select string_agg(quote_ident(column_name), ', ' order by ordinal_position) as cols,
                coalesce(bool_or(identity_generation = 'ALWAYS'), false) as identity_always,
                max(case when is_identity = 'YES' then column_name end) as identity_col
         from information_schema.columns
         where table_schema = $1 and table_name = $2 and is_generated = 'NEVER'`,
        [schema, name],
      );
      meta[t] = rows[0];
    }

    // Триггеры трогаем только у своих таблиц: auth.* принадлежат служебной роли Supabase
    // (alter table там упадёт по правам), а своих триггеров на них у проекта нет.
    const own = sorted.filter((t) => t.startsWith('public.'));
    const sql = ['begin;'];
    for (const t of own) sql.push(`alter table ${t} disable trigger user;`);
    for (const t of [...sorted].reverse()) sql.push(`delete from ${t};`);
    for (const t of sorted) {
      const { cols, identity_always: always, identity_col: idCol } = meta[t];
      const pick = cols.split(', ').map((c) => `r.${c}`).join(', ');
      sql.push(
        `insert into ${t} (${cols}) ${always ? 'overriding system value ' : ''}` +
          `select ${pick} from ${STAGING} s cross join lateral json_populate_recordset(null::${t}, s.data) r ` +
          `where s.batch = ${lit(batch)} and s.table_name = ${lit(t)};`,
      );
      if (idCol) {
        sql.push(`select setval(pg_get_serial_sequence(${lit(t)}, ${lit(idCol)}), coalesce((select max(${idCol}) from ${t}), 1));`);
      }
    }
    for (const t of own) sql.push(`alter table ${t} enable trigger user;`);
    sql.push('commit;');

    // Без повтора: при обрыве сервер либо исполнил всё сообщение, либо откатил — сверка ниже покажет.
    try {
      await query(sql.join('\n'), undefined, { retry: false });
    } catch (e) {
      console.warn(`замена: ${e.message} — проверяю, что на сервере`);
    }
    for (const t of sorted) {
      const r = await compare(batch, t);
      const same = r.only_backup === 0 && r.only_live === 0;
      console.log(`${t.padEnd(30)} ${same ? `восстановлено, совпадает с копией (${r.live_rows} строк)` : `НЕ СОВПАДАЕТ: вернуть ${r.only_backup}, лишних ${r.only_live}`}`);
    }
  } finally {
    await cleanup(batch);
  }
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
