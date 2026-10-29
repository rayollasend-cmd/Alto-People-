// English for the pages that use 'schedHome.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';
// Its Spanish travels with it, in the same chunk (es/schedHome.ts).
import '../es/schedHome';

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
  'schedHome.sheetEnded': 'Ended',
  'schedHome.sheetCheckingPunch': 'Checking their punches…',
  'schedHome.sheetPunchUnknown': 'Couldn’t read their punches',
  'schedHome.sheetWorked': 'Worked {span}',
  'schedHome.sheetNoPunch': 'No punch on record',
  'schedHome.sheetWentUnfilled': 'Went unfilled',
  'schedHome.sheetCancelled': 'Cancelled',
  'schedHome.sheetViewTime': 'View their time',
  'schedHome.sheetCloseOut': 'Close out',
  'schedHome.sheetEdit': 'Edit',
  'schedHome.sheetAssign': 'Assign',
  'schedHome.sheetReassign': 'Reassign',
  'schedHome.sheetUnassign': 'Unassign',
  'schedHome.sheetPublish': 'Publish',
  'schedHome.sheetToDraft': 'Move to draft',
  'schedHome.sheetDuplicate': 'Duplicate',
  'schedHome.sheetCopyNextWeek': 'Copy to next week',
  'schedHome.sheetCancelShift': 'Cancel shift',
  'schedHome.sheetDelete': 'Delete',
  'schedHome.riskShowing': 'Showing the {count} shifts held by high-risk attendees (no-shows, call-outs or late arrivals in the last 90 days).',
  'schedHome.riskShowingOne': 'Showing the 1 shift held by a high-risk attendee (no-shows, call-outs or late arrivals in the last 90 days).',
  'schedHome.riskNone': 'None of these shifts is held by a high-risk attendee right now.',
  'schedHome.riskLoading': 'Finding the shifts held by high-risk attendees…',
  'schedHome.riskFailed': 'Couldn’t load the high-risk list — showing every shift.',
  'schedHome.riskShowAll': 'Show all shifts',
} as const;

registerEnglish(enSchedHome);
