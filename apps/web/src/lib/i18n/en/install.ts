// English for the pages that use 'install.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enInstall = {
  'install.region': 'Install Alto',
  'install.title': 'Install Alto',
  'install.titleLong': 'Install Alto on this device',
  'install.tap': 'Tap',
  'install.share': 'Share',
  'install.then': 'then',
  'install.addToHome': 'Add to Home Screen',
  'install.iosPush': 'Installing is also what lets Alto send you notifications on iPhone and iPad.',
  'install.body': 'Opens like an app, with an offline shell.',
  'install.install': 'Install',
  'install.notNow': 'Not now',
  'install.dismiss': 'Dismiss',
  'install.asApp': 'Install Alto People as an app',
  'install.app': 'Install app',
} as const;

registerEnglish(enInstall);
