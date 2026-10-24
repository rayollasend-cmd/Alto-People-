// English for the pages that use 'lane.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enLane = {
  'lane.title': 'Road to your first paycheck',
  'lane.approved': 'Application approved',
  'lane.scheduled': 'First shift scheduled',
  'lane.fieldglass': 'Payroll setup',
  'lane.firstShift': 'First shift worked',
  'lane.hoursApproved': 'Hours approved',
  'lane.paycheck': 'First paycheck',
  'lane.inProgress': 'In progress',
  'lane.expected': 'Expected by {date}',
  'lane.late': 'Taking a little longer than planned — we’re on it.',
  'lane.kept': 'Your first paycheck has landed. Welcome to Alto.',
} as const;

registerEnglish(enLane);
