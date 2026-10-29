// English for the pages that use 'ewa.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enEwa = {
  'ewa.title': 'Pay before payday',
  'ewa.available': 'Available now',
  'ewa.comesOff': 'Comes off your {date} check',
  'ewa.fee': 'Fee {fee} per advance',
  'ewa.noFee': 'No fee',
  'ewa.get': 'Get {amount}',
  'ewa.amountLabel': 'How much?',
  'ewa.upTo': 'Up to {amount}',
  'ewa.sending': 'Sending…',
  'ewa.sent': '{amount} is on its way to your pay account.',
  'ewa.failed': "That didn't go through. Nothing was taken from your pay.",
  'ewa.blockerNoAccount': 'Add a pay account and let payroll verify it first.',
  'ewa.blockerNothing': 'Nothing earned yet this period.',
  'ewa.blockerLimit': "You've drawn what's available this period.",
  'ewa.drawn': '{amount} already drawn this period',
  'ewa.history': 'Past advances',
  'ewa.earned': 'About {net} take-home from {hours} this pay period',
  'ewa.earnedGross': 'You\'ve earned {gross} this pay period on {hours}',
  'ewa.earnedGrossNet': 'You\'ve earned {gross} this pay period on {hours} (about {net} after taxes)',
  'ewa.confirmTitle': 'Get {amount} now?',
  'ewa.confirmAmount': 'Amount',
  'ewa.confirmTo': 'To',
  'ewa.confirmWhen': 'When',
  'ewa.confirmCancel': 'Not now',
  'ewa.toBank': 'Your bank account ····{last4}',
  'ewa.toCard': 'Your pay card ····{last4}',
  'ewa.toAccount': 'Your verified pay account',
  'ewa.whenNow': 'Sent now · comes off your {date} check',
  'ewa.whenNowNext': 'Sent now · comes off your next check',
  'ewa.confirmFee': 'A {fee} fee comes off that check too.',
} as const;

registerEnglish(enEwa);
