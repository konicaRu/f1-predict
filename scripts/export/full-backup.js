// Секретные дампы существуют только в RUNNER_TEMP; в GitHub уходит AES-GCM ciphertext.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Client } = require('pg');
const { readEnv } = require('./lib');
const { encryptBackup, decryptBackup } = require('./encrypted-backup');

const IMAGE = 'supabase/postgres:17.6.1.136';
const ROOT = path.resolve(__dirname, '../..');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
const qualified = (name) => name.split('.').map(quote).join('.');
const fingerprintSQL = (name) => `select json_build_object('rows', count(*), 'md5', md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' order by to_jsonb(t)::text), ''))) from ${qualified(name)} t`;

function sourceEnvironment() {
  const url = new URL(readEnv('SUPABASE_DB_URL'));
  // pg_dump требует Session pooler, не Transaction pooler.
  return { ...process.env, PGHOST: url.hostname, PGPORT: url.port === '6543' ? '5432' : (url.port || '5432'),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1) || 'postgres', PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '20', PGTZ: 'UTC' };
}

async function command(args, label, directory, options = {}) {
  const stderr = fs.openSync(path.join(directory, label + '.stderr'), 'w', 0o600);
  const stdout = options.file ? fs.openSync(options.file, 'w', 0o600) : 'pipe';
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { env: options.env || process.env,
        stdio: ['ignore', stdout, stderr], timeout: 600000 });
      let output = '';
      child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
      child.on('error', () => reject(new Error(`${label}: command could not start`)));
      child.on('close', (code) => {
        if (code === 0) return resolve(output.trim());
        // Выводим только название отсутствующей системной зависимости, не SQL/строки auth.
        const diagnostic = fs.readFileSync(path.join(directory, label + '.stderr'), 'utf8');
        const safe = diagnostic.match(/ERROR:\s+(?:extension|role|schema|relation) "([a-zA-Z0-9_.-]+)" (?:is not available|does not exist|already exists)/);
        reject(new Error(`${label}: failed${safe ? '; system dependency: ' + safe[1] : ''}`));
      });
    });
  } finally { fs.closeSync(stderr); if (typeof stdout === 'number') fs.closeSync(stdout); }
}

async function capture(directory) {
  const env = sourceEnvironment();
  const client = new Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER,
    password: env.PGPASSWORD, database: env.PGDATABASE, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000, query_timeout: 30000, keepAlive: true });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL timezone = 'UTC'");
    const snapshot = (await client.query('select pg_export_snapshot() as id')).rows[0].id;
    const tables = (await client.query(`select n.nspname || '.' || c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('auth','public')
      and c.relkind in ('r','p') order by n.nspname,c.relname`)).rows.map((row) => row.name);
    for (const required of ['auth.users', 'auth.identities', 'public.users', 'public.predictions', 'public.results']) {
      if (!tables.includes(required)) throw new Error('Missing required table: ' + required);
    }
    const expected = {};
    for (const table of [...tables, 'public.scores']) expected[table] = (await client.query(fingerprintSQL(table))).rows[0].json_build_object;
    const roles = (await client.query("select rolname from pg_roles where rolname !~ '^pg_' order by rolname")).rows.map((row) => row.rolname);
    const probe = (await client.query('select u.id from public.users u where not u.is_admin and exists (select 1 from public.predictions p where p.user_id=u.id) order by u.id limit 1')).rows[0];
    const authProbe = probe ? { user_id: probe.id, own_predictions: Number((await client.query('select count(*) from public.predictions where user_id = $1', [probe.id])).rows[0].count) } : null;
    const dumpFile = path.join(directory, 'database.dump');
    await command(['run', '--rm', '--network', 'host', ...['PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGSSLMODE','PGCONNECT_TIMEOUT','PGTZ'].flatMap((name) => ['--env', name]),
      '--entrypoint', 'pg_dump', IMAGE, '--format=custom', '--schema=auth', '--schema=public', '--schema=extensions',
      '--lock-wait-timeout=20s', `--snapshot=${snapshot}`], 'capture', directory, { env, file: dumpFile });
    await client.query('COMMIT');
    return { version: 1, created_at: new Date().toISOString(),
      git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      scope: 'auth-public-extensions', image: IMAGE, expected, roles, auth_probe: authProbe,
      dump_sha256: hash(fs.readFileSync(dumpFile)), dump: fs.readFileSync(dumpFile).toString('base64') };
  } finally { await client.end().catch(() => {}); }
}

async function rehearse(bundle, directory) {
  const dump = Buffer.from(bundle.dump, 'base64');
  if (hash(dump) !== bundle.dump_sha256) throw new Error('Dump checksum mismatch');
  const dumpFile = path.join(directory, 'restore.dump');
  fs.writeFileSync(dumpFile, dump, { mode: 0o600 });
  const container = 'f1-restore-' + crypto.randomBytes(6).toString('hex');
  const testPassword = crypto.randomBytes(24).toString('hex');
  const targetEnv = { ...process.env, POSTGRES_PASSWORD: testPassword, PGPASSWORD: testPassword };
  try {
    const runLabel = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
    await command(['run', '-d', '--name', container, '--network', 'none', '--label', `f1-recovery=${runLabel}`, '--env', 'POSTGRES_PASSWORD', IMAGE], 'start-test-db', directory, { env: targetEnv });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        await command(['exec', container, 'pg_isready', '-U', 'supabase_admin'], 'ready', directory);
        ready = true; break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
    }
    if (!ready) throw new Error('Isolated database did not start');
    const network = await command(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container], 'network-check', directory);
    if (network !== 'none') throw new Error('Restore container must have no network');
    const existingRoles = JSON.parse(await command(['exec', '--env', 'PGPASSWORD', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-AtXq', '-c', 'select json_agg(rolname) from pg_roles'], 'read-test-roles', directory, { env: targetEnv }));
    for (const role of bundle.roles) {
      if (!existingRoles.includes(role)) await command(['exec', '--env', 'PGPASSWORD', container, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-AtXq', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE ROLE ${quote(role)} NOLOGIN`], 'create-test-role', directory, { env: targetEnv });
    }
    await command(['exec', '--env', 'PGPASSWORD', container, 'createdb', '-U', 'supabase_admin', '-T', 'template0', 'f1_recovery'], 'create-test-database', directory, { env: targetEnv });
    await command(['cp', dumpFile, `${container}:/tmp/restore.dump`], 'copy-dump', directory);
    await command(['exec', '--env', 'PGPASSWORD', container, 'pg_restore', '-U', 'supabase_admin', '--dbname=f1_recovery', '--exit-on-error', '--single-transaction', '/tmp/restore.dump'], 'restore', directory, { env: targetEnv });
    const counts = {};
    for (const [table, expected] of Object.entries(bundle.expected)) {
      const output = await command(['exec', '--env', 'PGPASSWORD', '--env', 'PGTZ=UTC', container,
        'psql', '-U', 'supabase_admin', '-d', 'f1_recovery', '-AtXq', '-v', 'ON_ERROR_STOP=1', '-c', fingerprintSQL(table)], 'verify-table', directory, { env: targetEnv });
      const actual = JSON.parse(output);
      if (actual.rows !== expected.rows || actual.md5 !== expected.md5) throw new Error('Restored table mismatch: ' + table);
      counts[table] = actual.rows;
    }
    // Ограничения dump восстанавливаются pg_restore; дополнительно проверяем принадлежность прогнозов.
    const orphanQuery = 'select count(*) from public.predictions p left join auth.users u on u.id=p.user_id where u.id is null';
    const orphans = await command(['exec', '--env', 'PGPASSWORD', container, 'psql', '-U', 'supabase_admin', '-d', 'f1_recovery', '-AtXq', '-c', orphanQuery], 'verify-links', directory, { env: targetEnv });
    if (orphans !== '0') throw new Error('Orphan predictions after restore');
    if (bundle.auth_probe) {
      const id = bundle.auth_probe.user_id;
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid probe UUID');
      const sql = `BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '${id}'; SELECT count(*) FROM public.predictions WHERE user_id = auth.uid(); ROLLBACK;`;
      const visible = await command(['exec', '--env', 'PGPASSWORD', container, 'psql', '-U', 'supabase_admin', '-d', 'f1_recovery', '-AtXq', '-v', 'ON_ERROR_STOP=1', '-c', sql], 'verify-authenticated-access', directory, { env: targetEnv });
      if (Number(visible) !== bundle.auth_probe.own_predictions) throw new Error('Authenticated user cannot read their restored predictions');
    }
    return { verified_at: new Date().toISOString(), network: 'none', tables: counts, orphan_predictions: 0, authenticated_access_verified: Boolean(bundle.auth_probe) };
  } finally {
    await command(['rm', '-fv', container], 'remove-test-db', directory);
    const remaining = await command(['ps', '-aq', '--filter', `name=^/${container}$`], 'confirm-cleanup', directory);
    if (remaining) throw new Error('Sensitive restore container was not removed');
  }
}

async function main(args) {
  const key = readEnv('FULL_BACKUP_KEY');
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'f1-full-backup-'));
  let privateRepository;
  try {
    if (args[0] === 'decrypt') {
      if (!args[1] || !args[2]) throw new Error('Usage: full-backup.js decrypt <encrypted-file> <new-private-directory>');
      const { privateBackupPath } = require('./snapshot');
      const destination = privateBackupPath(args[2]);
      const bundle = JSON.parse(decryptBackup(JSON.parse(fs.readFileSync(args[1], 'utf8')), key).toString('utf8'));
      const dump = Buffer.from(bundle.dump, 'base64');
      if (hash(dump) !== bundle.dump_sha256) throw new Error('Dump checksum mismatch');
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(destination, 'database.dump'), dump, { mode: 0o600 });
      const { dump: _omitted, ...manifest } = bundle;
      fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      console.log('Decrypted and verified backup written to private directory');
      return;
    }
    const repository = path.resolve(args[0] || '');
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repository, encoding: 'utf8' }).trim();
    if (!/github\.com[:/]konicaRu\/f1-predict-archive(?:\.git)?$/.test(remote)) throw new Error('Private archive repository required');
    privateRepository = repository;
    const bundle = await capture(directory);
    const sealed = encryptBackup(Buffer.from(JSON.stringify(bundle)), key);
    const encryptedFile = path.join(directory, 'backup.enc.json');
    fs.writeFileSync(encryptedFile, JSON.stringify(sealed), { mode: 0o600 });
    // Восстанавливаем именно записанный и повторно расшифрованный файл, не исходный dump.
    const restoredBundle = JSON.parse(decryptBackup(JSON.parse(fs.readFileSync(encryptedFile, 'utf8')), key).toString('utf8'));
    const report = await rehearse(restoredBundle, directory);
    const filename = bundle.created_at.replace(/[:.]/g, '-') + '_' + crypto.randomBytes(4).toString('hex') + '.enc.json';
    const output = path.join(repository, 'full');
    fs.mkdirSync(output, { recursive: true });
    fs.copyFileSync(encryptedFile, path.join(output, filename));
    fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify({ file: filename, sha256: hash(fs.readFileSync(encryptedFile)), ...report }, null, 2));
    console.log(`Encrypted backup and isolated restore VERIFIED: full/${filename}`);
    console.log(JSON.stringify(report)); // Только имена таблиц и количества строк, без данных пользователей.
  } catch (error) {
    // Ошибки могут содержать фрагменты SQL/auth: сохраняем только зашифрованную диагностику.
    if (privateRepository) {
      const diagnostics = {};
      for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith('.stderr'))) diagnostics[filename] = fs.readFileSync(path.join(directory, filename), 'utf8');
      const diagnostic = encryptBackup(Buffer.from(JSON.stringify({ stage: error.message, diagnostics })), key);
      const output = path.join(privateRepository, 'full/diagnostics');
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, new Date().toISOString().replace(/[:.]/g, '-') + '.enc.json'), JSON.stringify(diagnostic));
    }
    throw error;
  } finally {
    const temporaryRoot = path.resolve(process.env.RUNNER_TEMP || os.tmpdir());
    if (!path.resolve(directory).startsWith(temporaryRoot + path.sep)) throw new Error('Unsafe temporary directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
