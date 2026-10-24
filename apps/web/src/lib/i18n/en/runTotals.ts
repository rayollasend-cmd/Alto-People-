// English for the pages that use 'runTotals.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enRunTotals = {
  // A run's stored totals vs its paychecks (F500 SH-4; apps/api/src/lib/payrollRunTotals.ts).
  'runTotals.title': 'The totals and the paychecks disagree.',
  'runTotals.noPaychecks': 'This run records {gross} gross but has no paychecks.',
  'runTotals.disagree': 'This run records {gross} gross and {net} net, but its {count} paychecks add up to {itemsGross} gross and {itemsNet} net.',
  'runTotals.next': 'Don’t sign off or pay from these numbers: reopen the run or ask payroll support.',
} as const;

registerEnglish(enRunTotals);
