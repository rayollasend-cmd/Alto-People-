// English for the pages that use 'push.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPush = {
  'push.promptTitle': 'Get alerts on this device',
  'push.promptBody': 'Short-staffing alerts, replies from {org} and new messages reach you even when the app is closed.',
  'push.turnOn': 'Turn on',
  'push.notNow': 'Not now',
  'push.on': 'Alerts are on for this device.',
  'push.failed': 'Could not turn on alerts.',
} as const;

registerEnglish(enPush);
