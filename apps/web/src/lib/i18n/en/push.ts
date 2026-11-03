// English for the pages that use 'push.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPush = {
  'push.promptTitle': 'Get alerts on this device',
  'push.promptBody': 'Short-staffing alerts, replies from {org} and new messages reach you even when the app is closed.',
  'push.turnOn': 'Turn on',
  'push.notNow': 'Not now',
  'push.on': 'Alerts are on for this device.',
  'push.failed': 'Could not turn on alerts.',
  'push.sheetTitle': 'Know the moment something changes',
  'push.sheetDesc': 'Turn on notifications and we’ll tell you when:',
  'push.sheetShift': 'A shift is added, moved or opens up near you',
  'push.sheetVan': 'Your van is on its way, or running late',
  'push.sheetPay': 'Pay lands, or a request needs your answer',
  'push.sheetQuiet': 'Quiet hours apply here too: unless it’s urgent, nothing buzzes overnight. You can change them in Settings.',
  'push.sheetAllow': 'Turn on notifications',
  'push.sheetOn': 'Notifications are on. You can change them in Settings.',
  'push.sheetDenied': 'Notifications are off. Turn them on any time in your phone’s Settings.',
  'push.sheetFailed': 'Couldn’t turn on notifications. Try again from Settings.',
} as const;

registerEnglish(enPush);
