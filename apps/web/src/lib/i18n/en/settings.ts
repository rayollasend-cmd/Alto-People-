// English for the pages that use 'settings.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enSettings = {
  'settings.sec.nav': 'Settings sections',
  'settings.sec.profile': 'Profile',
  'settings.sec.notifications': 'Notifications',
  'settings.sec.security': 'Security',
  'settings.sec.devices': 'Devices & sessions',
  'settings.sec.data': 'Your data',
  'settings.sec.show': 'Show',
  'settings.sec.hide': 'Hide',
  // WhatsApp updates (Brief 1C-4)
  'settings.whatsapp.title': 'WhatsApp updates',
  'settings.whatsapp.comingSoon': 'WhatsApp updates are coming soon.',
  'settings.whatsapp.onSince': 'On for {phone} since {date}.',
  'settings.whatsapp.turnOff': 'Turn off',
  'settings.whatsapp.turnOn': 'Turn on',
  'settings.whatsapp.phoneLabel': 'Mobile number with WhatsApp',
  'settings.whatsapp.consent': 'I agree to receive Alto People messages on WhatsApp at this number. Message and data rates may apply. Reply STOP any time.',
  'settings.whatsapp.languageNote': 'Messages arrive in your language (Settings → Language).',
  'settings.whatsapp.optedOutDone': 'WhatsApp updates are off.',
  'settings.whatsapp.optedInDone': 'WhatsApp updates are on.',
} as const;

registerEnglish(enSettings);
