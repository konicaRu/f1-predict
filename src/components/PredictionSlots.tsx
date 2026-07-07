import type { Driver } from '../lib/types';
import { DriverChip } from './DriverChip';

export function PredictionSlots({ slots, driversById, selectedIndex, onSlotClick, readOnly }: {
  slots: (string | null)[];
  driversById: Map<string, Driver>;
  selectedIndex?: number | null;
  onSlotClick?: (index: number) => void;
  readOnly?: boolean;
}) {
  return (
    <ol className="slots">
      {slots.map((driverId, i) => {
        const d = driverId ? driversById.get(driverId) : null;
        const sel = selectedIndex === i;
        return (
          <li key={i} className={'slot' + (sel ? ' slot-sel' : '')}>
            <span className="slot-pos">{i + 1}</span>
            {d ? (
              <DriverChip driver={d} compact onClick={readOnly ? undefined : () => onSlotClick?.(i)} />
            ) : (
              <button type="button" className="slot-empty" disabled={readOnly} onClick={() => onSlotClick?.(i)}>
                {sel ? '▸' : '—'}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
