import type { Driver } from '../lib/types';
import { DriverChip } from './DriverChip';

export function DriverPool({ pool, assigned, onPick }: {
  pool: Driver[];
  assigned: Set<string>;
  onPick: (driverId: string) => void;
}) {
  return (
    <div className="pool">
      {pool.map((d) => {
        const disabled = assigned.has(d.id) || !!d.out_reason;
        return (
          <DriverChip
            key={d.id}
            driver={d}
            compact
            dimmed={disabled}
            onClick={disabled ? undefined : () => onPick(d.id)}
          />
        );
      })}
    </div>
  );
}
