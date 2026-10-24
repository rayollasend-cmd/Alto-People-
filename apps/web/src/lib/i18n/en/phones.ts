// English for the pages that use 'phones.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPhones = {
  'phones.title': 'Phones with the app',
  'phones.desc': 'Where you’re signed in to the Alto People app. Remove a phone you no longer use — it stops getting notifications and signs out.',
  'phones.thisPhone': 'This phone',
  'phones.notifications': 'Notifications',
  'phones.notifOn': 'On — shift changes, rides, approvals and pay.',
  'phones.notifOff': 'Off. Turn them on to hear about shift changes the moment they happen.',
  'phones.notifDenied': 'Turned off in your phone’s Settings. Open Settings → Alto People → Notifications to turn them on.',
  'phones.turnOn': 'Turn on',
  'phones.pushOn': 'Notifications are on.',
  'phones.pushFailed': 'Couldn’t turn on notifications. Try again in a moment.',
  'phones.lockLabel': 'Require {method} to open the app',
  'phones.lockHint': 'When you open the app, and after a minute away. You stay signed in.',
  'phones.lockConfirm': 'Confirm {method} for Alto People',
  'phones.lockOn': '{method} now opens the app.',
  'phones.lockOff': 'The app opens without a lock.',
  'phones.removeTitle': 'Remove this phone?',
  'phones.removeThisTitle': 'Remove the phone you’re using?',
  'phones.removeBody': 'It stops getting notifications and forgets its saved sign-in. You can sign in on it again any time.',
  'phones.remove': 'Remove',
  'phones.removed': 'Phone removed.',
  'phones.removeFailed': 'Couldn’t remove that phone. Try again.',
  'phones.loadFailed': 'We couldn’t load your phones.',
  'phones.empty': 'You haven’t signed in to the app on a phone yet. Download Alto People on your iPhone or Android phone and sign in.',
  'phones.current': 'This phone',
  'phones.lastUsed': 'Last used {date}',
  'phones.rowNotifOn': 'notifications on',
  'phones.rowNotifOff': 'notifications off',
  'phones.appVersion': 'app {version}',
} as const;

registerEnglish(enPhones);
