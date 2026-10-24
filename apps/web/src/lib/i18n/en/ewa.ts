// English for the pages that use 'ewa.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enEwa = {
  'ewa.title': 'Pay before payday',
  'ewa.available': 'Available now',
  'ewa.earned': "You've earned about {net} on {hours} this period",
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
} as const;

registerEnglish(enEwa);
