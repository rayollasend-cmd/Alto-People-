// English for the pages that use 'adminHome.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';
// Its Spanish travels with it, in the same chunk (es/adminHome.ts).
import '../es/adminHome';

export const enAdminHome = {
  'adminHome.subHr': 'Here\'s what\'s happening across your workforce today.',
  'adminHome.subOps': 'The floor today — every store, what is open and what needs you.',
  'adminHome.subExec': 'Company-wide pulse. Read-only across every module.',
  'adminHome.subFinance': 'Financial pulse — payroll runs, disbursements, and pending tax filings.',
  'adminHome.subRecruiter': 'Recruiting pipeline and open onboarding applications.',
  'adminHome.subClient': 'Your workforce snapshot.',
  'adminHome.subManager': 'Your team — pending approvals and time-off requests.',
  'adminHome.subShift': 'Your site today — who\'s on, who\'s late, what\'s open.',
  'adminHome.subFloor': 'Your site right now — who\'s on the floor.',
  'adminHome.loadFailed': 'Failed to load dashboard data.',
  'adminHome.workforceSnapshot': 'Workforce snapshot',
  'adminHome.onboardingPipeline': 'Onboarding pipeline',
  'adminHome.noApplications': 'No applications yet',
  'adminHome.noApplicationsBody': 'New hires will appear here as HR creates them.',
  'adminHome.openOnboarding': 'Open onboarding',
  'adminHome.recentActivity': 'Recent activity',
  'adminHome.auditLog': 'Audit log',
  'adminHome.appToReview': 'Application to review',
  'adminHome.appsToReview': 'Applications to review',
  'adminHome.appsHint': 'Submitted and waiting on you.',
  'adminHome.incidentToReview': 'Safety incident awaiting review',
  'adminHome.incidentsToReview': 'Safety incidents awaiting review',
  'adminHome.incidentsHint': 'Reported from the field. Resolving one notifies the {managerLc} who filed it.',
  'adminHome.openInjuryLog': 'Open the injury log',
  'adminHome.i9Due': 'I-9 Section 2 due',
  'adminHome.i9Hint': 'Federal deadline: 3 business days from hire.',
  'adminHome.completeSection2': 'Complete Section 2',
  'adminHome.docToVerify': 'Document waiting for verification',
  'adminHome.docsToVerify': 'Documents waiting for verification',
  'adminHome.reviewDocuments': 'Review documents',
  'adminHome.pendingPayroll': '{amount} pending payroll',
  'adminHome.pendingPayrollHint': 'Finalized runs awaiting disbursement.',
  'adminHome.openPayroll': 'Open payroll',
  'adminHome.ssnRecollect': 'SSN needs re-collection',
  'adminHome.ssnsRecollect': 'SSNs need re-collection',
  'adminHome.ssnHint': 'W-4 SSNs that can no longer be read, or card photos still missing — blocks new-hire reporting and W-2s.',
  'adminHome.openCampaign': 'Open campaign',
} as const;

registerEnglish(enAdminHome);
