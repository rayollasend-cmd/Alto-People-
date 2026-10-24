// English for the pages that use 'top.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTop = {
  // The top bar (role walk ops 5, floor 10).
  'top.storeScope': 'Store scope',
  'top.all': 'All',
  'top.findClient': 'Find a client',
  'top.noClientMatch': 'No client matches “{q}”',
  'top.currentScope': 'current',
  'top.back': 'Back',
  'top.logo': 'Company logo',
  'top.breadcrumb': 'Breadcrumb',
  'top.palette': 'Open command palette',
  'top.search': 'Search or jump to…',
  'top.reconnecting': 'Reconnecting…',
  'top.offlineSaved': 'Lost connection. Showing what was saved {when} — still trying.',
  'top.offline': 'Lost connection. Trying again.',
  'top.help': 'Help for this page',
  'top.askAssistant': 'Ask {name}',
  'top.account': 'Account menu',
  'top.profile': 'My profile',
  'top.settings': 'Account settings',
  'top.signingOut': 'Signing out…',
  'top.signOut': 'Sign out',
} as const;

registerEnglish(enTop);
