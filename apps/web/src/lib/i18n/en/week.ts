// English for the pages that use 'week.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enWeek = {
  'week.title': 'Your week',
  'week.daysOne': '{count} day on',
  'week.daysMany': '{count} days on',
  'week.off': 'Off',
  'week.toGo': '{hours} to go',
  'week.notPunched': '{hours} scheduled, not punched',
  'week.allWorked': 'All scheduled hours worked',
  'week.scheduledShort': 'scheduled',
  'week.overtime': '{hours} of overtime this week',
  'week.headingOver': 'Your schedule adds up to {hours} of overtime this week',
  'week.needsConfirm': 'Needs your confirm',
} as const;

registerEnglish(enWeek);
