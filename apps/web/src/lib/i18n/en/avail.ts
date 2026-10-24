// English for the pages that use 'avail.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enAvail = {
  // Availability presets and the open-shifts empty state (role walk, floor 11)
  'avail.pickTitle': 'Pick when you can work',
  'avail.pickHint': 'We only offer shifts inside these hours. Tap a preset to start, then adjust it.',
  'avail.presetWeekdays': 'Weekdays 9–5',
  'avail.presetWeekends': 'Weekends',
  'avail.presetNights': 'Nights 4p–11p',
  'avail.presetAny': 'Any time',
  // Availability editor (associate app, all six languages).
  'avail.loadFailed': 'Failed to load availability.',
  'avail.endAfterStart': 'End time must be after start time.',
  'avail.saved': 'Saved.',
  'avail.saveFailed': 'Save failed.',
  'avail.title': 'My availability',
  'avail.usedBy': 'Used by HR to suggest you for open shifts',
  'avail.remove': 'Remove',
  'avail.addWindow': '+ Add window',
  'avail.saving': 'Saving…',
  'avail.save': 'Save',
  'avail.retry': 'Retry',
  'avail.daysOffLoadFailed': 'Failed to load days off.',
  'avail.dayOffAddFailed': 'Could not add that day.',
  'avail.dayOffRemoveFailed': 'Could not remove that day.',
  'avail.daysOffTitle': 'Days off (one-time)',
  'avail.removeDayOff': 'Remove day off {date}',
  'avail.noDaysOff': "No upcoming days off. Add a date you can't work and it blocks swap offers, pickups, and auto-scheduling for that day.",
  'avail.timeOffPointer': 'Need a day off for a vacation or a sick day?',
  'avail.timeOffLink': 'Request time off',
  'avail.dayOffDate': 'Day off date',
  'avail.reasonOptional': 'Reason (optional)',
  'avail.dayOffReason': 'Day off reason',
  'avail.addDayOff': 'Add day off',
} as const;

registerEnglish(enAvail);
