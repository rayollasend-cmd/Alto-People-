import { afterEach, describe, expect, it } from 'vitest';
import { tokenColor, tokenVar } from '@/lib/tokenColor';

/**
 * The live map's colours come from the design tokens (design-lint hex
 * sweep): MapLibre needs a concrete colour, so the bridge reads the
 * token off <html> and falls back to the dark theme's value when the
 * stylesheet isn't there.
 */
describe('tokenColor', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--color-gold-fill');
    document.documentElement.style.removeProperty('--color-silver');
  });

  it('resolves the token the page defines, in the comma form MapLibre parses', () => {
    document.documentElement.style.setProperty('--color-gold-fill', '184  134  11');
    expect(tokenColor('gold-fill')).toBe('rgb(184, 134, 11)');
    expect(tokenColor('gold-fill', 0.35)).toBe('rgba(184, 134, 11, 0.35)');
  });

  it('falls back to the dark theme value when the token is missing or malformed', () => {
    expect(tokenColor('gold-fill')).toBe('rgb(217, 185, 103)');
    document.documentElement.style.setProperty('--color-silver', 'var(--nope)');
    expect(tokenColor('silver')).toBe('rgb(192, 208, 224)');
  });

  it('keeps the live variable for hand-painted HTML', () => {
    expect(tokenVar('on-accent')).toBe('rgb(var(--color-on-accent))');
    expect(tokenVar('gold-fill', 0.35)).toBe('rgb(var(--color-gold-fill) / 0.35)');
  });
});
