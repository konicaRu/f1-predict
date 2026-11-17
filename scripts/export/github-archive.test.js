const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveArchive } = require('./github-archive');
const metadata = { created_at: '2026-11-17T12:00:00Z', git_head: 'abc', migrations: [] };
const tables = Object.fromEntries(['users','drivers','races','race_driver_pool','predictions','results','result_changes'].map(t => [`public.${t}`, '[]']));
tables['public.results'] = '[{"race_id":1,"positions":["a","b"]}]';

test('first archive retains IDs and verifies files; repeat without changed results skips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-github-archive-'));
  try {
    const first = saveArchive(dir, tables, metadata);
    assert.equal(first.changed, true);
    assert.equal(fs.readFileSync(path.join(dir, first.directory, 'public.results.json'), 'utf8'), tables['public.results']);
    assert.equal(saveArchive(dir, tables, metadata).changed, false);
    const revised = { ...tables, 'public.results': '[{"race_id":1,"positions":["b","a"]}]' };
    const second = saveArchive(dir, revised, metadata);
    assert.equal(second.changed, true);
    assert.notEqual(second.directory, first.directory);
    assert.equal(fs.existsSync(path.join(dir, first.directory, 'manifest.json')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupted prior archive is preserved and replaced by a fresh verified version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-github-archive-'));
  try {
    const first = saveArchive(dir, tables, metadata);
    fs.writeFileSync(path.join(dir, first.directory, 'public.results.json'), '[{}]');
    const replacement = saveArchive(dir, tables, metadata);
    assert.equal(replacement.changed, true);
    assert.notEqual(replacement.directory, first.directory);
    assert.equal(fs.readFileSync(path.join(dir, replacement.directory, 'public.results.json'), 'utf8'), tables['public.results']);
    assert.equal(fs.readFileSync(path.join(dir, first.directory, 'public.results.json'), 'utf8'), '[{}]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
