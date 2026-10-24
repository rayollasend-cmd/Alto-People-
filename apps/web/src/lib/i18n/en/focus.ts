// English for the pages that use 'focus.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enFocus = {
  'focus.aria': 'Show my shift or the whole store',
  'focus.myShift': 'My shift',
  'focus.wholeStore': 'Whole store',
  'focus.windowTarget': "{label}'s target",
  'focus.startsAt': '{label} starts at {time} · {count} scheduled.',
  'focus.nothingToday': 'Nothing on your shift today.',
  'focus.band': 'Your shift',
} as const;

registerEnglish(enFocus);
