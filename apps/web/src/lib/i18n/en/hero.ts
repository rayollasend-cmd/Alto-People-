// English for the pages that use 'hero.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHero = {
  'hero.label': 'Your shift',
  'hero.late': 'Not clocked in',
  'hero.startedAgo': 'Your shift started {time} ago',
  'hero.lateBody': "You're not clocked in yet — punch in with your clock-in number at the worksite kiosk tablet.",
  'hero.started': 'Started {time}',
  'hero.earnedShift': '{amount} earned this shift',
  'hero.endsAt': 'shift ends {time}',
  'hero.supervisor': 'Shift supervisor',
  'hero.withYouOne': '{count} teammate on with you',
  'hero.withYouMany': '{count} teammates on with you',
  'hero.openOne': '{count} open shift you can pick up.',
  'hero.openMany': '{count} open shifts you can pick up.',
  'hero.pickUp': 'Pick up a shift',
} as const;

registerEnglish(enHero);
