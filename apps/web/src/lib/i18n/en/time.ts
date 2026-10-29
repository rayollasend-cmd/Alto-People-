// English for the pages that use 'time.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTime = {
  // Time: the person's own view, and the tablet-only note for floor leads.
  'time.myTime': 'My time',
  'time.tabletOnlyBody':
    'As a {role}, you clock in and out at the {siteLc} tablet with your clock-in number — not in the app. Your punches land here.',
  'time.tabletClockHint': 'Punch in and out at the {siteLc} tablet with your clock-in number.',
  // Time & attendance — associate kiosk-only explainer
  'time.title': 'Time & attendance',
  'time.subtitle': 'Clock in at the worksite kiosk.',
  'time.kioskHeading': 'Use the time-clock tablet at your worksite',
  'time.howPunching': 'How punching works',
  'time.kioskBody':
    "Hourly {workersLc} clock in and out using the kiosk tablet installed at your site, not from a personal phone. Tap your 4-digit clock-in number, take the selfie, and you're punched in. Ask your manager if you don't know your clock-in number yet.",
  'time.myTimesheet': 'My timesheet',
  'time.myTimesheetDesc':
    'Every kiosk punch with your hours and approval status.',
  'time.approvedTotal': '{hours} approved',
  'time.pendingTotal': '{hours} pending review',
  'time.stillOn': 'still on the clock',
  'time.breakMinutes': '{minutes} break',
  'time.thisPeriod': 'This period',
  'time.custom': 'Custom',
  'time.heroLineGross': '{hours} approved — estimated gross, before taxes',
  'time.heroLineHours': 'Approved this period',
  'time.heroPending': '{hours} awaiting review',
  'time.noEntries': 'No punches in this range',
  'time.noEntriesDesc':
    'Punches from the worksite kiosk will show up here the moment you clock in.',
  'time.loadFailed': 'Could not load your timesheet.',
  'time.status.ACTIVE': 'On the clock',
  'time.status.COMPLETED': 'Pending review',
  'time.status.APPROVED': 'Approved',
  'time.status.REJECTED': 'Rejected',
  'time.lastWeek': 'Last week',
  'time.last14': 'Last 14 days',
  'time.rangeAria': 'Quick date ranges',
  'time.weekOf': 'Week of {date}',
  'time.weekOvertime': 'includes {hours} overtime',
  'time.weekDoubleTime': 'and {hours} double time',
  'time.scheduled': 'Scheduled {range}',
  'time.grossEstimate': '≈ {amount} gross (approved)',
  'time.grossLabel': '≈ Est. gross',
  'time.grossDisclaimer':
    'Estimate before taxes and deductions — not a pay statement.',
  'time.reportIssue': 'Report an issue',
  'time.reportIssueDesc':
    "Tell HR what looks wrong with this entry. The date and punch times are attached automatically, and you can track the case under HR cases.",
  'time.whatsWrong': 'What looks wrong?',
  'time.reportPlaceholder': 'e.g. I clocked out at 5:00, not 4:30',
  'time.send': 'Send to HR',
  'time.reportSent': 'Sent — HR will follow up.',
  'time.reportFailed': 'Could not send',
  'time.payPeriodChip': 'This pay period',
  'time.heroPayPeriod': 'This pay period · {range}',
  'time.heroLineWorked': '{hours} worked — estimated gross, before taxes',
  'time.whatPunches': 'your punches',
} as const;

registerEnglish(enTime);
