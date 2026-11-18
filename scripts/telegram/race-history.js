const compound = { MEDIUM: 'Medium', HARD: 'Hard', SOFT: 'Soft', INTERMEDIATE: 'Intermediate', WET: 'Wet' };
const count = n => Number.isInteger(n) && n >= 0 ? String(n) : 'Нет данных';
function previousHistory(race, dossier) {
  const history = dossier.previousRaceHistory;
  return history?.year === Number(race.season) - 1 ? history : null;
}
function strategyLines(history) {
  const s = history?.strategy;
  if (!s) return ['Нет подтверждённых данных.'];
  const stops = Number.isInteger(s.typicalStops) && s.typicalStops >= 0 ? `${s.typicalStops} ${s.typicalStops === 1 ? 'пит-стоп' : s.typicalStops < 5 && s.typicalStops > 1 ? 'пит-стопа' : 'пит-стопов'}` : 'нет данных';
  return [`Основной вариант: ${stops}.`,
    `Основная последовательность: ${(s.mainSequence || []).map(c => compound[c] || c).join(' → ') || 'нет данных'}.`,
    `Использовались: ${(s.compounds || []).map(c => compound[c] || c).join(', ') || 'нет данных'}.`,
    ...(Number.isInteger(s.winnerPitLap) && s.winnerPitLap > 0 ? [`Победитель: остановка на ${s.winnerPitLap}-м круге.`] : [])];
}
module.exports = { previousHistory, strategyLines, count };
