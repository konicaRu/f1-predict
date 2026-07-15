const { q, close, sheetsClient, readEnv } = require('./lib');

const TABS = ['Прогнозы', 'Результаты', 'Очки'];

async function ensureTabs(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
  const toAdd = TABS.filter((t) => !existing.has(t));
  if (toAdd.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })) },
  });
}

function toMsk(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

async function writeTab(sheets, spreadsheetId, tab, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}

async function driverCodeMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((r) => [r.id, r.code]));
}

function posHeader() {
  return Array.from({ length: 10 }, (_, i) => `П${i + 1}`);
}

async function exportPredictions(sheets, spreadsheetId, codeOf) {
  const { rows } = await q(`
    select r.round, r.name as race, u.display_name as "user", p.positions, p.created_at
    from predictions p
    join races r on r.id = p.race_id
    join users u on u.id = p.user_id
    order by r.round, u.display_name
  `);
  const header = ['Раунд', 'Гонка', 'Участник', ...posHeader(), 'Дата отправки (МСК)'];
  const data = rows.map((r) => [
    r.round,
    r.race,
    r.user,
    ...r.positions.map((id) => codeOf.get(id) || id),
    toMsk(r.created_at),
  ]);
  await writeTab(sheets, spreadsheetId, 'Прогнозы', [header, ...data]);
  return data.length;
}

async function exportResults(sheets, spreadsheetId, codeOf) {
  const { rows } = await q(`
    select r.round, r.name as race, res.positions, res.status, res.fetched_at
    from results res
    join races r on r.id = res.race_id
    where res.positions is not null
    order by r.round
  `);
  const header = ['Раунд', 'Гонка', ...posHeader(), 'Статус', 'Дата заноса (МСК)'];
  const data = rows.map((r) => [
    r.round,
    r.race,
    ...r.positions.map((id) => codeOf.get(id) || id),
    r.status,
    toMsk(r.fetched_at),
  ]);
  await writeTab(sheets, spreadsheetId, 'Результаты', [header, ...data]);
  return data.length;
}

async function exportScores(sheets, spreadsheetId) {
  const { rows } = await q(`
    select r.round, r.name as race, u.display_name as "user", s.points, s.exact_hits
    from scores s
    join races r on r.id = s.race_id
    join users u on u.id = s.user_id
    order by r.round, s.points desc
  `);
  const header = ['Раунд', 'Гонка', 'Участник', 'Очки', 'Точных попаданий'];
  const data = rows.map((r) => [r.round, r.race, r.user, r.points, r.exact_hits]);
  await writeTab(sheets, spreadsheetId, 'Очки', [header, ...data]);
  return data.length;
}

async function main() {
  const spreadsheetId = readEnv('GOOGLE_SHEET_ID');
  const sheets = sheetsClient();
  await ensureTabs(sheets, spreadsheetId);
  const codeOf = await driverCodeMap();
  const nPred = await exportPredictions(sheets, spreadsheetId, codeOf);
  const nRes = await exportResults(sheets, spreadsheetId, codeOf);
  const nScores = await exportScores(sheets, spreadsheetId);
  console.log(`Прогнозы: ${nPred} строк | Результаты: ${nRes} строк | Очки: ${nScores} строк`);
  await close();
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
