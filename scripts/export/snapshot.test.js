const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeSnapshot, decodeSnapshot, publishSnapshot, readLocalBackup, privateBackupPath } = require('./snapshot');

const metadata = { created_at: '2026-11-17T11:00:00.000Z', git_head: 'abc', migrations: ['0001_schema.sql'] };
const tables = {
  'public.users': '[{"id":"u1","display_name":"Игрок 🏎️","telegram_user_id":9007199254740993}]',
  'public.drivers': '[]',
  'public.races': '[]',
  'public.race_driver_pool': '[]',
  'public.predictions': '[]',
  'public.results': '[]',
  'public.result_changes': '[]',
};

test('round-trip retains original JSON, large IDs, Unicode and empty tables', () => {
  const rows = encodeSnapshot(tables, metadata, 20);
  rows[0][1] = 'COMPLETE';
  const restored = decodeSnapshot(rows);
  assert.deepEqual(restored.tables, tables);
  assert.equal(restored.manifest.tables['public.users'].rows, 1);
  assert.equal(restored.manifest.tables['public.predictions'].rows, 0);
  assert.equal(restored.manifest.git_head, 'abc');
});

test('a whole missing table cannot be accepted even with a matching edited manifest', () => {
  const incomplete = { ...tables };
  delete incomplete['public.results'];
  assert.throws(() => encodeSnapshot(incomplete, metadata), /table|таблиц/i);
  const rows = encodeSnapshot(tables, metadata);
  rows[0][1] = 'COMPLETE';
  const manifest = JSON.parse(rows[1][1]);
  delete manifest.tables['public.results'];
  rows[1][1] = JSON.stringify(manifest);
  const modified = rows.filter((row) => row[0] !== 'public.results');
  assert.throws(() => decodeSnapshot(modified), /table|таблиц/i);
});

test('corrupted JSON chunk cannot be accepted', () => {
  const rows = encodeSnapshot(tables, metadata, 20);
  rows[0][1] = 'COMPLETE';
  rows[2][2] += 'x';
  assert.throws(() => decodeSnapshot(rows), /checksum|контроль/i);
});

test('missing chunk and PREPARING snapshot cannot be accepted', () => {
  const rows = encodeSnapshot(tables, metadata, 20);
  assert.throws(() => decodeSnapshot(rows), /COMPLETE/);
  rows[0][1] = 'COMPLETE';
  rows.splice(2, 1);
  assert.throws(() => decodeSnapshot(rows), /chunk|част|checksum|контроль/i);
});

test('failed read-back never marks the new sheet COMPLETE', async () => {
  let completed = false;
  const transport = {
    create: async () => 'Архив test',
    write: async () => {},
    read: async () => [['F1_ARCHIVE_V1', 'PREPARING']],
    complete: async () => { completed = true; },
  };
  await assert.rejects(publishSnapshot(transport, tables, metadata));
  assert.equal(completed, false);
});

test('successful publication returns a verified downloadable snapshot', async () => {
  let stored;
  const transport = {
    create: async () => 'Архив test',
    write: async (_title, rows) => { stored = structuredClone(rows); },
    read: async () => structuredClone(stored),
    complete: async () => { stored[0][1] = 'COMPLETE'; },
  };
  const result = await publishSnapshot(transport, tables, metadata);
  assert.equal(result.title, 'Архив test');
  assert.deepEqual(decodeSnapshot(stored).tables, tables);
});

test('upload from a local backup rejects a corrupted file before touching Sheets', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-snapshot-test-'));
  try {
    const names = ['users', 'drivers', 'races', 'race_driver_pool', 'predictions', 'results', 'result_changes'];
    const manifest = { ...metadata, tables: {} };
    for (const name of names) {
      const table = `public.${name}`;
      fs.writeFileSync(path.join(dir, `${table}.json`), '[]');
      manifest.tables[table] = { rows: 0, sha256: crypto.createHash('sha256').update('[]').digest('hex'), verified: true };
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.equal(readLocalBackup(dir).tables['public.results'], '[]');
    fs.writeFileSync(path.join(dir, 'public.results.json'), '[{}]');
    assert.throws(() => readLocalBackup(dir), /checksum|контроль/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('private download refuses repository paths including different Windows casing', () => {
  const path = require('path');
  const root = path.resolve(__dirname, '../..');
  assert.throws(() => privateBackupPath(path.join(root, 'private-copy')), /outside/);
  if (process.platform === 'win32') assert.throws(() => privateBackupPath(path.join(root.toUpperCase(), 'private-copy')), /outside/);
});
