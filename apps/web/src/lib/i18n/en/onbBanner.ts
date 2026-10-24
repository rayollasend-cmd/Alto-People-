// English for the pages that use 'onbBanner.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enOnbBanner = {
  'onbBanner.cta': 'Continue',
  'onbBanner.next': 'Next: {task} · about {n} min',
  'onbBanner.tasksOf': '{done} of {total} tasks',
  'onbBanner.continue': 'Continue onboarding',
  'onbBanner.welcome': 'Welcome — let’s get you set up',
  'onbBanner.finish': 'Finish your onboarding',
  'onbBanner.percent': '{n}% complete',
  'onbBanner.freshBody': 'Your onboarding tasks for {client} are ready. Most associates finish in about 15 minutes.',
  'onbBanner.resumeBody': 'Pick up where you left off — {client}.',
} as const;

registerEnglish(enOnbBanner);
