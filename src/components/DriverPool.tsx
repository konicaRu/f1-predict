import type { Driver } from '../lib/types';
import { DriverChip } from './DriverChip';

export function DriverPool({ pool, assigned, onPick }: {
  pool: Driver[];
  assigned: Set<string>;
  onPick: (driverId: string) => void;
}) {
  return (
    <div className="pool">
      {pool.map((d) => (
        <DriverChip
          key={d.id}
          driver={d}
          compact
          dimmed={assigned.has(d.id)}
          onClick={assigned.has(d.id) ? undefined : () => onPick(d.id)}
        />
      ))}
    </div>
  );
}
