// English for the pages that use 'payCheck.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enPayCheck = {
  'payCheck.title': "Paper check this payday",
  'payCheck.prompt': "Need a paper check instead of your deposit this payday?",
  'payCheck.ask': "Ask for a paper check",
  'payCheck.reasonLabel': "Why? Payroll sees this",
  'payCheck.reasonPlaceholder': "My bank account is changing this week",
  'payCheck.send': "Send request",
  'payCheck.cancel': "Cancel",
  'payCheck.sent': "Request sent. Payroll will answer before payday.",
  'payCheck.pending': "You asked for a paper check for {period}. Payroll will answer before payday.",
  'payCheck.approved': "Your pay for {period} comes as a paper check. Your usual deposit resumes next payday.",
  'payCheck.declined': "Payroll kept your usual deposit for {period}: {reason}",
  'payCheck.failed': "We couldn’t send your request.",
  'payCheck.note': "Only this paycheck changes. Your deposit stays on file.",
} as const;

registerEnglish(enPayCheck);
