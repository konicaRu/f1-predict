// Версионный игровой архив в Google Sheets. Auth/пароли сюда не выгружаются.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const TABLES = ['public.users', 'public.drivers', 'public.races', 'public.race_driver_pool',
  'public.predictions', 'public.results', 'public.result_changes'];
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function requireAllTables(tables) {
  if (Object.keys(tables).length !== TABLES.length || TABLES.some((table) => !Object.hasOwn(tables, table))) {
    throw new Error('Archive must contain all seven game tables');
  }
}

function encodeSnapshot(tables, metadata, chunkSize = 20000) {
  requireAllTables(tables);
  const manifest = { ...metadata, version: 1, scope: 'game-archive-without-auth', tables: {} };
  const chunks = [];
  for (const [table, json] of Object.entries(tables)) {
    if (!TABLES.includes(table)) throw new Error(`Unsupported table: ${table}`);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error(`Not an array: ${table}`);
    // Сохраняем исходный JSON, не пересериализуем bigint через JS Number.
    const points = Array.from(json);
    const parts = [];
    for (let i = 0; i < points.length; i += chunkSize) parts.push(points.slice(i, i + chunkSize).join(''));
    manifest.tables[table] = { rows: parsed.length, sha256: sha256(json), chunks: parts.length, verified: true };
    parts.forEach((part, index) => chunks.push([table, String(index), part]));
  }
  return [['F1_ARCHIVE_V1', 'PREPARING', metadata.created_at], ['MANIFEST', JSON.stringify(manifest)], ...chunks];
}

function decodeSnapshot(rows, allowPreparing = false) {
  if (rows[0]?.[0] !== 'F1_ARCHIVE_V1' ||
      !(rows[0]?.[1] === 'COMPLETE' || (allowPreparing && rows[0]?.[1] === 'PREPARING'))) {
    throw new Error('Snapshot is not COMPLETE');
  }
  if (rows[1]?.[0] !== 'MANIFEST') throw new Error('Missing manifest');
  const manifest = JSON.parse(rows[1][1]);
  if (manifest.version !== 1 || manifest.scope !== 'game-archive-without-auth' || !manifest.tables) {
    throw new Error('Unsupported snapshot format');
  }
  requireAllTables(manifest.tables);
  const tables = {};
  let cursor = 2;
  for (const [table, entry] of Object.entries(manifest.tables)) {
    if (!TABLES.includes(table) || !Number.isInteger(entry.chunks) || entry.chunks < 1) {
      throw new Error('Invalid table/chunk metadata');
    }
    let json = '';
    for (let index = 0; index < entry.chunks; index++, cursor++) {
      const row = rows[cursor];
      if (row?.[0] !== table || String(row[1]) !== String(index) || typeof row[2] !== 'string') {
        throw new Error(`Missing or reordered chunk: ${table}/${index}`);
      }
      json += row[2];
    }
    if (sha256(json) !== entry.sha256) throw new Error(`Checksum mismatch: ${table}`);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== entry.rows) throw new Error(`Row count mismatch: ${table}`);
    tables[table] = json;
  }
  if (!Object.keys(tables).length || cursor !== rows.length) throw new Error('Missing tables or unexpected chunks');
  return { manifest, tables };
}

async function publishSnapshot(transport, tables, metadata) {
  const rows = encodeSnapshot(tables, metadata);
  const title = await transport.create(rows.length);
  await transport.write(title, rows);
  const candidate = decodeSnapshot(await transport.read(title, rows.length), true);
  if (JSON.stringify(candidate.manifest) !== rows[1][1] ||
      Object.entries(tables).some(([table, json]) => candidate.tables[table] !== json)) {
    throw new Error('Read-back differs from original snapshot');
  }
  await transport.complete(title);
  const verified = decodeSnapshot(await transport.read(title, rows.length));
  if (JSON.stringify(verified.manifest) !== rows[1][1]) throw new Error('Final manifest mismatch');
  return { title, manifest: verified.manifest };
}

function readLocalBackup(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const tables = {};
  for (const table of TABLES) {
    const entry = manifest.tables?.[table];
    const json = fs.readFileSync(path.join(directory, `${table}.json`), 'utf8');
    if (!entry?.verified || sha256(json) !== entry.sha256 || JSON.parse(json).length !== entry.rows) {
      throw new Error(`Checksum/verification failure: ${table}`);
    }
    tables[table] = json;
  }
  return { tables, metadata: { created_at: manifest.created_at, git_head: manifest.git_head,
    migrations: manifest.migrations, source: 'verified-local-backup' } };
}

function privateBackupPath(destination) {
  const output = path.resolve(destination);
  let ancestor = output;
  const tail = [];
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Cannot resolve backup destination');
    ancestor = parent;
  }
  const resolved = path.join(fs.realpathSync(ancestor), ...tail);
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const target = normalize(resolved), repo = normalize(fs.realpathSync(ROOT));
  if (target === repo || target.startsWith(repo + path.sep)) throw new Error('Keep private backups outside the public repository');
  if (fs.existsSync(output)) throw new Error('Destination must be a new directory');
  return resolved;
}

async function captureArchive() {
  const { Client } = require('pg');
  const { readEnv } = require('./lib');
  const client = new Client({ connectionString: readEnv('SUPABASE_DB_URL'),
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 20000 });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = {};
    for (const table of TABLES) {
      console.log(`Reading ${table}`);
      const { rows: keys } = await client.query(
        `select string_agg(quote_ident(a.attname), ', ' order by array_position(i.indkey, a.attnum)) as pk
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = $1::regclass and i.indisprimary`, [table]);
      if (!keys[0]?.pk) throw new Error(`Missing primary key: ${table}`);
      const raw = [];
      // Маленькие ответы проходят через локальный VPN/пулер; вся выборка в одной транзакции.
      for (let offset = 0; ; offset += 5) {
        const { rows } = await client.query(
          `select row_to_json(t)::text as raw from (select * from ${table} order by ${keys[0].pk} limit 5 offset $1) t`, [offset]);
        raw.push(...rows.map((row) => row.raw));
        if (rows.length < 5) break;
      }
      tables[table] = `[${raw.join(',')}]`;
    }
    await client.query('COMMIT');
    return tables;
  } finally {
    await client.end().catch(() => {});
  }
}

function sheetsTransport(sheets, spreadsheetId) {
  const range = (title, cells) => `'${title.replace(/'/g, "''")}'!${cells}`;
  const base = { spreadsheetId };
  return {
    async create(rowCount) {
      const title = `Архив ${new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-')} UTC ${crypto.randomBytes(3).toString('hex')}`;
      const response = await sheets.spreadsheets.batchUpdate({ ...base, requestBody: { requests: [
        { addSheet: { properties: { title, gridProperties: { rowCount: Math.max(rowCount + 5, 20), columnCount: 3, frozenRowCount: 2 } } } },
      ] } });
      const sheetId = response.data.replies[0].addSheet.properties.sheetId;
      await sheets.spreadsheets.batchUpdate({ ...base, requestBody: { requests: [
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 2 }, cell: { userEnteredFormat: {
          backgroundColor: { red: 0.08, green: 0.08, blue: 0.12 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, wrapStrategy: 'CLIP',
        } }, fields: 'userEnteredFormat' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 650 }, fields: 'pixelSize' } },
      ] } });
      return title;
    },
    async write(title, rows) {
      // RAW запрещает интерпретацию JSON/пользовательского текста как формул.
      await sheets.spreadsheets.values.update({ ...base, range: range(title, 'A1'), valueInputOption: 'RAW', requestBody: { values: rows } });
    },
    async read(title, rowCount) {
      const response = await sheets.spreadsheets.values.get({ ...base, range: range(title, `A1:C${rowCount}`), valueRenderOption: 'UNFORMATTED_VALUE' });
      return response.data.values || [];
    },
    async complete(title) {
      await sheets.spreadsheets.values.update({ ...base, range: range(title, 'B1'), valueInputOption: 'RAW', requestBody: { values: [['COMPLETE']] } });
    },
  };
}

async function main(args) {
  const { sheetsClient, readEnv } = require('./lib');
  const sheets = sheetsClient();
  const spreadsheetId = readEnv('GOOGLE_SHEET_ID');
  const transport = sheetsTransport(sheets, spreadsheetId);
  if (args[0] === 'from-backup') {
    if (args.length !== 2) throw new Error('Usage: snapshot.js from-backup <verified-backup-directory>');
    const backup = readLocalBackup(args[1]);
    const result = await publishSnapshot(transport, backup.tables, backup.metadata);
    console.log(`COMPLETE: ${result.title}`);
    for (const [table, entry] of Object.entries(result.manifest.tables)) console.log(`${table}: ${entry.rows} rows, SHA-256 verified`);
    return;
  }
  if (args[0] === 'download') {
    const [, title, destination] = args;
    if (!title || !destination) throw new Error('Usage: snapshot.js download "Архив ..." <private-directory>');
    const output = privateBackupPath(destination);
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title,gridProperties(rowCount)))' });
    const sheet = meta.data.sheets.find((s) => s.properties.title === title);
    if (!sheet) throw new Error('Snapshot sheet not found');
    const snapshot = decodeSnapshot(await transport.read(title, sheet.properties.gridProperties.rowCount));
    fs.mkdirSync(output, { recursive: true });
    for (const [table, json] of Object.entries(snapshot.tables)) fs.writeFileSync(path.join(output, `${table}.json`), json, { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), { mode: 0o600 });
    fs.copyFileSync(path.join(__dirname, 'ARCHIVE-RESTORE.md'), path.join(output, 'RESTORE.md'));
    console.log(`VERIFIED download: ${output}`);
    return;
  }
  if (args.length) throw new Error('Usage: snapshot.js [download "Архив ..." <private-directory>]');
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (git('status', '--short', 'supabase/migrations')) throw new Error('Commit schema migrations before creating a snapshot');
  const metadata = { created_at: new Date().toISOString(), git_head: git('rev-parse', 'HEAD'),
    migrations: fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort() };
  const result = await publishSnapshot(transport, await captureArchive(), metadata);
  console.log(`COMPLETE: ${result.title}`);
  for (const [table, entry] of Object.entries(result.manifest.tables)) console.log(`${table}: ${entry.rows} rows, SHA-256 verified`);
  console.log(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

module.exports = { encodeSnapshot, decodeSnapshot, publishSnapshot, readLocalBackup, privateBackupPath };
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
