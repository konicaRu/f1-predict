// Резервный источник — OpenF1. Сессия гонки ищется по дате (надёжнее парсинга англ. названия страны
// из races.name), позиции сопоставляются с нашими drivers через driver_number -> name_acronym -> code.
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // ±3 дня — гонка должна попасть в это окно, иначе не она

async function findSessionKey(raceDatetimeUtc) {
  const res = await fetch('https://api.openf1.org/v1/sessions?year=2026&session_name=Race');
  if (!res.ok) throw new Error(`OpenF1 sessions HTTP ${res.status}`);
  const sessions = await res.json();
  const target = new Date(raceDatetimeUtc).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const s of sessions) {
    const diff = Math.abs(new Date(s.date_start).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  if (!best || bestDiff > WINDOW_MS) return null;
  return best.session_key;
}

async function fetchOpenF1Results(raceDatetimeUtc, driverCodeToId) {
  const sessionKey = await findSessionKey(raceDatetimeUtc);
  if (!sessionKey) return null;

  const [resultsRes, driversRes] = await Promise.all([
    fetch(`https://api.openf1.org/v1/session_result?session_key=${sessionKey}`),
    fetch(`https://api.openf1.org/v1/drivers?session_key=${sessionKey}`),
  ]);
  if (!resultsRes.ok) throw new Error(`OpenF1 session_result HTTP ${resultsRes.status}`);
  if (!driversRes.ok) throw new Error(`OpenF1 drivers HTTP ${driversRes.status}`);

  const results = await resultsRes.json();
  const drivers = await driversRes.json();
  const classified = results.filter((r) => r.position != null); // DNF/DNS/DSQ несут position:null — не участвуют в зачёте
  if (classified.length < 10) return null;

  const numberToCode = new Map(drivers.map((d) => [d.driver_number, d.name_acronym]));
  const top10 = classified
    .slice()
    .sort((a, b) => a.position - b.position)
    .slice(0, 10)
    .map((r) => {
      const code = numberToCode.get(r.driver_number);
      return code ? driverCodeToId.get(code) : undefined;
    });
  if (top10.some((id) => !id)) return null; // не смогли сопоставить кого-то — не рискуем занести неполные данные

  return top10;
}

module.exports = { fetchOpenF1Results };
