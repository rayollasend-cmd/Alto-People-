// English for the pages that use 'schedHome.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enSchedHome = {
  'schedHome.title': 'Scheduling',
  'schedHome.subManage': 'Plan shifts, assign {workersLc}, and track fill status.',
  'schedHome.subReadOnly': 'Read-only view of scheduled shifts.',
  'schedHome.export': 'Export',
  'schedHome.printView': 'Print this view',
  'schedHome.downloadCsv': 'Download CSV',
  'schedHome.schedule': 'Schedule',
  'schedHome.noMatch': 'No shifts match this filter',
  'schedHome.noMatchManage': 'Try a different filter, or create a new shift to start staffing.',
  'schedHome.noMatchRead': 'Try a different filter to see other shifts.',
} as const;

registerEnglish(enSchedHome);
