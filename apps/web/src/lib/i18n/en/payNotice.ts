// English for the pages that use 'payNotice.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPayNotice = {
  // State pay notices (NY §195, CA 2810.5, IL, WA) — the worker signs.
  'payNotice.title': 'Pay notices',
  'payNotice.detailSub': '{state} · sent {date}',
  'payNotice.readThenSign': 'Read the notice below, then sign at the end.',
  'payNotice.gone.title': 'This notice isn’t available',
  'payNotice.gone.body': 'It may have been withdrawn or replaced. Your current notices are in the list.',
  'payNotice.subtitle': 'State law requires a written notice of your pay rate and payday. Check it and sign.',
  'payNotice.empty.title': 'No pay notices',
  'payNotice.empty.body': 'When your state requires one, it shows up here for you to sign.',
  'payNotice.status.waiting': 'Needs your signature',
  'payNotice.status.signed': 'Signed {date}',
  'payNotice.pdf': 'Download PDF',
  'payNotice.signLabel': 'Type your full name to sign',
  'payNotice.sign': 'Sign notice',
  'payNotice.signed': 'Thank you. Your signature is saved.',
  'payNotice.signedBy': 'Signed by {name} on {date}',
  'payNotice.error': 'We could not load your pay notice.',
  'payNotice.retry': 'Try again',
  'payNotice.signError': 'We could not save your signature. Try again.',
  'payNotice.back': 'All pay notices',
  'payNotice.englishCopy': 'English copy',
  'payNotice.why.HIRE': 'New job',
  'payNotice.why.RATE_CHANGE': 'New pay rate',
  'payNotice.why.MANUAL': 'From HR',
  'payNotice.ack': 'Signing confirms you received this notice and told your employer your primary language. It does not mean you agree with it.',
} as const;

registerEnglish(enPayNotice);
