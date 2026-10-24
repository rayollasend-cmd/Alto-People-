// English for the pages that use 'cal.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enCal = {
  // Week/month calendar views — the last associate surface that was
  // still hardcoded English.
  'cal.prevWeek': 'Previous week',
  'cal.nextWeek': 'Next week',
  'cal.prevMonth': 'Previous month',
  'cal.nextMonth': 'Next month',
  'cal.today': 'Today',
  'cal.scheduled': '{hours} scheduled',
  'cal.unavailable': 'Unavailable',
  'cal.dayOff': 'Day off',
  'cal.noShifts': 'No shifts',
  'cal.beforeHistory': "You're looking before the loaded history.",
  'cal.beforeRecorded': "That's before your recorded shift history.",
  'cal.pickDay': 'Pick a day to see its shifts.',
  'cal.noShiftsMonth': 'No shifts this month.',
  'cal.noShiftsDay': 'No shifts on this day.',
  'cal.markedUnavailable': "You've marked this day as unavailable.",
} as const;

registerEnglish(enCal);
