// English for the pages that use 'decisions.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';
// Its Spanish travels with it, in the same chunk (es/decisions.ts).
import '../es/decisions';

export const enDecisions = {
  // Staff homes (Inbox, Recruiter, Manager, Admin, Executive, Payroll, Scheduling) — the staff slice is EN/ES/TR.
  'decisions.title': 'Inbox',
  'decisions.subtitle': 'Every decision waiting on you, in one place.',
  'decisions.loadWhat': 'your inbox',
  'decisions.emptyTitle': 'Nothing is waiting on you.',
  'decisions.emptyBody': 'When a decision needs you — an approval, a review, a ruling — it shows up here.',
  'decisions.waitingAria': 'Decisions waiting on you',
  'decisions.allClear': 'All clear',
  'decisions.allClearBody': 'Queues you can act on that are empty right now.',
  'decisions.quietAria': 'Queues with nothing waiting',
  'decisions.nWaiting': '{n} waiting',
  'decisions.open': 'Open',
  'decisions.openX': 'Open {label}',
  'decisions.backToInbox': 'Back to inbox',
  'decisions.leftHere': '{label}: {n} left',
  'decisions.queueDone': '{label} — done.',
  'decisions.next': 'Next: {label} ({n})',
  'decisions.inboxClear': 'Your inbox is clear.',
  'decisions.hideReturn': 'Hide',
  // The decision queue, who isn't in yet, text the crew (floor screens: English and Spanish).
  // The Inbox's "Also watching": company-wide queues another desk owns (F500 SH-4; packages/shared queues.ts).
  'decisions.watchingFold': 'Also watching · {n}',
  'decisions.watchingBody': 'Another desk owns these. They don’t count toward your badge.',
  // Inbox, ranked by what it costs to be late (role walk HR 4, ops 20).
  'decisions.bandLegal': 'Legal deadlines',
  'decisions.bandMoney': 'Money',
  'decisions.bandRoutine': 'Routine',
  'decisions.bandQueues': '{count} queues',
  'decisions.bandQueues_one': '{count} queue',
  'decisions.bandItems': '{count} items',
  'decisions.bandItems_one': '{count} item',
  'decisions.nextDue': 'Next due {date}',
  'decisions.overdue': 'Overdue · {date}',
  'decisions.quietFold': '{n} queues clear',
  'decisions.quietFoldOne': '1 queue clear',
  'decisions.subtitleN': '{count} items waiting on you, in one place.',
  'decisions.subtitleN_one': '1 item waiting on you.',
  'decisions.unreadNotices': '{count} unread notifications — read them in Notifications',
  'decisions.unreadNotices_one': '1 unread notification — read it in Notifications',
} as const;

registerEnglish(enDecisions);
