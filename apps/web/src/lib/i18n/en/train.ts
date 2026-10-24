// English for the pages that use 'train.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTrain = {
  'train.dueTitle': 'Training before your next shift',
  'train.dueBody': '{title} is required and not complete yet.',
  'train.expiring': '{title} expires {date}.',
  'train.open': 'Open my training',
} as const;

registerEnglish(enTrain);
