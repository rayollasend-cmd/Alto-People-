import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge has to be taught this project's custom font sizes.
 *
 * It classifies an unrecognised `text-*` utility by shape: anything matching
 * its t-shirt-size pattern is a FONT SIZE, everything else is a TEXT COLOUR.
 * `text-2xs` and `text-3xs` match. `text-xs2`, `text-hero` and `text-hero-lg`
 * do not — so they were filed as colours, landed in the same conflict group
 * as `text-silver`/`text-gold`/…, and were silently DELETED whenever a real
 * colour followed them in the same cn() call:
 *
 *   twMerge('text-xs2 tabular-nums text-silver')
 *     -> 'tabular-nums text-silver'      // size gone, element inherits 16px
 *
 * Not hypothetical: the dashboard delta chip (`cn('text-xs2 …', tone)`)
 * rendered at 16px instead of 12px and overflowed its card by 19px. Only ~7
 * sites route these sizes through cn(), but the failure is invisible in
 * source — the colour is usually a runtime variable — so it is fixed at the
 * merger rather than at the call sites.
 *
 * Registering them under `font-size` keeps genuine conflicts working: two
 * sizes still collapse to the last, two colours still collapse to the last.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['3xs', '2xs', 'xs2', 'hero', 'hero-lg'] }],
    },
  },
});

/**
 * Merge Tailwind classes with proper precedence. Drop-in compatible with
 * the original signature (string | false | null | undefined) but also
 * accepts arrays/objects via clsx, and de-conflicts overlapping utility
 * classes via tailwind-merge (so "px-2 px-4" → "px-4", not both).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
