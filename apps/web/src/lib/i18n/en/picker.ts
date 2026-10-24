// English for the pages that use 'picker.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPicker = {
  // AssociatePicker — {noun} is the tenant's word for a worker
  'picker.searchNoun': 'Search {noun}…',
  'picker.clearNoun': 'Clear {noun}',
  'picker.searchUnavailable': 'Search unavailable — check your connection and keep typing to retry.',
} as const;

registerEnglish(enPicker);
