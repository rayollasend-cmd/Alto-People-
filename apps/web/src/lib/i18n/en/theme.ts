// English for the pages that use 'theme.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTheme = {
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',
} as const;

registerEnglish(enTheme);
