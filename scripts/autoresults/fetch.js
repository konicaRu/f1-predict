const { q, close, recordRun } = require('./lib');
const { fetchJolpicaResults } = require('./jolpica');
const { fetchOpenF1Results } = require('./openf1');

async function driverCodeToIdMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((d) => [d.code, d.id]));
}

async function main() {
  const { rows: races } = await q(
    `select id, round, name, race_datetime_utc from races where status = 'open' and race_datetime_utc < now() order by round`,
  );
  if (races.length === 0) {
    console.log('autoresults: просроченных гонок нет');
    await recordRun('autoresults', true);
    await close();
    return;
  }

  const codeToId = await driverCodeToIdMap();

  let entered = 0;
  let pending = 0;
  let failed = 0;
  // Сбой по отдельной гонке прогон не валит (остальные гонки заносятся), но раньше он оставался
  // только в логе Actions. Теперь уходит в пульс — сторож сообщит админу.
  const warnings = [];

  for (const r of races) {
    try {
      let positions = await fetchJolpicaResults(r.round);
      let source = 'Jolpica';
      if (!positions) {
        positions = await fetchOpenF1Results(r.race_datetime_utc, codeToId);
        source = 'OpenF1';
      }
      if (!positions) {
        console.log(`autoresults: ${r.name} — источники пока пусты`);
        pending++;
        continue;
      }
      await q('select set_race_result($1, $2::jsonb)', [r.id, JSON.stringify(positions)]);
      console.log(`autoresults: ${r.name} — занесено (${source})`);
      entered++;
    } catch (e) {
      console.error(`autoresults: ${r.name} — ошибка: ${e.message}`);
      warnings.push(`${r.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`autoresults: итог — занесено ${entered}, источники пока пусты ${pending}, ошибок ${failed}`);

  await recordRun('autoresults', true, warnings);
  await close();
}

main().catch(async (e) => {
  console.error('ERR', e.message);
  await recordRun('autoresults', false, [e.message]);
  await close();
  process.exit(1);
});
