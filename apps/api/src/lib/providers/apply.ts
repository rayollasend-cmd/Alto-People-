import type { EVerifyStatus, ProviderConnection } from '@prisma/client';
import { prisma } from '../../db.js';
import { addBusinessDays } from '../everifyReadiness.js';
import { tryDecryptString } from '../crypto.js';
import { notifyFinance } from '../financialChanges.js';
import { rerouteReturnedItem } from '../payoutReroute.js';
import { WISE_RETURN_STATES } from '../wise.js';
import { contextFor, recordFailure, recordOutboundEvent, recordSuccess, type ProviderContext } from './connections.js';
import { addFederalWorkingDays, everifyAdapter, type EVerifyCaseState, type EVerifyClosure } from './everify.js';
import { drugLedgerStatus, drugTestAdapter, type DrugStatus } from './drugTesting.js';
import { ProviderError } from './http.js';
import { packageFor, screeningAdapter, type ScreeningReport } from './screening.js';
import { mapEfileStatus, taxFilingAdapter, type FilableKind, type FilingResult } from './taxFiling.js';
import { tenantIdForWrite } from '../tenant.js';

/**
 * What a provider's answer does to Alto's records — one function per
 * domain, shared by the action routes (a person pressed a button) and the
 * webhook receiver (the provider called back). Every call records health on
 * the connection and a line in its event log.
 */

async function withHealth<T>(ctx: ProviderContext, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    await recordSuccess(ctx.connectionId);
    return out;
  } catch (err) {
    await recordFailure(ctx.connectionId, err instanceof Error ? err.message : 'Provider call failed.');
    throw err;
  }
}

/* ----- E-Verify ------------------------------------------------------------- */

/** When the employee was given the further-action notice, they have 8 federal working days to contact SSA/DHS after referral. */
export const EVERIFY_REFERRAL_WORKING_DAYS = 8;

export async function applyEVerifyState(i9Id: string, s: EVerifyCaseState, connectionId: string | null): Promise<void> {
  const now = new Date();
  const prev = await prisma.i9Verification.findUnique({ where: { id: i9Id }, select: { eVerifyStatus: true, eVerifyCaseOpenedAt: true } });
  await prisma.i9Verification.update({
    where: { id: i9Id },
    data: {
      eVerifyCaseNumber: s.caseNumber || undefined,
      eVerifyStatus: s.status,
      eVerifyRawStatus: s.rawStatus.slice(0, 80),
      eVerifyLastSyncAt: now,
      eVerifyLastError: null,
      ...(connectionId ? { eVerifyConnectionId: connectionId } : {}),
      ...(prev?.eVerifyCaseOpenedAt ? {} : { eVerifyCaseOpenedAt: now }),
      ...(s.closed || s.status === 'EMPLOYMENT_AUTHORIZED' || s.status === 'FINAL_NONCONFIRMATION' ? { eVerifyClosedAt: now } : {}),
    },
  });
}

export interface EVerifySubmitInput {
  associateId: string;
  firstDayOfEmployment: Date | null;
}

/** Open the case with the connected provider from the I-9 and the person's record. */
export async function submitEVerifyCase(conn: ProviderConnection, input: EVerifySubmitInput): Promise<EVerifyCaseState> {
  const ctx = contextFor(conn);
  const a = await prisma.associate.findFirst({
    where: { id: input.associateId, tenantId: conn.tenantId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      middleInitial: true,
      otherLastNames: true,
      dob: true,
      email: true,
      hireDate: true,
      i9Verification: { select: { id: true, citizenshipStatus: true, alienRegistrationNumberEnc: true, workAuthExpiresAt: true, documentList: true, section2CompletedAt: true, eVerifyCaseNumber: true, eVerifyStatus: true } },
      w4Submission: { select: { ssnEncrypted: true } },
    },
  });
  if (!a) throw new ProviderError('Person not found.', 404, 'not_found');
  const i9 = a.i9Verification;
  if (!i9?.section2CompletedAt) throw new ProviderError('Complete I-9 Section 2 before opening the E-Verify case.', 409, 'section2_incomplete');
  if (i9.eVerifyCaseNumber && i9.eVerifyStatus && i9.eVerifyStatus !== 'CLOSE_CASE_AND_RESUBMIT') {
    throw new ProviderError('This person already has an open E-Verify case.', 409, 'case_exists');
  }
  const ssn = a.w4Submission?.ssnEncrypted ? tryDecryptString(a.w4Submission.ssnEncrypted) : null;
  if (!ssn) throw new ProviderError('No readable Social Security number on file.', 409, 'no_ssn');
  if (!a.dob) throw new ProviderError('No date of birth on file.', 409, 'no_dob');
  if (!i9.citizenshipStatus) throw new ProviderError('The I-9 has no citizenship status.', 409, 'no_citizenship');
  const firstDay = input.firstDayOfEmployment ?? a.hireDate;
  if (!firstDay) throw new ProviderError('No first day of employment on file.', 409, 'no_first_day');
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  const s = await withHealth(ctx, () =>
    everifyAdapter(conn.provider).createCase(ctx, {
      ref: i9.id,
      firstName: a.firstName,
      lastName: a.lastName,
      middleInitial: a.middleInitial ?? null,
      otherLastNames: a.otherLastNames.length ? a.otherLastNames.join(', ') : null,
      dob: ymd(a.dob!),
      ssn: ssn.replace(/\D/g, ''),
      email: a.email,
      citizenshipStatus: i9.citizenshipStatus!,
      alienNumber: i9.alienRegistrationNumberEnc ? tryDecryptString(i9.alienRegistrationNumberEnc) : null,
      workAuthExpiresAt: i9.workAuthExpiresAt ? ymd(i9.workAuthExpiresAt) : null,
      documentList: i9.documentList ?? null,
      firstDayOfEmployment: ymd(firstDay),
    }),
  );
  await prisma.i9Verification.update({ where: { id: i9.id }, data: { eVerifyDueBy: addBusinessDays(firstDay, 3) } });
  await applyEVerifyState(i9.id, s, conn.id);
  await recordOutboundEvent({ connection: ctx, kind: 'EVERIFY', eventType: 'case.created', subjectType: 'I9Verification', subjectId: i9.id, ok: true, payload: { caseNumber: s.caseNumber, status: s.rawStatus } });
  return s;
}

export async function refreshEVerifyCase(conn: ProviderConnection, i9Id: string, caseNumber: string): Promise<EVerifyCaseState> {
  const ctx = contextFor(conn);
  const s = await withHealth(ctx, () => everifyAdapter(conn.provider).getCase(ctx, caseNumber));
  await applyEVerifyState(i9Id, s, conn.id);
  return s;
}

/** The employee was given the notice and chose: take action (refer) or not. */
export async function decideEVerifyMismatch(conn: ProviderConnection, i9Id: string, caseNumber: string, decision: 'CONTEST' | 'NO_CONTEST'): Promise<EVerifyCaseState> {
  const ctx = contextFor(conn);
  const adapter = everifyAdapter(conn.provider);
  const s = await withHealth(ctx, () => (decision === 'CONTEST' ? adapter.refer(ctx, caseNumber) : adapter.noAction(ctx, caseNumber)));
  const now = new Date();
  await prisma.i9Verification.update({
    where: { id: i9Id },
    data: {
      eVerifyTncDecision: decision,
      eVerifyTncNotifiedAt: now,
      ...(decision === 'CONTEST' ? { eVerifyReferredAt: now, eVerifyReferralDeadline: addFederalWorkingDays(now, EVERIFY_REFERRAL_WORKING_DAYS) } : {}),
    },
  });
  await applyEVerifyState(i9Id, s, conn.id);
  return s;
}

export async function closeEVerifyCase(conn: ProviderConnection, i9Id: string, caseNumber: string, reason: EVerifyClosure): Promise<EVerifyCaseState> {
  const ctx = contextFor(conn);
  const s = await withHealth(ctx, () => everifyAdapter(conn.provider).close(ctx, caseNumber, reason));
  await prisma.i9Verification.update({ where: { id: i9Id }, data: { eVerifyClosureReason: reason, eVerifyClosedAt: new Date() } });
  await applyEVerifyState(i9Id, { ...s, closed: true }, conn.id);
  return s;
}

/* ----- Background checks ------------------------------------------------- */

const bgLedger = (r: Pick<ScreeningReport, 'complete' | 'result' | 'rawStatus'>): 'INITIATED' | 'IN_PROGRESS' | 'PASSED' | 'NEEDS_REVIEW' => {
  if (r.complete && r.result === 'clear') return 'PASSED';
  if (r.complete && r.result === 'consider') return 'NEEDS_REVIEW';
  if (/suspend|paus|dispute/i.test(r.rawStatus)) return 'NEEDS_REVIEW';
  return r.rawStatus && !/^(pending|invited|sent)$/i.test(r.rawStatus) ? 'IN_PROGRESS' : 'INITIATED';
};

export async function applyScreeningReport(checkId: string, r: ScreeningReport): Promise<void> {
  const status = bgLedger(r);
  const row = await prisma.backgroundCheck.update({
    where: { id: checkId },
    data: {
      externalId: r.externalId || undefined,
      rawStatus: r.rawStatus.slice(0, 40),
      result: r.result,
      lastSyncAt: new Date(),
      lastError: null,
      ...(status === 'PASSED' ? { status: 'PASSED', completedAt: new Date(), adjudication: 'ENGAGED' } : { status }),
    },
  });
  // A clear report completes the onboarding task the consent left in progress
  // (lib/backgroundCheckConsent.ts; imported lazily — that module orders through this one).
  if (status === 'PASSED') await (await import('../backgroundCheckConsent.js')).markBackgroundTaskDone(prisma, row.associateId);
}

export async function orderBackgroundCheck(conn: ProviderConnection, checkId: string, opts: { packageCode?: string | null; position?: string | null }): Promise<void> {
  const ctx = contextFor(conn);
  const check = await prisma.backgroundCheck.findFirst({
    where: { id: checkId, tenantId: conn.tenantId },
    select: { id: true, clientId: true, externalId: true, associate: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, zip: true, state: true, city: true } } },
  });
  if (!check) throw new ProviderError('Background check not found.', 404, 'not_found');
  if (check.externalId) throw new ProviderError('This check was already ordered.', 409, 'already_ordered');
  const pkg = opts.packageCode || packageFor(ctx.settings, check.clientId, opts.position ?? null);
  if (!pkg) throw new ProviderError('Choose a package: there is no default package on the connection.', 409, 'no_package');
  const a = check.associate;
  const order = await withHealth(ctx, () =>
    screeningAdapter(conn.provider).order(
      ctx,
      { ref: check.id, firstName: a.firstName, lastName: a.lastName, email: a.email, phone: a.phone ?? null, zip: a.zip ?? null, workState: a.state ?? null, workCity: a.city ?? null },
      pkg,
    ),
  );
  await prisma.backgroundCheck.update({
    where: { id: check.id },
    data: {
      provider: conn.provider,
      connectionId: conn.id,
      externalId: order.externalId,
      externalCandidateId: order.externalCandidateId,
      invitationUrl: order.invitationUrl,
      packageCode: pkg,
      rawStatus: order.rawStatus.slice(0, 40),
      status: 'INITIATED',
      lastSyncAt: new Date(),
      lastError: null,
    },
  });
  await recordOutboundEvent({ connection: ctx, kind: 'BACKGROUND_CHECK', eventType: 'order.created', subjectType: 'BackgroundCheck', subjectId: check.id, ok: true, payload: { package: pkg, status: order.rawStatus } });
}

export async function refreshBackgroundCheck(conn: ProviderConnection, checkId: string, externalId: string): Promise<void> {
  const ctx = contextFor(conn);
  const r = await withHealth(ctx, () => screeningAdapter(conn.provider).report(ctx, externalId));
  await applyScreeningReport(checkId, r);
}

/**
 * FCRA: before deciding against someone on a report, send the pre-adverse
 * notice (with the report and the summary of rights), wait a reasonable
 * period for them to respond, then send the final adverse action notice.
 */
export async function startPreAdverse(conn: ProviderConnection, checkId: string, waitDays: number): Promise<Date> {
  const ctx = contextFor(conn);
  const check = await prisma.backgroundCheck.findFirst({ where: { id: checkId, tenantId: conn.tenantId }, select: { id: true, externalId: true, result: true, adjudication: true } });
  if (!check?.externalId) throw new ProviderError('This check has no report yet.', 409, 'no_report');
  if (check.adjudication === 'PRE_ADVERSE' || check.adjudication === 'ADVERSE') throw new ProviderError('Adverse action has already started.', 409, 'already_started');
  const waitUntil = new Date(Date.now() + waitDays * 86_400_000);
  const id = await withHealth(ctx, () => screeningAdapter(conn.provider).preAdverse(ctx, check.externalId!, waitUntil));
  await prisma.backgroundCheck.update({
    where: { id: check.id },
    data: { adjudication: 'PRE_ADVERSE', preAdverseSentAt: new Date(), adverseWaitUntil: waitUntil, adverseActionId: id },
  });
  return waitUntil;
}

export async function cancelAdverse(conn: ProviderConnection, checkId: string): Promise<void> {
  const ctx = contextFor(conn);
  const check = await prisma.backgroundCheck.findFirst({ where: { id: checkId, tenantId: conn.tenantId }, select: { id: true, adverseActionId: true, adjudication: true } });
  if (!check) throw new ProviderError('Background check not found.', 404, 'not_found');
  if (check.adjudication !== 'PRE_ADVERSE') throw new ProviderError('Only a pending adverse action can be withdrawn.', 409, 'not_pending');
  if (check.adverseActionId) await withHealth(ctx, () => screeningAdapter(conn.provider).cancelAdverse(ctx, check.adverseActionId!));
  await prisma.backgroundCheck.update({ where: { id: check.id }, data: { adjudication: 'ENGAGED', status: 'PASSED', completedAt: new Date(), adverseWaitUntil: null } });
}

/* ----- Drug tests ------------------------------------------------------------ */

export async function applyDrugStatus(testId: string, s: DrugStatus): Promise<void> {
  const status = drugLedgerStatus(s);
  await prisma.drugTest.update({
    where: { id: testId },
    data: {
      externalId: s.externalId || undefined,
      rawStatus: s.rawStatus.slice(0, 40),
      resultCode: s.resultCode,
      lastSyncAt: new Date(),
      lastError: null,
      status,
      ...(s.mroVerified ? { mroVerifiedAt: new Date() } : {}),
      ...(status === 'PASSED' || status === 'FAILED' ? { completedAt: new Date() } : {}),
    },
  });
}

export async function orderDrugTest(conn: ProviderConnection, testId: string, opts: { panel?: string | null; reason?: string | null }): Promise<void> {
  const ctx = contextFor(conn);
  const t = await prisma.drugTest.findFirst({
    where: { id: testId, tenantId: conn.tenantId },
    select: { id: true, externalId: true, associate: { select: { firstName: true, lastName: true, email: true, phone: true, zip: true, dob: true } } },
  });
  if (!t) throw new ProviderError('Drug test not found.', 404, 'not_found');
  if (t.externalId) throw new ProviderError('This test was already ordered.', 409, 'already_ordered');
  const panel = opts.panel || (typeof ctx.settings.defaultPanel === 'string' ? ctx.settings.defaultPanel : '');
  if (!panel) throw new ProviderError('Choose a panel: there is no default panel on the connection.', 409, 'no_panel');
  const reason = opts.reason || 'PRE_EMPLOYMENT';
  const a = t.associate;
  const order = await withHealth(ctx, () =>
    drugTestAdapter(conn.provider).order(ctx, { ref: t.id, firstName: a.firstName, lastName: a.lastName, email: a.email, phone: a.phone ?? null, zip: a.zip ?? null, dob: a.dob ? a.dob.toISOString().slice(0, 10) : null }, panel, reason),
  );
  await prisma.drugTest.update({
    where: { id: t.id },
    data: {
      provider: conn.provider,
      connectionId: conn.id,
      externalId: order.externalId,
      panelCode: panel,
      reason,
      donorPassUrl: order.donorPassUrl,
      donorPassExpiresAt: order.donorPassExpiresAt ? new Date(order.donorPassExpiresAt) : null,
      collectionSite: order.collectionSite,
      rawStatus: order.rawStatus.slice(0, 40),
      status: 'INITIATED',
      lastSyncAt: new Date(),
      lastError: null,
    },
  });
  await recordOutboundEvent({ connection: ctx, kind: 'DRUG_TEST', eventType: 'order.created', subjectType: 'DrugTest', subjectId: t.id, ok: true, payload: { panel, reason } });
}

export async function refreshDrugTest(conn: ProviderConnection, testId: string, externalId: string): Promise<void> {
  const ctx = contextFor(conn);
  const s = await withHealth(ctx, () => drugTestAdapter(conn.provider).status(ctx, externalId));
  await applyDrugStatus(testId, s);
}

/* ----- Tax filing -------------------------------------------------------------- */

export async function applyFiling(formId: string, r: Pick<FilingResult, 'status' | 'rejectionReason' | 'recordId'>, actorUserId: string | null): Promise<void> {
  const now = new Date();
  await prisma.taxForm.update({
    where: { id: formId },
    data: {
      efileStatus: r.status,
      efileStatusAt: now,
      efileRejectionReason: r.status === 'REJECTED' ? (r.rejectionReason ?? 'Rejected by the agency.').slice(0, 500) : null,
      ...(r.recordId ? { efileRecordId: r.recordId } : {}),
      // Accepted is filed: the agency's acceptance is the receipt.
      ...(r.status === 'ACCEPTED' ? { status: 'FILED', filedAt: now, filedById: actorUserId } : {}),
    },
  });
}

export async function efileTaxForm(conn: ProviderConnection, formId: string, actorUserId: string): Promise<FilingResult> {
  const ctx = contextFor(conn);
  const f = await prisma.taxForm.findFirst({
    where: { id: formId, tenantId: conn.tenantId },
    include: { associate: { select: { firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, w4Submission: { select: { ssnEncrypted: true } } } } },
  });
  if (!f) throw new ProviderError('Form not found.', 404, 'not_found');
  if (f.status !== 'DRAFT' && f.status !== 'AMENDED') throw new ProviderError('Only a draft form can be e-filed.', 409, 'invalid_state');
  if (f.efileStatus && f.efileStatus !== 'REJECTED') throw new ProviderError('This form is already with the filing partner.', 409, 'already_submitted');
  const profile = await prisma.submitterProfile.findUnique({ where: { tenantId: tenantIdForWrite() } });
  const org = await prisma.orgSetting.findFirst({ where: { tenantId: conn.tenantId }, select: { orgName: true } });
  const ein = f.ein ?? profile?.ein ?? '';
  if (!ein) throw new ProviderError('Set the submitter profile (EIN) before e-filing.', 409, 'no_ein');
  const a = f.associate;
  const result = await withHealth(ctx, () =>
    taxFilingAdapter(conn.provider).submit(ctx, {
      ref: f.id,
      kind: f.kind as FilableKind,
      taxYear: f.taxYear,
      quarter: f.quarter,
      amounts: (f.amounts ?? {}) as Record<string, unknown>,
      filer: {
        ein,
        name: profile?.name ?? org?.orgName ?? 'Employer',
        addressLine1: profile?.addressLine1 ?? null,
        city: profile?.city ?? null,
        state: profile?.state ?? null,
        zip: profile ? `${profile.zip5}${profile.zip4 ? `-${profile.zip4}` : ''}` : null,
        contactName: profile?.contactName ?? null,
        contactPhone: profile?.contactPhone ?? null,
      },
      recipient: a
        ? {
            firstName: a.firstName,
            lastName: a.lastName,
            ssn: a.w4Submission?.ssnEncrypted ? tryDecryptString(a.w4Submission.ssnEncrypted) : null,
            addressLine1: a.addressLine1 ?? null,
            city: a.city ?? null,
            state: a.state ?? null,
            zip: a.zip ?? null,
          }
        : null,
    }),
  );
  if (result.businessId && result.businessId !== ctx.settings.businessId) {
    await prisma.providerConnection.update({ where: { id: conn.id }, data: { settings: { ...ctx.settings, businessId: result.businessId } } });
  }
  await prisma.taxForm.update({ where: { id: f.id }, data: { efileConnectionId: conn.id, efileSubmissionId: result.submissionId, efileSubmittedAt: new Date() } });
  await applyFiling(f.id, result, actorUserId);
  await recordOutboundEvent({ connection: ctx, kind: 'TAX_FILING', eventType: 'return.transmitted', subjectType: 'TaxForm', subjectId: f.id, ok: result.status !== 'REJECTED', error: result.rejectionReason, payload: { kind: f.kind, status: result.status } });
  return result;
}

export async function refreshFiling(conn: ProviderConnection, formId: string): Promise<FilingResult> {
  const ctx = contextFor(conn);
  const f = await prisma.taxForm.findFirst({ where: { id: formId, tenantId: conn.tenantId }, select: { id: true, kind: true, efileSubmissionId: true, efileRecordId: true } });
  if (!f?.efileSubmissionId) throw new ProviderError('This form has not been e-filed.', 409, 'not_submitted');
  const r = await withHealth(ctx, () => taxFilingAdapter(conn.provider).status(ctx, f.kind as FilableKind, f.efileSubmissionId!, f.efileRecordId));
  await applyFiling(f.id, r, null);
  return r;
}

export { mapEfileStatus };

/* ----- Payouts ------------------------------------------------------------------- */

/**
 * A Wise transfer changed state. A bounce, refund, chargeback or cancel
 * after funding means the money came back: re-route the paycheck through
 * the existing returned-deposit flow (to the last verified other account,
 * else a paper check). Idempotent: an item already re-routed is left alone.
 */
export async function applyPayoutState(transferId: string, state: string): Promise<{ applied: boolean; payrollItemId: string | null; note: string }> {
  const attempt = await prisma.payrollDisbursementAttempt.findFirst({
    where: { provider: 'WISE', externalRef: transferId },
    orderBy: { attemptedAt: 'desc' },
    select: { payrollItemId: true },
  });
  if (!attempt) return { applied: false, payrollItemId: null, note: 'unknown_transfer' };
  if (!WISE_RETURN_STATES.has(state)) return { applied: false, payrollItemId: attempt.payrollItemId, note: `state_${state}` };
  const outcome = await rerouteReturnedItem(prisma, {
    payrollItemId: attempt.payrollItemId,
    reason: `Wise reported the transfer ${state.replace(/_/g, ' ')}`,
    returnedRef: transferId,
    actorUserId: null,
  });
  if (outcome.outcome === 'held') {
    void notifyFinance({ subject: 'A returned deposit needs you', body: `Wise sent transfer ${transferId} back and it couldn’t be re-sent automatically (${outcome.reason}).`, linkUrl: '/payroll' }).catch(() => undefined);
  }
  return { applied: true, payrollItemId: attempt.payrollItemId, note: outcome.outcome };
}

export type { EVerifyStatus };
