import type { ComponentType } from 'react';
import {
  BH, SA, AU, CN, JP, US, IT, MC, CA, ES, AT, GB, HU, BE, NL, AZ, SG, MX, BR, QA, AE,
} from 'country-flag-icons/react/3x2';

type FlagProps = { className?: string; role?: string; 'aria-label'?: string };

// Только страны грида F1 — именованные импорты, чтобы Vite вырезал остальные (tree-shaking).
const MAP: Record<string, ComponentType<FlagProps>> = {
  BH, SA, AU, CN, JP, US, IT, MC, CA, ES, AT, GB, HU, BE, NL, AZ, SG, MX, BR, QA, AE,
};

// SVG-флаг страны по ISO-коду. Если код неизвестен — клетчатый флаг-фолбэк.
export function Flag({ code }: { code: string }) {
  const C = MAP[code];
  if (!C) return <span className="race-flag-fallback" aria-hidden>🏁</span>;
  return <C className="race-flag" role="img" aria-label={code} />;
}
