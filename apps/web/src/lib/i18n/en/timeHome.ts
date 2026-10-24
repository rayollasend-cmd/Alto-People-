// English for the pages that use 'timeHome.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTimeHome = {
  'timeHome.theFloor': 'The floor',
  'timeHome.ownClockAria': 'Your own clock',
  'timeHome.yourClock': 'Your clock',
  'timeHome.onClockSince': 'On the clock since {time}',
  'timeHome.notClockedIn': 'Not clocked in',
  'timeHome.clockNotSetUp': 'Your clock is not set up yet',
  'timeHome.clockNotSetUpBody': 'Clocking in from the app needs your person record in People under this email: {email}. Ask HR to add it or fix the email; your clock appears here the next time you sign in.',
} as const;

registerEnglish(enTimeHome);
