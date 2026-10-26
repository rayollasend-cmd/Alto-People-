import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { can } from '@alto-people/shared';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit, recordComplianceEvent } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { scopeAssociates, scopeBackgroundChecks, scopeDrugTests, scopeWhere } from '../lib/scope.js';
import { activeConnection } from '../lib/providers/connections.js';
import { providerInfo } from '../lib/providers/catalog.js';
import { ProviderError } from '../lib/providers/http.js';
import { providerFailureText } from '../lib/providers/failureText.js';
import {
  cancelAdverse,
  closeEVerifyCase,
  decideEVerifyMismatch,
  efileTaxForm,
  orderBackgroundCheck,
  orderDrugTest,
  refreshBackgroundCheck,
  refreshDrugTest,
  refreshEVerifyCase,
  refreshFiling,
  startPreAdverse,
  submitEVerifyCase,
} from '../lib/providers/apply.js';
import type { ProviderKind } from '@prisma/client';

/**
 * The buttons on the compliance and tax screens that talk to a connected
 * provider. Every action is tenant- and scope-checked, audited, and turns a
 * provider failure into a 502 with the provider's own words, so the screen
 * can say what broke. Without a connection each answers 409
 * `not_connected` and the manual entry on the same screen keeps working.
 *
 *   GET  /provider-actions/summary
 *   GET|POST /provider-actions/everify/:associateId[/submit|/refresh|/notice|/close]
 *   GET|POST /provider-actions/background/:id[/order|/refresh|/pre-adverse|/adverse|/withdraw]
 *   GET|POST /provider-actions/drug-tests/:id[/order|/refresh]
 *   POST /provider-actions/tax-forms/:id/efile|/refresh
 */
export const providerActionsRouter = Router();

const COMPLIANCE = requireCapability('manage:compliance');
const COMPLIANCE_VIEW = requireCapability('view:compliance');
const PAYROLL = requireCapability('process:payroll');

/** FCRA: the wait between the pre-adverse notice and the final notice. */
const DEFAULT_ADVERSE_WAIT_DAYS = 7;

async function connectionOr409(kind: ProviderKind) {
  const c = await activeConnection(kind);
  if (!c) throw new HttpError(409, 'not_connected', 'No provider is connected for this. Connect one in Settings & trust → Integrations, or record it by hand.');
  return c;
}

/**
 * Our own preconditions keep their status and words; a provider's refusal
 * reads as a plain sentence, with the vendor's own words in `details.detail`.
 */
function asHttp(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof ProviderError) {
    if (err.status && err.status >= 400 && err.status < 500 && ['not_found', 'section2_incomplete', 'case_exists', 'no_ssn', 'no_dob', 'no_citizenship', 'no_first_day', 'already_ordered', 'no_package', 'no_panel', 'no_report', 'already_started', 'not_pending', 'invalid_state', 'already_submitted', 'no_ein', 'not_submitted'].includes(err.code)) {
      throw new HttpError(err.status, err.code, err.message);
    }
    const failure = providerFailureText(err.message, { label: 'The provider' });
    throw new HttpError(502, 'provider_error', failure?.message ?? err.message, failure?.detail ? { detail: failure.detail } : undefined);
  }
  throw err;
}

/** A stored failure as the page shows it: the sentence, and the vendor's words behind it. */
function failureFields(raw: string | null | undefined, label: string, kind: ProviderKind) {
  const f = providerFailureText(raw, { label, kind });
  return { lastError: f?.message ?? null, lastErrorDetail: f?.detail ?? null };
}

providerActionsRouter.get('/summary', requireAuth, async (req, res) => {
  const rows = await prisma.providerConnection.findMany({ where: { tenantId: tenantIdForWrite(), active: true }, select: { kind: true, provider: true, environment: true, lastErrorAt: true, lastSuccessAt: true } });
  const byKind = Object.fromEntries(
    rows.map((r) => [
      r.kind,
      {
        provider: r.provider,
        label: providerInfo(r.provider)?.label ?? r.provider,
        environment: r.environment,
        failing: (r.lastErrorAt?.getTime() ?? 0) > (r.lastSuccessAt?.getTime() ?? 0),
      },
    ]),
  );
  res.json({ connected: byKind, canManageIntegrations: !!req.user && can(req.user, 'manage:integrations') });
});

/* ----- E-Verify ------------------------------------------------------------- */

async function i9For(req: Request) {
  const associateId = z.string().uuid().parse(req.params.associateId);
  const a = await prisma.associate.findFirst({
    where: scopeWhere<Prisma.AssociateWhereInput>({ id: associateId, tenantId: tenantIdForWrite(), deletedAt: null }, scopeAssociates(req.user!)),
    select: {
      id: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      i9Verification: {
        select: {
          id: true,
          section2CompletedAt: true,
          eVerifyCaseNumber: true,
          eVerifyStatus: true,
          eVerifyCaseOpenedAt: true,
          eVerifyClosedAt: true,
          eVerifyConnectionId: true,
          eVerifyDueBy: true,
          eVerifyRawStatus: true,
          eVerifyTncNotifiedAt: true,
          eVerifyTncDecision: true,
          eVerifyReferredAt: true,
          eVerifyReferralDeadline: true,
          eVerifyClosureReason: true,
          eVerifyLastSyncAt: true,
          eVerifyLastError: true,
        },
      },
    },
  });
  if (!a) throw new HttpError(404, 'not_found', 'Person not found.');
  return a;
}

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

async function firstDayWorked(associateId: string): Promise<Date | null> {
  const first = await prisma.timeEntry.findFirst({ where: { associateId }, orderBy: { clockInAt: 'asc' }, select: { clockInAt: true } });
  return first?.clockInAt ?? null;
}

async function everifyView(req: Request) {
  const a = await i9For(req);
  const conn = await activeConnection('EVERIFY');
  const i9 = a.i9Verification;
  return {
    connected: conn ? { provider: conn.provider, label: providerInfo(conn.provider)?.label ?? conn.provider, environment: conn.environment } : null,
    sentThroughProvider: !!i9?.eVerifyConnectionId,
    caseNumber: i9?.eVerifyCaseNumber ?? null,
    status: i9?.eVerifyStatus ?? null,
    rawStatus: i9?.eVerifyRawStatus ?? null,
    openedAt: i9?.eVerifyCaseOpenedAt?.toISOString() ?? null,
    closedAt: i9?.eVerifyClosedAt?.toISOString() ?? null,
    dueBy: ymd(i9?.eVerifyDueBy),
    section2Done: !!i9?.section2CompletedAt,
    tnc: {
      notifiedAt: i9?.eVerifyTncNotifiedAt?.toISOString() ?? null,
      decision: i9?.eVerifyTncDecision ?? null,
      referredAt: i9?.eVerifyReferredAt?.toISOString() ?? null,
      referralDeadline: ymd(i9?.eVerifyReferralDeadline),
    },
    closureReason: i9?.eVerifyClosureReason ?? null,
    lastSyncAt: i9?.eVerifyLastSyncAt?.toISOString() ?? null,
    ...failureFields(i9?.eVerifyLastError, conn ? providerInfo(conn.provider)?.label ?? 'E-Verify' : 'E-Verify', 'EVERIFY'),
  };
}

providerActionsRouter.get('/everify/:associateId', COMPLIANCE, async (req, res) => {
  res.json(await everifyView(req));
});

function everifyAudit(req: Request, i9Id: string, associateId: string, action: string, metadata: Record<string, unknown>) {
  void recordComplianceEvent({ actorUserId: req.user!.id, action, entityType: 'I9Verification', entityId: i9Id, associateId, metadata, req });
}

async function rememberEVerifyError(i9Id: string | undefined, err: unknown) {
  if (i9Id && err instanceof ProviderError) {
    await prisma.i9Verification.update({ where: { id: i9Id }, data: { eVerifyLastError: err.message.slice(0, 500) } }).catch(() => undefined);
  }
}

providerActionsRouter.post('/everify/:associateId/submit', COMPLIANCE, async (req, res) => {
  const a = await i9For(req);
  const conn = await connectionOr409('EVERIFY');
  const body = z.object({ firstDayOfEmployment: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
  const firstDay = body.firstDayOfEmployment ? new Date(`${body.firstDayOfEmployment}T12:00:00Z`) : await firstDayWorked(a.id);
  try {
    const s = await submitEVerifyCase(conn, { associateId: a.id, firstDayOfEmployment: firstDay });
    everifyAudit(req, a.i9Verification?.id ?? '', a.id, 'compliance.everify_case_submitted', { provider: conn.provider, caseNumber: s.caseNumber, status: s.status });
  } catch (err) {
    await rememberEVerifyError(a.i9Verification?.id, err);
    asHttp(err);
  }
  res.json(await everifyView(req));
});

providerActionsRouter.post('/everify/:associateId/refresh', COMPLIANCE, async (req, res) => {
  const a = await i9For(req);
  const conn = await connectionOr409('EVERIFY');
  if (!a.i9Verification?.eVerifyCaseNumber) throw new HttpError(409, 'no_case', 'There is no E-Verify case to check yet.');
  try {
    await refreshEVerifyCase(conn, a.i9Verification.id, a.i9Verification.eVerifyCaseNumber);
  } catch (err) {
    await rememberEVerifyError(a.i9Verification.id, err);
    asHttp(err);
  }
  res.json(await everifyView(req));
});

providerActionsRouter.post('/everify/:associateId/notice', COMPLIANCE, async (req, res) => {
  const a = await i9For(req);
  const conn = await connectionOr409('EVERIFY');
  const { decision } = z.object({ decision: z.enum(['CONTEST', 'NO_CONTEST']) }).parse(req.body ?? {});
  const i9 = a.i9Verification;
  if (!i9?.eVerifyCaseNumber || i9.eVerifyStatus !== 'TENTATIVE_NONCONFIRMATION') throw new HttpError(409, 'no_mismatch', 'This case has no mismatch to act on.');
  if (i9.eVerifyTncDecision) throw new HttpError(409, 'already_decided', 'The employee’s choice is already recorded.');
  try {
    await decideEVerifyMismatch(conn, i9.id, i9.eVerifyCaseNumber, decision);
    everifyAudit(req, i9.id, a.id, 'compliance.everify_tnc_decision', { decision });
  } catch (err) {
    await rememberEVerifyError(i9.id, err);
    asHttp(err);
  }
  res.json(await everifyView(req));
});

const CLOSURES = ['EMPLOYEE_CONTINUES_TO_WORK', 'EMPLOYEE_NO_LONGER_EMPLOYED', 'INCORRECT_DATA', 'DUPLICATE_CASE', 'TERMINATED_FOR_FINAL_NONCONFIRMATION'] as const;

providerActionsRouter.post('/everify/:associateId/close', COMPLIANCE, async (req, res) => {
  const a = await i9For(req);
  const conn = await connectionOr409('EVERIFY');
  const { reason } = z.object({ reason: z.enum(CLOSURES) }).parse(req.body ?? {});
  const i9 = a.i9Verification;
  if (!i9?.eVerifyCaseNumber) throw new HttpError(409, 'no_case', 'There is no E-Verify case to close.');
  try {
    await closeEVerifyCase(conn, i9.id, i9.eVerifyCaseNumber, reason);
    everifyAudit(req, i9.id, a.id, 'compliance.everify_case_closed', { reason });
  } catch (err) {
    await rememberEVerifyError(i9.id, err);
    asHttp(err);
  }
  res.json(await everifyView(req));
});

/* ----- Background checks ------------------------------------------------- */

async function checkFor(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const c = await prisma.backgroundCheck.findFirst({
    where: scopeWhere<Prisma.BackgroundCheckWhereInput>({ id, tenantId: tenantIdForWrite() }, scopeBackgroundChecks(req.user!)),
  });
  if (!c) throw new HttpError(404, 'not_found', 'Background check not found.');
  return c;
}

async function checkView(req: Request) {
  const c = await checkFor(req);
  const conn = await activeConnection('BACKGROUND_CHECK');
  const waitDone = !!c.adverseWaitUntil && c.adverseWaitUntil.getTime() <= Date.now();
  return {
    id: c.id,
    connected: conn ? { provider: conn.provider, label: providerInfo(conn.provider)?.label ?? conn.provider, environment: conn.environment } : null,
    ordered: !!c.externalId,
    provider: c.provider,
    packageCode: c.packageCode,
    invitationUrl: c.invitationUrl,
    status: c.status,
    rawStatus: c.rawStatus,
    result: c.result,
    adjudication: c.adjudication,
    preAdverseSentAt: c.preAdverseSentAt?.toISOString() ?? null,
    adverseWaitUntil: c.adverseWaitUntil?.toISOString() ?? null,
    canSendFinal: c.adjudication === 'PRE_ADVERSE' && waitDone,
    adverseSentAt: c.adverseSentAt?.toISOString() ?? null,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    ...failureFields(c.lastError, providerInfo(c.provider ?? '')?.label ?? 'The screening provider', 'BACKGROUND_CHECK'),
  };
}

async function rememberCheckError(id: string, err: unknown) {
  if (err instanceof ProviderError) await prisma.backgroundCheck.update({ where: { id }, data: { lastError: err.message.slice(0, 500) } }).catch(() => undefined);
}

function bgAudit(req: Request, c: { id: string; associateId: string }, action: string, metadata: Record<string, unknown> = {}) {
  void recordComplianceEvent({ actorUserId: req.user!.id, action, entityType: 'BackgroundCheck', entityId: c.id, associateId: c.associateId, metadata, req });
}

providerActionsRouter.get('/background/:id', COMPLIANCE_VIEW, async (req, res) => {
  res.json(await checkView(req));
});

providerActionsRouter.post('/background/:id/order', COMPLIANCE, async (req, res) => {
  const c = await checkFor(req);
  const conn = await connectionOr409('BACKGROUND_CHECK');
  const body = z.object({ packageCode: z.string().trim().max(80).optional(), position: z.string().trim().max(120).optional() }).parse(req.body ?? {});
  try {
    await orderBackgroundCheck(conn, c.id, body);
    bgAudit(req, c, 'compliance.background_ordered', { provider: conn.provider, package: body.packageCode ?? 'default' });
  } catch (err) {
    await rememberCheckError(c.id, err);
    asHttp(err);
  }
  res.json(await checkView(req));
});

providerActionsRouter.post('/background/:id/refresh', COMPLIANCE, async (req, res) => {
  const c = await checkFor(req);
  const conn = await connectionOr409('BACKGROUND_CHECK');
  if (!c.externalId) throw new HttpError(409, 'not_ordered', 'This check hasn’t been ordered through the provider.');
  try {
    await refreshBackgroundCheck(conn, c.id, c.externalId);
  } catch (err) {
    await rememberCheckError(c.id, err);
    asHttp(err);
  }
  res.json(await checkView(req));
});

providerActionsRouter.post('/background/:id/pre-adverse', COMPLIANCE, async (req, res) => {
  const c = await checkFor(req);
  const conn = await connectionOr409('BACKGROUND_CHECK');
  if (c.result !== 'consider') throw new HttpError(409, 'not_consider', 'Adverse action is only for a report that came back “consider”.');
  const { confirm } = z.object({ confirm: z.literal(true) }).parse(req.body ?? {});
  void confirm;
  const settingsWait = Number(((await prisma.providerConnection.findUnique({ where: { id: conn.id }, select: { settings: true } }))?.settings as Record<string, unknown> | null)?.adverseWaitDays);
  const waitDays = Number.isFinite(settingsWait) && settingsWait >= 5 ? settingsWait : DEFAULT_ADVERSE_WAIT_DAYS;
  try {
    const until = await startPreAdverse(conn, c.id, waitDays);
    bgAudit(req, c, 'compliance.background_pre_adverse', { waitUntil: until.toISOString() });
  } catch (err) {
    await rememberCheckError(c.id, err);
    asHttp(err);
  }
  res.json(await checkView(req));
});

providerActionsRouter.post('/background/:id/adverse', COMPLIANCE, async (req, res) => {
  const c = await checkFor(req);
  if (c.adjudication !== 'PRE_ADVERSE') throw new HttpError(409, 'no_pre_adverse', 'Send the pre-adverse notice first.');
  if (!c.adverseWaitUntil || c.adverseWaitUntil.getTime() > Date.now()) {
    throw new HttpError(409, 'waiting_period', 'The person still has time to respond to the pre-adverse notice.');
  }
  z.object({ confirm: z.literal(true) }).parse(req.body ?? {});
  // Providers that run the notices (Checkr) send the final notice on the
  // scheduled date themselves; this records the decision either way.
  await prisma.backgroundCheck.update({ where: { id: c.id }, data: { adjudication: 'ADVERSE', adverseSentAt: new Date(), status: 'FAILED', completedAt: new Date() } });
  bgAudit(req, c, 'compliance.background_adverse');
  res.json(await checkView(req));
});

providerActionsRouter.post('/background/:id/withdraw', COMPLIANCE, async (req, res) => {
  const c = await checkFor(req);
  const conn = await connectionOr409('BACKGROUND_CHECK');
  try {
    await cancelAdverse(conn, c.id);
    bgAudit(req, c, 'compliance.background_adverse_withdrawn');
  } catch (err) {
    await rememberCheckError(c.id, err);
    asHttp(err);
  }
  res.json(await checkView(req));
});

/* ----- Drug tests ------------------------------------------------------------ */

async function testFor(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const t = await prisma.drugTest.findFirst({ where: scopeWhere<Prisma.DrugTestWhereInput>({ id, tenantId: tenantIdForWrite() }, scopeDrugTests(req.user!)) });
  if (!t) throw new HttpError(404, 'not_found', 'Drug test not found.');
  return t;
}

async function testView(req: Request) {
  const t = await testFor(req);
  const conn = await activeConnection('DRUG_TEST');
  return {
    id: t.id,
    connected: conn ? { provider: conn.provider, label: providerInfo(conn.provider)?.label ?? conn.provider, environment: conn.environment } : null,
    ordered: !!t.externalId,
    provider: t.provider,
    panelCode: t.panelCode,
    reason: t.reason,
    donorPassUrl: t.donorPassUrl,
    donorPassExpiresAt: t.donorPassExpiresAt?.toISOString() ?? null,
    collectionSite: t.collectionSite,
    status: t.status,
    rawStatus: t.rawStatus,
    resultCode: t.resultCode,
    mroVerifiedAt: t.mroVerifiedAt?.toISOString() ?? null,
    lastSyncAt: t.lastSyncAt?.toISOString() ?? null,
    ...failureFields(t.lastError, providerInfo(t.provider ?? '')?.label ?? 'The drug-test provider', 'DRUG_TEST'),
  };
}

providerActionsRouter.get('/drug-tests/:id', COMPLIANCE_VIEW, async (req, res) => {
  res.json(await testView(req));
});

const REASONS = ['PRE_EMPLOYMENT', 'RANDOM', 'POST_ACCIDENT', 'REASONABLE_SUSPICION', 'RETURN_TO_DUTY', 'FOLLOW_UP'] as const;

providerActionsRouter.post('/drug-tests/:id/order', COMPLIANCE, async (req, res) => {
  const t = await testFor(req);
  const conn = await connectionOr409('DRUG_TEST');
  const body = z.object({ panel: z.string().trim().max(40).optional(), reason: z.enum(REASONS).optional() }).parse(req.body ?? {});
  try {
    await orderDrugTest(conn, t.id, body);
    void recordComplianceEvent({ actorUserId: req.user!.id, action: 'compliance.drug_test_ordered', entityType: 'DrugTest', entityId: t.id, associateId: t.associateId, metadata: { provider: conn.provider, reason: body.reason ?? 'PRE_EMPLOYMENT' }, req });
  } catch (err) {
    if (err instanceof ProviderError) await prisma.drugTest.update({ where: { id: t.id }, data: { lastError: err.message.slice(0, 500) } }).catch(() => undefined);
    asHttp(err);
  }
  res.json(await testView(req));
});

providerActionsRouter.post('/drug-tests/:id/refresh', COMPLIANCE, async (req, res) => {
  const t = await testFor(req);
  const conn = await connectionOr409('DRUG_TEST');
  if (!t.externalId) throw new HttpError(409, 'not_ordered', 'This test hasn’t been ordered through the provider.');
  try {
    await refreshDrugTest(conn, t.id, t.externalId);
  } catch (err) {
    if (err instanceof ProviderError) await prisma.drugTest.update({ where: { id: t.id }, data: { lastError: err.message.slice(0, 500) } }).catch(() => undefined);
    asHttp(err);
  }
  res.json(await testView(req));
});

/* ----- Tax filing -------------------------------------------------------------- */

async function formView(id: string) {
  const f = await prisma.taxForm.findFirst({
    where: { id, tenantId: tenantIdForWrite() },
    select: { id: true, status: true, efileStatus: true, efileSubmissionId: true, efileSubmittedAt: true, efileStatusAt: true, efileRejectionReason: true, filingConfirmation: true, filedAt: true },
  });
  if (!f) throw new HttpError(404, 'not_found', 'Form not found.');
  return {
    ...f,
    efileSubmittedAt: f.efileSubmittedAt?.toISOString() ?? null,
    efileStatusAt: f.efileStatusAt?.toISOString() ?? null,
    filedAt: f.filedAt?.toISOString() ?? null,
  };
}

providerActionsRouter.post('/tax-forms/:id/efile', PAYROLL, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await formView(id);
  const conn = await connectionOr409('TAX_FILING');
  try {
    const r = await efileTaxForm(conn, id, req.user!.id);
    enqueueAudit({ actorUserId: req.user!.id, action: 'tax_form.efiled', entityType: 'TaxForm', entityId: id, metadata: { provider: conn.provider, status: r.status } }, 'providerActions');
  } catch (err) {
    asHttp(err);
  }
  res.json(await formView(id));
});

providerActionsRouter.post('/tax-forms/:id/refresh', PAYROLL, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await formView(id);
  const conn = await connectionOr409('TAX_FILING');
  try {
    await refreshFiling(conn, id);
  } catch (err) {
    asHttp(err);
  }
  res.json(await formView(id));
});
