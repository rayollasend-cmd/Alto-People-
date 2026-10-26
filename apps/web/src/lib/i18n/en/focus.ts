// English for the pages that use 'focus.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enFocus = {
  'focus.aria': 'Show my shift or the whole store',
  'focus.myShift': 'My shift',
  'focus.wholeStore': 'Whole store',
  'focus.startsAt': '{label} starts at {time} · {count} scheduled.',
  'focus.nothingToday': 'Nothing on your shift today.',
  'focus.band': 'Your shift',
  'focus.windowTargetOf': 'the {label} target',
  'focus.startsAtNone': '{label} starts at {time} · nothing scheduled yet.',
} as const;

registerEnglish(enFocus);
