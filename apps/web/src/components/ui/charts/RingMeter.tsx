import type { ReactNode } from 'react';
import { PALETTE } from './palette';

const SERIES = { primary: PALETTE.primary } as const;
const STATUS = { good: PALETTE.good, warn: PALETTE.warn, bad: PALETTE.bad } as const;

/** One ratio against a limit — a ring that fills to `percent` (0–100). */

export function RingMeter({
  percent,
  tone = 'primary',
  size = 88,
  children,
  label,
}: {
  percent: number | null;
  tone?: 'primary' | 'good' | 'warn' | 'bad';
  size?: number;
  /** Center content (the figure). */
  children?: ReactNode;
  label: string;
}) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const color =
    tone === 'good' ? STATUS.good : tone === 'warn' ? STATUS.warn : tone === 'bad' ? STATUS.bad : SERIES.primary;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        // A meter needs a value; with no reading it's a labelled picture.
        {...(percent === null ? { role: 'img' } : { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent })}
        aria-label={label}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={8} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 500ms ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
