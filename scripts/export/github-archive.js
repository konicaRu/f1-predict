// Только для checkout отдельного ПРИВАТНОГО репозитория архива.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { encodeSnapshot, decodeSnapshot, readLocalBackup, captureArchive } = require('./snapshot');

function saveArchive(repository, tables, metadata) {
  const encoded = encodeSnapshot(tables, metadata);
  encoded[0][1] = 'COMPLETE';
  const snapshot = decodeSnapshot(encoded);
  const fingerprint = crypto.createHash('sha256')
    .update(tables['public.results']).update('\n').update(tables['public.result_changes']).digest('hex');
  const archiveRoot = path.resolve(repository, 'archive');
  const latestFile = path.join(archiveRoot, 'latest.json');
  if (fs.existsSync(latestFile)) {
    const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    const existing = path.resolve(repository, latest.directory);
    if (!existing.startsWith(archiveRoot + path.sep)) throw new Error('Invalid archive path');
    if (latest.fingerprint === fingerprint) {
      // Повреждённый старый снимок не должен блокировать свежий резерв.
      try {
        readLocalBackup(existing);
        return { changed: false, directory: latest.directory };
      } catch {
        console.warn('Previous archive failed verification; preserving it and creating a replacement');
      }
    }
  }
  const stamp = metadata.created_at.replace(/[:.]/g, '-');
  const directory = `archive/${stamp}_${crypto.randomBytes(4).toString('hex')}`;
  const output = path.join(repository, directory);
  fs.mkdirSync(output, { recursive: true });
  for (const [table, json] of Object.entries(snapshot.tables)) fs.writeFileSync(path.join(output, `${table}.json`), json);
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2));
  fs.copyFileSync(path.join(__dirname, 'ARCHIVE-RESTORE.md'), path.join(output, 'RESTORE.md'));
  readLocalBackup(output); // Прочитать файлы обратно до обновления указателя.
  const temporary = latestFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint, directory, created_at: metadata.created_at }, null, 2));
  fs.renameSync(temporary, latestFile);
  return { changed: true, directory };
}

async function main(repository) {
  if (!repository) throw new Error('Usage: github-archive.js <private-repository-checkout>');
  const root = path.resolve(__dirname, '../..');
  const destination = path.resolve(repository);
  // Вложенный отдельный checkout допустим, корень публичного проекта — нет.
  if (destination === root || !fs.existsSync(path.join(destination, '.git'))) throw new Error('Separate archive repository checkout required');
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: destination, encoding: 'utf8' }).trim();
  if (!/github\.com[:/]konicaRu\/f1-predict-archive(?:\.git)?$/.test(remote)) throw new Error('Unexpected archive repository');
  const metadata = { created_at: new Date().toISOString(),
    git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    migrations: fs.readdirSync(path.join(root, 'supabase/migrations')).filter((file) => file.endsWith('.sql')).sort(),
    source: 'github-after-results' };
  const result = saveArchive(destination, await captureArchive(), metadata);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  console.log(result.changed ? `Verified new archive: ${result.directory}` : 'Results unchanged; existing archive verified');
}

module.exports = { saveArchive };
if (require.main === module) main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
