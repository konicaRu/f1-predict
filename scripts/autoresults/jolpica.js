// Основной источник результатов — Jolpica (Ergast-совместимый REST).
// Тот же эндпоинт, что уже использовался в scripts/import/import.js для разовой загрузки истории.
async function fetchJolpicaResults(round) {
  const res = await fetch(`https://api.jolpi.ca/ergast/f1/2026/${round}/results.json?limit=100`);
  if (!res.ok) throw new Error(`Jolpica HTTP ${res.status}`);
  const data = await res.json();
  const races = data.MRData.RaceTable.Races;
  if (!races.length || !races[0].Results || races[0].Results.length < 10) return null;
  return races[0].Results
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position))
    .slice(0, 10)
    .map((r) => r.Driver.driverId);
}

module.exports = { fetchJolpicaResults };
