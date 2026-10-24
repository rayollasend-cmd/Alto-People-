// English for the pages that use 'tile.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTile = {
  'tile.thisWeek': 'This week',
  'tile.shiftsOne': '{count} shift scheduled',
  'tile.shiftsMany': '{count} shifts scheduled',
  'tile.noShifts': 'No shifts this week',
  'tile.lastPay': 'Last paycheck',
  'tile.noPayYet': 'Your first shows up after payroll runs',
  'tile.paidOn': 'Paid {date}',
  'tile.timeOff': 'Time off',
  'tile.accrues': 'Sick hours accrue as you work',
  'tile.openShifts': 'Open shifts',
  'tile.openSome': 'Ready to pick up',
  'tile.openNone': 'None right now',
  'tile.nextPayday': 'Next payday {date}',
} as const;

registerEnglish(enTile);
