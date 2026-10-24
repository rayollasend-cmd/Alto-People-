// English for the pages that use 'filters.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enFilters = {
  // FilterBar / FilterSheet — a list's filters behind one chip on a phone
  'filters.title': 'Filters',
  'filters.summary': 'Filters',
  'filters.summaryCount': 'Filters ({count})',
  'filters.description': 'Narrow the list, then close to see it.',
  'filters.clear': 'Clear filters',
  'filters.done': 'Done',
} as const;

registerEnglish(enFilters);
