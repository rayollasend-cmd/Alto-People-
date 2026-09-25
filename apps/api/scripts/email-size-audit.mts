/**
 * Measure every legacy template in lib/emailTemplates.ts: HTML bytes as
 * rendered today (no org logo → the base64 logo the production build
 * inlines is reported separately) plus its subject.
 *
 *   npx tsx scripts/email-size-audit.mts
 */
process.env.DATABASE_URL ??= 'postgresql://preview:preview@localhost:5432/preview';
process.env.JWT_SECRET ??= 'preview-only-secret-that-is-at-least-forty-four-characters-long';
process.env.PAYOUT_ENCRYPTION_KEY ??= 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=';
process.env.APP_BASE_URL ??= 'https://people.altohr.com';

const T = await import('../src/lib/emailTemplates.js');

const actor = { name: 'Dana Ortiz', role: 'HR Administrator' };
const url = 'https://people.altohr.com/x';
const samples: Record<string, () => { subject: string; html: string; text: string }> = {
  inviteTemplate: () => T.inviteTemplate({ firstName: 'Maria', clientName: 'Walmart', position: 'Associate', hireDate: '2026-10-01', magicLink: url, linkExpiresAt: '2026-10-03' }),
  applicationApprovedTemplate: () => T.applicationApprovedTemplate({ firstName: 'Maria', clientName: 'Walmart', position: 'Associate', hireDate: '2026-10-01', managerName: 'Sam', location: 'Destin', appUrl: url }),
  applicationRejectedTemplate: () => T.applicationRejectedTemplate({ firstName: 'Maria', clientName: 'Walmart', rejectionReason: 'Position filled', decisionDate: '2026-09-20' }),
  onboardingCompleteTemplate: () => T.onboardingCompleteTemplate({ associateName: 'Maria Lopez', clientName: 'Walmart', position: 'Associate', submittedAt: '2026-09-20', applicationUrl: url }),
  i9Section2Template: () => T.i9Section2Template({ associateName: 'Maria Lopez', clientName: 'Walmart', hireDate: '2026-10-01', section2DueDate: '2026-10-04', i9Url: url }),
  documentUploadedTemplate: () => T.documentUploadedTemplate({ associateName: 'Maria Lopez', documentKind: 'Driver license', filename: 'dl.pdf', uploadedAt: '2026-09-20', documentsUrl: url }),
  documentRejectedAssociateTemplate: () => T.documentRejectedAssociateTemplate({ firstName: 'Maria', documentKind: 'Driver license', filename: 'dl.pdf', rejectionReason: 'Blurry', reviewerName: 'Dana', documentsUrl: url }),
  documentRejectedManagerTemplate: () => T.documentRejectedManagerTemplate({ associateName: 'Maria Lopez', documentKind: 'Driver license', rejectionReason: 'Blurry', reviewerName: 'Dana' }),
  passwordResetTemplate: () => T.passwordResetTemplate({ firstName: 'Maria', email: 'maria@example.com', requestedAt: '2026-09-20', resetLink: url }),
  shiftSwapPeerTemplate: () => T.shiftSwapPeerTemplate({ firstName: 'Maria', requesterName: 'Sam', position: 'Cashier', clientName: 'Walmart', shiftDate: '2026-09-22', startsAt: '8:00 AM', endsAt: '4:00 PM', location: 'Destin', note: null, swapUrl: url }),
  shiftSwapManagerTemplate: () => T.shiftSwapManagerTemplate({ requesterName: 'Sam', counterpartyName: 'Maria', position: 'Cashier', clientName: 'Walmart', shiftDate: '2026-09-22', startsAt: '8:00 AM', endsAt: '4:00 PM' }),
  timeOffRequestTemplate: () => T.timeOffRequestTemplate({ associateName: 'Maria Lopez', category: 'PTO', hours: 8, dateRange: 'Sep 22', balanceHours: 40, reason: null, submittedAt: '2026-09-20', timeOffUrl: url }),
  disciplineAssociateTemplate: () => T.disciplineAssociateTemplate({ firstName: 'Maria', kindLabel: 'Written warning', effectiveDate: '2026-09-20', incidentDate: '2026-09-18', suspensionDays: null, description: 'Late', expectedAction: null, actor, disciplineUrl: url }),
  disciplineManagerTemplate: () => T.disciplineManagerTemplate({ associateName: 'Maria Lopez', kindLabel: 'Written warning', effectiveDate: '2026-09-20', suspensionDays: null, actor }),
  probationAssociateTemplate: () => T.probationAssociateTemplate({ firstName: 'Maria', startDate: '2026-09-20', endDate: '2026-12-20', durationDays: 90, actor }),
  probationManagerTemplate: () => T.probationManagerTemplate({ associateName: 'Maria Lopez', startDate: '2026-09-20', endDate: '2026-12-20', actor }),
  mfaEnabledTemplate: () => T.mfaEnabledTemplate({ firstName: 'Maria', email: 'maria@example.com', occurredAt: '2026-09-20' }),
  w4SsnRecollectionTemplate: () => T.w4SsnRecollectionTemplate({ firstName: 'Maria', taskUrl: url, needsNumber: true, needsCard: true }),
  mfaDisabledTemplate: () => T.mfaDisabledTemplate({ firstName: 'Maria', email: 'maria@example.com', occurredAt: '2026-09-20' }),
  mfaCodesRegeneratedTemplate: () => T.mfaCodesRegeneratedTemplate({ firstName: 'Maria', email: 'maria@example.com', occurredAt: '2026-09-20' }),
  onboardingReminderTemplate: () => T.onboardingReminderTemplate({ firstName: 'Maria', clientName: 'Walmart', percentComplete: 40, hireDate: '2026-10-01', daysRemaining: 5, magicLink: url }),
  scheduledReportTemplate: () => T.scheduledReportTemplate({ reportName: 'Hours', runDate: '2026-09-20', cadence: 'Weekly', rowCount: 100, truncated: false, rowCap: 5000, reportsUrl: url }),
  genericNotificationTemplate: () => T.genericNotificationTemplate({ subject: 'Hello', body: 'A short body.', linkUrl: url }),
  paystubTemplate: () => T.paystubTemplate({ firstName: 'Maria', periodLabel: 'Sep 6 – Sep 12', netPay: '$512.40', payrollUrl: url }),
  esignCopyTemplate: () => T.esignCopyTemplate({ firstName: 'Maria', agreementTitle: 'Handbook acknowledgment', signedAtIso: '2026-09-20T12:00:00Z', pdfHash: 'abc123', downloadUrl: url }),
  storeManagerInviteTemplate: () => T.storeManagerInviteTemplate({ name: 'Sam Park', storeName: 'Store 1234', clientName: 'Walmart', magicLink: url, linkExpiresAt: '2026-10-03' }),
  marketManagerInviteTemplate: () => T.marketManagerInviteTemplate({ name: 'Sam Park', regionName: 'Gulf Coast', storeCount: 12, magicLink: url, linkExpiresAt: '2026-10-03' }),
};

for (const [name, build] of Object.entries(samples)) {
  try {
    const r = build();
    const kb = (Buffer.byteLength(r.html, 'utf8') / 1024).toFixed(1);
    const base64 = /src="data:image/.test(r.html) ? 'base64-logo' : 'no-logo';
    console.log(`${name}\t${kb} KB\t${base64}\t${r.subject}`);
  } catch (err) {
    console.log(`${name}\tERROR\t${(err as Error).message}`);
  }
}
