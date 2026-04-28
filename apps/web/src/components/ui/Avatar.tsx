import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Phase 72 — Avatar primitive.
 *
 * Inputs (any subset):
 *   - src:    image URL; falls back to initials if missing/broken
 *   - name:   "Jane Doe" → "JD"
 *   - email:  "jane.doe@..." → "JD" (split on . _ -)
 *
 * The background color is derived from a deterministic hash of name|email
 * so the same person gets the same color across the app. The palette is
 * gold-accented to match Alto's tokens; white text reads on every entry.
 */

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: 'h-6 w-6 text-[9px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
};

// Six dim-saturated tints that all sit on AA-contrast white text.
const PALETTE = [
  'bg-[#3a4a73]', // navy-tinted
  'bg-[#4a3a73]', // plum
  'bg-[#73513a]', // copper
  'bg-[#3a7363]', // teal
  'bg-[#73703a]', // olive-gold
  'bg-[#73415a]', // mauve
];

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  email?: string | null;
  size?: AvatarSize;
  className?: string;
  /** When true, the avatar gets a soft ring matching the theme. */
  ringed?: boolean;
}

export function Avatar({
  src,
  name,
  email,
  size = 'md',
  className,
  ringed,
}: AvatarProps) {
  const [broken, setBroken] = React.useState(false);
  // When the image src changes (e.g. user uploads a new photo, cache-buster
  // bumps the ?v= param), retry — clear the prior broken flag so we don't
  // show initials for a now-valid URL.
  React.useEffect(() => {
    setBroken(false);
  }, [src]);
  const seed = (name ?? email ?? '?').trim();
  const text = initialsFor(seed);
  const color = PALETTE[hash(seed) % PALETTE.length];

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium text-white select-none',
        SIZE_CLASS[size],
        ringed && 'ring-2 ring-navy ring-offset-0',
        // Background only shown when the image isn't covering it.
        (!src || broken) && color,
        className
      )}
      aria-hidden="true"
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
          draggable={false}
        />
      ) : (
        <span className="tracking-wide">{text}</span>
      )}
    </span>
  );
}

function initialsFor(seed: string): string {
  if (!seed) return '?';
  // Email shape — strip domain.
  const local = seed.includes('@') ? (seed.split('@')[0] ?? '') : seed;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  return seed.slice(0, 2).toUpperCase();
}

// FNV-1a 32-bit, plenty stable + fast for palette indexing.
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}
