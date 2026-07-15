import type { Score, LeagueUser } from './types';

export interface StandingRow {
  userId: string;
  name: string;
  points: number;
  exact: number;
  bestRace: number;
  played: number;
  rank: number;
}

// Агрегирует очки по игрокам среди ЗАЧЁТНЫХ гонок и ранжирует.
// Тайбрейкер (конституция §1): очки ↓ → точные ↓ → лучшая гонка ↓ (затем имя — для стабильности рендера).
// Ранг соревновательный: равным ключам — одно место, следующий сдвигается (1,2,2,4).
export function aggregateStandings(
  scores: Score[],
  users: LeagueUser[],
  scoredRaceIds: Set<number>,
): StandingRow[] {
  const agg = new Map<string, { points: number; exact: number; bestRace: number; played: number }>();
  for (const u of users) agg.set(u.id, { points: 0, exact: 0, bestRace: 0, played: 0 });
  for (const s of scores) {
    if (!scoredRaceIds.has(s.race_id)) continue;
    const a = agg.get(s.user_id);
    if (!a) continue; // счёт по не-члену лиги игнорируем
    a.points += s.points;
    a.exact += s.exact_hits;
    a.bestRace = Math.max(a.bestRace, s.points);
    a.played += 1;
  }
  const rows: StandingRow[] = users.map((u) => {
    const a = agg.get(u.id)!;
    return {
      userId: u.id,
      name: u.display_name,
      points: a.points,
      exact: a.exact,
      bestRace: a.bestRace,
      played: a.played,
      rank: 0,
    };
  });
  rows.sort(
    (a, b) => b.points - a.points || b.exact - a.exact || b.bestRace - a.bestRace || a.name.localeCompare(b.name),
  );
  let rank = 0;
  let prev: StandingRow | null = null;
  rows.forEach((r, i) => {
    if (!prev || r.points !== prev.points || r.exact !== prev.exact || r.bestRace !== prev.bestRace) {
      rank = i + 1;
    }
    r.rank = rank;
    prev = r;
  });
  return rows;
}
