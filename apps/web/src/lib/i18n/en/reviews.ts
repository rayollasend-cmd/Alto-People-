// English for the pages that use 'reviews.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enReviews = {
  // Associate performance reviews
  'reviews.title': 'My reviews',
  'reviews.subtitle': 'Performance reviews from your manager.',
  'reviews.loadFailed': 'Could not load your reviews.',
  'reviews.emptyTitle': 'No reviews yet',
  'reviews.emptyDesc':
    "When your manager submits a performance review, it'll appear here for you to read and acknowledge.",
  'reviews.status.DRAFT': 'Draft',
  'reviews.status.SUBMITTED': 'Shared with you',
  'reviews.status.ACKNOWLEDGED': 'Acknowledged',
  'reviews.strengths': 'Strengths',
  'reviews.improvements': 'Areas for improvement',
  'reviews.goals': 'Goals',
  'reviews.ackTitle': 'Acknowledge this review?',
  'reviews.ackDesc':
    "Acknowledging confirms you've read this review — it doesn't mean you agree with it.",
  'reviews.ack': 'Acknowledge',
  'reviews.ackSaving': 'Saving…',
  'reviews.ackFailed': 'Could not record your acknowledgment.',
  'reviews.reviewedBy': 'Reviewed by {email}',
} as const;

registerEnglish(enReviews);
