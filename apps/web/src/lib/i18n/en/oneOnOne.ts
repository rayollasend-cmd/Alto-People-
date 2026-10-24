// English for the pages that use 'oneOnOne.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enOneOnOne = {
  'oneOnOne.title': 'Your 1:1',
  'oneOnOne.next': 'Next 1:1 · {when}',
  'oneOnOne.with': 'with {who}',
  'oneOnOne.repeats': 'Repeats {cadence}',
  'oneOnOne.weekly': 'weekly',
  'oneOnOne.biweekly': 'every two weeks',
  'oneOnOne.agenda': 'Agenda',
  'oneOnOne.agendaHint': 'Add what you want to talk about — your manager sees it too.',
  'oneOnOne.agendaPlaceholder': 'Topics to cover…',
  'oneOnOne.saveAgenda': 'Save agenda',
  'oneOnOne.saved': 'Agenda saved.',
  'oneOnOne.saveFailed': 'Could not save the agenda.',
  'oneOnOne.yourItems': 'Yours to do',
  'oneOnOne.managerItems': 'Your manager’s to do',
} as const;

registerEnglish(enOneOnOne);
