// English for the pages that use 'offers.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enOffers = {
  'offers.title': 'Extra hours offered to you',
  'offers.overtime': '{hours} h of overtime',
  'offers.take': 'Take it',
  'offers.pass': 'Pass',
  'offers.taken': 'It’s yours — it’s on your schedule.',
  'offers.passed': 'Passed. We’ll ask the next person.',
  'offers.error': 'Couldn’t answer that offer.',
} as const;

registerEnglish(enOffers);
