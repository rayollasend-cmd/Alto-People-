// English for the pages that use 'earned.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enEarned = {
  'earned.title': 'Earned this pay period',
  'earned.estimate': 'Estimates from the hours you\'ve clocked — your paycheck is the official number.',
  'earned.period': '{start} – {end} · paid {pay}',
  'earned.hours': '{hours} worked',
  'earned.dayOf': 'Day {d} of {n}',
  'earned.takeHome': 'About {amount} after taxes',
} as const;

registerEnglish(enEarned);
