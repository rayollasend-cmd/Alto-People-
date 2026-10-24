// English for the pages that use 'next14.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enNext14 = {
  'next14.none': 'No shifts in the next 14 days.',
  'next14.seeOpen': 'See open shifts →',
  'next14.title': 'Next 14 days',
  'next14.aria': 'Your shifts over the next 14 days',
} as const;

registerEnglish(enNext14);
