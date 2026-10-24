// English for the pages that use 'header.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enHeader = {
  // PageHeader — the action row and the related links
  'header.more': 'More',
  'header.moreActions': 'More actions',
  'header.moreActionsHint': 'The rest of this page’s actions.',
  'header.related': 'Related',
} as const;

registerEnglish(enHeader);
