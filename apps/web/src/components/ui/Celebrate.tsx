import * as React from 'react';

/**
 * One-shot celebration burst — a dependency-free confetti pop for the
 * handful of genuinely happy moments in the product (onboarding hits 100%,
 * first paystub, offer accepted). Deliberately NOT a library: 24 CSS-animated
 * particles, ~1.6s, then unmounts itself.
 *
 * Renders nothing under prefers-reduced-motion. Keyed remounts re-fire it;
 * a mounted instance plays exactly once.
 */

const PARTICLE_COUNT = 24;
const COLORS = ['#D9B967', '#E8CF8F', '#5B7A9D', '#7FA3C7', '#FFFFFF'];
const DURATION_MS = 1600;

// Deterministic pseudo-random per particle index — stable across renders,
// no Math.random in render.
function hash(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function Celebrate({ className }: { className?: string }) {
  const [done, setDone] = React.useState(false);
  const [reduced] = React.useState(
    () =>
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  React.useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setDone(true), DURATION_MS + 200);
    return () => clearTimeout(t);
  }, [reduced]);

  if (reduced || done) return null;

  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + hash(i, 1) * 0.5;
    const dist = 60 + hash(i, 2) * 90;
    const dx = Math.cos(angle) * dist;
    // Bias upward so the burst pops, then CSS gravity settles it down.
    const dy = Math.sin(angle) * dist - 40;
    const size = 5 + hash(i, 3) * 5;
    const color = COLORS[i % COLORS.length];
    const delay = hash(i, 4) * 120;
    const spin = 180 + hash(i, 5) * 540;
    return (
      <span
        key={i}
        className="absolute left-1/2 top-1/2 rounded-[1px]"
        style={{
          width: size,
          height: size * (0.5 + hash(i, 6) * 0.7),
          background: color,
          animation: `celebrate-pop ${DURATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms both`,
          // Per-particle trajectory via CSS custom properties consumed by
          // the keyframes in index.css.
          ['--cx' as string]: `${dx.toFixed(0)}px`,
          ['--cy' as string]: `${dy.toFixed(0)}px`,
          ['--cr' as string]: `${spin.toFixed(0)}deg`,
        }}
      />
    );
  });

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-visible ${className ?? ''}`}
    >
      {particles}
    </div>
  );
}
