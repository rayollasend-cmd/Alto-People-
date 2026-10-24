// English for the pages that use 'lrn.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enLrn = {
  // My training (associate learning view)
  'lrn.myTitle': 'My training',
  'lrn.mySubtitle': 'Courses assigned to you, what is due, and what you have completed.',
  'lrn.crumb': 'Learning',
  'lrn.loadFailed': 'Could not load your training.',
  'lrn.emptyTitle': 'No training assigned',
  'lrn.emptyDesc': 'When HR assigns you a course it shows up here with everything you need.',
  'lrn.toDo': 'To do ({count})',
  'lrn.completed': 'Completed ({count})',
  'lrn.required': 'Required',
  'lrn.expired': 'Expired — renewal needed',
  'lrn.done': 'Completed',
  'lrn.waived': 'Waived',
  'lrn.assignedOn': 'Assigned {date}',
  'lrn.completedOn': 'Completed {date}',
  'lrn.validUntil': 'valid until {date}',
  'lrn.howToComplete': 'Your supervisor or HR runs this training and records your completion.',
} as const;

registerEnglish(enLrn);
