// English for the pages that use 'handoff.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHandoff = {
  'handoff.title': 'Returning you to Alto People',
  'handoff.body': 'You’re signed in. The app opens in a moment.',
  'handoff.open': 'Open the app',
  'handoff.failedTitle': 'We couldn’t finish signing you in',
  'handoff.failedBody': 'Sign in again and the app opens when you’re done.',
  'handoff.signInAgain': 'Sign in again',
} as const;

registerEnglish(enHandoff);
