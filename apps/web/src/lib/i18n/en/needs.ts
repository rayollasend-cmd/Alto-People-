// English for the pages that use 'needs.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enNeeds = {
  // Field roles (2026-10) — the associate's counted "Needs you", training in the flow of work, the credential wallet.
  'needs.my-agreements': 'Agreements to sign',
  'needs.my-documents': 'Documents needing attention',
  'needs.my-shifts': 'Shifts to confirm',
  'needs.my-training': 'Training due',
  'needs.my-notifications': 'Unread in your inbox',
  'needs.messages': 'Unread messages',
  'needs.my-onboarding': 'Finish onboarding',
  'needs.my-leave-certification': 'Upload leave certification',
  'needs.my-pay-notices': 'Sign your pay notice',
  'needs.my-punch-fixes': 'Fix a punch',
  'needs.my-ot-offers': 'Extra hours offered to you',
  'needs.progress': '{done} of {total} done',
  'needs.dueOn': 'Due {date}',
  'needs.go': 'Open',
  'needs.unreadNotices': '{n} unread notices',
} as const;

registerEnglish(enNeeds);
