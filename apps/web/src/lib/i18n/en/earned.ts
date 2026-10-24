// English for the pages that use 'earned.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enEarned = {
  'earned.title': 'Earned this pay period',
  'earned.estimate': 'An estimate before taxes, from the hours you\'ve clocked.',
  'earned.period': '{start} – {end} · paid {pay}',
  'earned.hours': '{hours} worked',
  'earned.dayOf': 'Day {d} of {n}',
} as const;

registerEnglish(enEarned);
