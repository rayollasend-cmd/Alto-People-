// English for the pages that use 'help.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHelp = {
  // Contextual help sheet and coach marks
  'help.title': 'Help for this page',
  'help.generic': 'Help',
  'help.genericIntro': 'Search from the top bar, press ? for keyboard shortcuts, and find the manual in the help center.',
  'help.youCan': 'You can',
  'help.related': 'From the help center',
  'help.noArticles': 'No articles on this yet.',
  'help.openCenter': 'Open the help center',
  'help.shortcuts': 'Keyboard shortcuts',
  'help.whatsNew': "What's new",
  'help.contactSupport': 'Contact Alto People support',
  'help.replayTour': 'Show the tour again',
} as const;

registerEnglish(enHelp);
