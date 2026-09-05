import type { CSSProperties } from 'react';

/**
 * Stagger for `animate-enter` list rows: each row waits index × 30ms, capped
 * so long lists don't make the tail wait — after the cap everything lands
 * together. The 'both' fill on the keyframe keeps delayed rows invisible
 * until their turn. Flattened globally under prefers-reduced-motion.
 */
export function enterStagger(index: number, stepMs = 30, cap = 8): CSSProperties {
  return { animationDelay: `${Math.min(index, cap) * stepMs}ms` };
}
