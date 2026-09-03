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
      title={driver.out_reason || driver.added_reason || undefined}
    >
      <span className="chip-code">{driver.code}</span>
      {!compact && <span className="chip-name">{driver.name}</span>}
      {driver.out_reason && <span className="chip-dnf">DNF</span>}
      {driver.added_reason && <span className="chip-sub">ЗАМЕНА</span>}
    </button>
  );
}
