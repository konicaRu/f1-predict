const { q, close, recordRun } = require('./lib');
const { fetchJolpicaResults } = require('./jolpica');
const { fetchOpenF1Results } = require('./openf1');

async function driverCodeToIdMap() {
  const { rows } = await q('select id, code from drivers');
  return new Map(rows.map((d) => [d.code, d.id]));
}

// Пересмотр после штрафов (ревью 2026-10-08, №4). Результат заносится сразу как final, а стюарды
// могут переставить топ-10 уже после финиша (живой пример — Монако 2026: Гасли 3 → 7). Поэтому
// RECHECK_DAYS после старта гонки каждый прогон сверяем занесённое с Jolpica и при расхождении
// перезаносим: set_race_result пишет правку в result_changes, очки пересчитывает view scores.
// Сброс telegram_announced_at заставляет notify.js results() в том же прогоне объявить итоги
// заново с пометкой «пересмотрен» (узнаёт по причине правки RECHECK_REASON).
// Только Jolpica: она и есть источник истины; заодно так заменяется результат, занесённый из OpenF1.
const RECHECK_DAYS = 3;
const RECHECK_REASON = 'auto-recheck'; // тот же префикс ищет scripts/telegram/notify.js

async function recheck(warnings) {
  const { rows } = await q(
    `select r.id, r.round, r.name, res.positions
     from races r join results res on res.race_id = r.id
     where r.status = 'resulted' and r.scored = true
       and r.race_datetime_utc > now() - make_interval(days => $1)
     order by r.round`,
    [RECHECK_DAYS],
  );
  for (const r of rows) {
    try {
      const fresh = await fetchJolpicaResults(r.round);
      if (!fresh || JSON.stringify(fresh) === JSON.stringify(r.positions)) continue;
      await q('select set_race_result($1, $2::jsonb, $3)', [r.id, JSON.stringify(fresh), `${RECHECK_REASON}: Jolpica`]);
      await q('update races set telegram_announced_at = null where id = $1', [r.id]);
      console.log(`autoresults: ${r.name} — результат пересмотрен по Jolpica`);
    } catch (e) {
      console.error(`autoresults: пересмотр ${r.name} — ошибка: ${e.message}`);
      warnings.push(`пересмотр ${r.name}: ${e.message}`);
    }
  }
}

async function main() {
  const { rows: races } = await q(
    `select id, round, name, race_datetime_utc from races where status = 'open' and race_datetime_utc < now() order by round`,
  );
  if (races.length === 0) {
    console.log('autoresults: просроченных гонок нет');
    const warnings = [];
    await recheck(warnings);
    await recordRun('autoresults', true, warnings);
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

  await recheck(warnings);

  await recordRun('autoresults', true, warnings);
  await close();
}

main().catch(async (e) => {
  console.error('ERR', e.message);
  await recordRun('autoresults', false, [e.message]);
  await close();
  process.exit(1);
});
