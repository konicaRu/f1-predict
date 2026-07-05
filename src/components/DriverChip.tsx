import type { Driver } from '../lib/types';

export function DriverChip({ driver, onClick, selected, dimmed, compact }: {
  driver: Driver;
  onClick?: () => void;
  selected?: boolean;
  dimmed?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={'chip' + (selected ? ' chip-sel' : '') + (dimmed ? ' chip-dim' : '') + (compact ? ' chip-compact' : '')}
      style={{ borderLeftColor: driver.team_color || '#888' }}
    >
      <span className="chip-code">{driver.code}</span>
      {!compact && <span className="chip-name">{driver.name}</span>}
    </button>
  );
}
