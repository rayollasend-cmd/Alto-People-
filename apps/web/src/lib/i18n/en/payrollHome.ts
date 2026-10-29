// English for the pages that use 'payrollHome.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';
// Its Spanish travels with it, in the same chunk (es/payrollHome.ts).
import '../es/payrollHome';

export const enPayrollHome = {
  'payrollHome.title': 'Payroll',
  'payrollHome.subProcess': 'Pay people for approved time: review, approve, pay.',
  'payrollHome.subReadOnly': 'Read-only view of payroll runs.',
  'payrollHome.financialChanges': 'Financial changes',
  'payrollHome.morePages': 'More payroll pages',
  'payrollHome.more': 'More',
  'payrollHome.readiness': 'Readiness',
  'payrollHome.goLive': 'Payroll setup checklist',
  'payrollHome.ytd': 'Year-to-date report',
  'payrollHome.taxForms': 'Tax forms',
  'payrollHome.compliance': 'Compliance',
  'payrollHome.laborRules': 'Labor rules',
  'payrollHome.yearEndClose': 'Year-end',
  'payrollHome.newRun': 'Off-cycle run',
  'payrollHome.tabRuns': 'Runs',
  'payrollHome.tabSchedules': 'Pay schedules',
  'payrollHome.tabGarnishments': 'Garnishments',
  'payrollHome.noRuns': 'No payroll runs yet',
  'payrollHome.noRunsFiltered': 'No {status} runs',
  'payrollHome.noRunsBody': 'Run payroll to make your first paychecks. New here? Check readiness first to see who still needs a W-4, a tax state or a pay schedule.',
  'payrollHome.noRunsFilteredBody': 'Switch to a different status, or create a new run.',
  'payrollHome.runPayroll': 'Run payroll',
  'payrollHome.checkReadiness': 'Check readiness',
  'payrollHome.statusDraft': 'Draft',
  'payrollHome.statusFinalized': 'Finalized',
  'payrollHome.statusDisbursed': 'Paid',
  'payrollHome.statusCancelled': 'Cancelled',
  'payrollHome.statusAll': 'All',
  'payrollHome.statusOpen': 'Open',
  'payrollHome.finalizeRun': 'Finalize this run?',
} as const;

registerEnglish(enPayrollHome);
