// English for the pages that use 'hugoAdmin.*' keys — imported by them (scripts/i18n-check.mjs checks it).
// The organization's spend on the assistant's thinking (Agents & gates › thinking time), staff only.
import { registerEnglish } from '../english';
// Its Spanish travels with it, in the same chunk (es/hugoAdmin.ts): an associate never downloads it.
import '../es/hugoAdmin';

export const enHugoAdmin = {
  'hugoAdmin.title': '{name}’s thinking time',
  'hugoAdmin.description': 'What your assistant’s thinking cost this month, and who used the most. Everyone has their own allowance — {floor} every 30 days for {workers}, drivers and floor supervisors, {staff} a month for the office. Used up, the basics still work.',
  'hugoAdmin.off': 'No model is connected, so {name} answers from your records alone and nothing is spent.',
  'hugoAdmin.total': 'Spent this month',
  'hugoAdmin.people': 'People who used it',
  'hugoAdmin.usedUp': 'Used up right now',
  'hugoAdmin.usedUpHint': 'Answering the basics until theirs renews',
  'hugoAdmin.noneUsedUp': 'Nobody has run out',
  'hugoAdmin.floor': 'On the floor',
  'hugoAdmin.office': 'In the office',
  'hugoAdmin.byPurpose': 'What it was for',
  'hugoAdmin.purpose.chat': 'Questions in the app',
  'hugoAdmin.purpose.goal': 'Goals',
  'hugoAdmin.purpose.recurring': 'Recurring briefs',
  'hugoAdmin.purpose.whatsapp': 'WhatsApp',
  'hugoAdmin.top': 'Who used the most',
  'hugoAdmin.col.person': 'Person',
  'hugoAdmin.col.used': 'Allowance used',
  'hugoAdmin.col.spent': 'This month',
  'hugoAdmin.usedUpBadge': 'Used up',
  'hugoAdmin.empty': 'Nobody has used {name}’s thinking yet this month.',
  'hugoAdmin.loadFailed': 'Couldn’t load this month’s spend.',
  'hugoAdmin.retry': 'Try again',
} as const;

registerEnglish(enHugoAdmin);
