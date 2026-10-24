// English for the pages that use 'breakq.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enBreakq = {
  'breakq.title': 'Before you clock out',
  'breakq.why': 'The law here requires breaks. If you didn’t get one, say so — it’s put right on your pay.',
  'breakq.meal': 'Did you get your meal break today?',
  'breakq.mealYes': 'Yes',
  'breakq.mealNo': 'No',
  'breakq.mealWaived': 'I chose to skip it',
  'breakq.rest': 'Did you get your rest breaks?',
  'breakq.note': 'Anything to add? (optional)',
  'breakq.submit': 'Clock out',
} as const;

registerEnglish(enBreakq);
