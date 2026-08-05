/**
 * Guards the tailwind-merge custom font-size registration in lib/cn.ts.
 *
 * tailwind-merge classifies unknown `text-*` utilities by shape: t-shirt
 * sizes are font sizes, everything else is a colour. `text-xs2`, `text-hero`
 * and `text-hero-lg` don't match that pattern, so without the explicit
 * registration they get grouped with text COLOURS and are deleted whenever a
 * colour follows them in the same cn() call.
 *
 * That failure is silent and invisible in source (the colour is usually a
 * runtime variable), and it shipped: the dashboard delta chip rendered at
 * 16px instead of 12px and overflowed its card by 19px. These tests exist
 * because nothing else would catch a regression here.
 */
import { describe, expect, it } from 'vitest';
import { cn } from '../../lib/cn';

describe('cn — custom font sizes survive alongside colours', () => {
  it.each(['3xs', '2xs', 'xs2', 'hero', 'hero-lg'])(
    'keeps text-%s when a colour follows it',
    (size) => {
      expect(cn(`text-${size}`, 'text-silver')).toContain(`text-${size}`);
      expect(cn(`text-${size}`, 'text-silver')).toContain('text-silver');
    },
  );

  it('keeps the size when the colour is a runtime value (the shipped bug)', () => {
    const tone = 'text-alert';
    const out = cn('text-xs2 tabular-nums whitespace-nowrap', tone);
    expect(out).toContain('text-xs2');
    expect(out).toContain('text-alert');
  });

  it('keeps custom sizes against fractional-opacity colours', () => {
    expect(cn('text-xs2 uppercase', 'text-silver/70')).toContain('text-xs2');
  });
});

describe('cn — genuine conflicts still collapse', () => {
  it('still de-duplicates ordinary utilities', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('resolves size-vs-size to the last one', () => {
    expect(cn('text-xs2', 'text-hero')).toBe('text-hero');
    expect(cn('text-xs', 'text-sm')).toBe('text-sm');
    // custom and built-in sizes share the group, so they must conflict too
    expect(cn('text-xs2', 'text-sm')).toBe('text-sm');
  });

  it('resolves colour-vs-colour to the last one', () => {
    expect(cn('text-silver', 'text-gold')).toBe('text-gold');
  });
});
