import type { Race } from '../lib/types';
import { formatCountdown, formatMoscow, isPast } from '../lib/countdown';
import { raceCountry } from '../lib/flags';
import { Flag } from './Flag';

export type RaceView = 'open' | 'locked' | 'soon' | 'past';

export function classifyRace(race: Race, now: number = Date.now()): RaceView {
  const past = isPast(race.deadline_utc, now);
  if (race.status === 'open') return past ? 'locked' : 'open';
  if (race.status === 'demo') return past ? 'past' : 'soon';
  return 'past'; // closed / resulted
}

const BADGE: Record<RaceView, string> = {
  open: 'открыта', locked: 'закрыта', soon: 'скоро', past: 'результаты',
};

export function RaceCard({ race, hasPrediction, highlight, onClick }: {
  race: Race;
  hasPrediction: boolean;
  highlight?: boolean;
  onClick?: () => void;
}) {
  const view = classifyRace(race);
  const clickable = view === 'open' || view === 'locked';
  return (
    <div
      className={'race-card' + (highlight ? ' race-hl' : '') + (clickable ? ' race-click' : ' race-static')}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
    >
      <div className="race-main">
        <span className="race-round">R{race.round}</span>
        <Flag code={raceCountry(race.name)} />
        <span className="race-name">{race.name}</span>
      </div>
      <div className="race-meta">
        <span className={'race-badge badge-' + view}>{BADGE[view]}</span>
        {race.race_datetime_utc && <span className="race-date">{formatMoscow(race.race_datetime_utc)} МСК</span>}
        {view === 'open' && <span className="race-cd">⏱ {formatCountdown(race.deadline_utc)}</span>}
        <span className={'race-pred' + (hasPrediction ? ' has' : '')}>
          {hasPrediction ? '✓ прогноз' : '— нет прогноза'}
        </span>
      </div>
    </div>
  );
}
