// English for the pages that use 'grid.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enGrid = {
  // DataGrid — the one list primitive; every grid shares these
  'grid.rowsOne': '{count} row',
  'grid.rowsMany': '{count} rows',
  'grid.count': '{count} {noun}',
  'grid.countOf': '{count} of {total}',
  'grid.countOfNoun': '{count} of {total} {noun}',
  'grid.searchAria': 'Search {caption}',
  'grid.keysAria': '{caption} — j and k move, x selects',
  'grid.cursorAt': 'Row {n} of {total}: {label}',
  'grid.chooseColumns': 'Choose columns',
  'grid.exportAria': 'Export {caption} as CSV — what is on screen',
  'grid.exportTitle': 'Exports the visible columns, in the current order',
  'grid.bulkActions': 'Bulk actions',
  'grid.selected': '{count} selected',
  'grid.loadingAria': 'Loading {caption}',
  'grid.emptyNoun': 'No {noun} yet',
  'grid.noMatchTitle': 'Nothing matches',
  'grid.noMatchDesc': 'Try fewer words, or clear the search.',
  'grid.clearSearch': 'Clear search',
  'grid.noFilterMatchTitle': 'Nothing matches these filters',
  'grid.noFilterMatchDesc': 'Clear the filters to see everything.',
  'grid.clearFilters': 'Clear filters',
  'grid.countPage': '{total} · {from}–{to} shown',
  'grid.countLoaded': '{count} of {loaded} loaded',
  'grid.moreAria': 'More options for {caption}',
  'grid.exportCsv': 'Export CSV',
} as const;

registerEnglish(enGrid);
