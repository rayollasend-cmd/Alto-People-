// English for the pages that use 'tour.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enTour = {
  'tour.next': 'Next',
  'tour.back': 'Back',
  'tour.done': 'Done',
  'tour.skip': 'Skip',
} as const;

registerEnglish(enTour);
