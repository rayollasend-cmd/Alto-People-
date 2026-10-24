// English for the pages that use 'clock.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enClock = {
  'clock.weekEnds': 'Week ends {date}',
  'clock.close': 'Close {date}',
  'clock.payday': 'Payday {date}',
} as const;

registerEnglish(enClock);
