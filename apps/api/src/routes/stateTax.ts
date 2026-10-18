import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertAssociateInScope, scopeActiveAssociates, scopeWhere } from '../lib/scope.js';
import {
  computeStateIncomeTax,
  primeStateAcknowledgments,
  stateCoverageOf,
  type PayFrequency,
} from '../lib/payrollTax.js';
import { MD_COUNTY_RATES_2025, STATE_SPECS } from '../lib/stateWithholding.js';
import type { SessionUser } from '../types/express.js';

/**
 * State withholding coverage (TAXCOMP 2026-10).
 *
 *   GET  /payroll/state-tax/coverage            every state + DC: verified,
 *        acknowledged, awaiting review, or not covered — with the people
 *        working there and the source each added state was read from
 *   POST /payroll/state-tax/:state/acknowledge  "reviewed with our tax adviser"
 *   DELETE …/acknowledge                         take it back (the state blocks again)
 *   GET  /payroll/state-tax/calculate           the per-period figure for a
 *        wage — what a reviewer checks against the state's own calculator
 *   GET|PUT /payroll/state-w4/:associateId       the state certificate (HR)
 *   GET|PUT /me/state-w4                         the worker's own certificate
 */

export const stateTaxRouter = Router();

const VIEW = requireCapability('process:payroll');

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const StateParam = z
  .string()
  .length(2)
  .transform((s) => s.toUpperCase())
  .refine((s) => s in STATE_NAMES, 'Not a US state.');

stateTaxRouter.get('/payroll/state-tax/coverage', VIEW, async (req, res) => {
  await primeStateAcknowledgments(prisma);
  const tenantId = tenantIdForWrite();
  const [acks, people] = await Promise.all([
    prisma.stateTaxAcknowledgment.findMany({ where: { tenantId } }),
    prisma.associate.groupBy({
      by: ['state'],
      where: scopeWhere(scopeActiveAssociates(req.user!), { employmentType: 'W2_EMPLOYEE' }),
      _count: { _all: true },
    }),
  ]);
  const ackBy = new Map(acks.map((a) => [a.state, a]));
  const users = await prisma.user.findMany({
    where: { id: { in: acks.map((a) => a.acknowledgedById).filter((x): x is string => !!x) } },
    select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName || u.email]));
  const peopleBy = new Map(people.map((p) => [(p.state ?? '').toUpperCase(), p._count._all]));
  const states = Object.entries(STATE_NAMES)
    .map(([code, name]) => {
      const spec = STATE_SPECS[code];
      const ack = ackBy.get(code);
      return {
        state: code,
        name,
        coverage: stateCoverageOf(code),
        people: peopleBy.get(code) ?? 0,
        taxYear: spec?.taxYear ?? null,
        confidence: spec?.confidence ?? null,
        source: spec?.source ?? null,
        notes: spec?.notes ?? null,
        form: spec?.form ?? null,
        acknowledgment: ack
          ? { taxYear: ack.taxYear, at: ack.acknowledgedAt.toISOString(), by: ack.acknowledgedById ? (nameOf.get(ack.acknowledgedById) ?? null) : null, note: ack.note, current: ack.taxYear === spec?.taxYear }
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    states,
    counts: {
      verified: states.filter((s) => s.coverage === 'verified').length,
      acknowledged: states.filter((s) => s.coverage === 'acknowledged').length,
      awaitingReview: states.filter((s) => s.coverage === 'awaiting_review').length,
      blockedPeople: states.filter((s) => s.coverage === 'awaiting_review' || s.coverage === 'none').reduce((n, s) => n + s.people, 0),
    },
  });
});

/** For the Inbox: added states awaiting review where W-2 people in reach work. */
export async function stateTablesAwaitingReview(user: SessionUser): Promise<number> {
  await primeStateAcknowledgments(prisma);
  const people = await prisma.associate.groupBy({
    by: ['state'],
    where: scopeWhere(scopeActiveAssociates(user), { employmentType: 'W2_EMPLOYEE' }),
    _count: { _all: true },
  });
  return people.filter((p) => p.state && stateCoverageOf(p.state) === 'awaiting_review').length;
}

stateTaxRouter.post('/payroll/state-tax/:state/acknowledge', VIEW, async (req, res) => {
  const state = StateParam.parse(req.params.state);
  const spec = STATE_SPECS[state];
  if (!spec) throw new HttpError(409, 'not_reviewable', `${STATE_NAMES[state]} doesn’t need a review — its withholding is already verified or it has no income tax.`);
  const body = z
    .object({ confirm: z.literal(true), note: z.string().trim().max(500).optional() })
    .safeParse(req.body ?? {});
  if (!body.success) throw new HttpError(400, 'confirm_required', 'Confirm the tables were reviewed with your tax adviser.');
  const tenantId = tenantIdForWrite();
  const ack = await prisma.stateTaxAcknowledgment.upsert({
    where: { tenantId_state_taxYear: { tenantId, state, taxYear: spec.taxYear } },
    create: { tenantId, state, taxYear: spec.taxYear, acknowledgedById: req.user!.id, note: body.data.note ?? null },
    update: { acknowledgedById: req.user!.id, acknowledgedAt: new Date(), note: body.data.note ?? null },
  });
  await recordCriticalAudit(
    {
      actorUserId: req.user!.id,
      action: 'payroll.state_tax_acknowledged',
      entityType: 'StateTaxAcknowledgment',
      entityId: ack.id,
      metadata: { state, taxYear: spec.taxYear, confidence: spec.confidence, source: spec.source, note: body.data.note ?? null },
    },
    'stateTax.acknowledge',
  );
  await primeStateAcknowledgments(prisma);
  res.json({ ok: true, state, taxYear: spec.taxYear });
});

stateTaxRouter.delete('/payroll/state-tax/:state/acknowledge', VIEW, async (req, res) => {
  const state = StateParam.parse(req.params.state);
  const tenantId = tenantIdForWrite();
  const removed = await prisma.stateTaxAcknowledgment.deleteMany({ where: { tenantId, state } });
  if (removed.count === 0) throw new HttpError(404, 'not_acknowledged', 'That state hasn’t been acknowledged.');
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.state_tax_acknowledgment_revoked', entityType: 'StateTaxAcknowledgment', entityId: state, metadata: { state } },
    'stateTax.revoke',
  );
  await primeStateAcknowledgments(prisma);
  res.status(204).end();
});

const CalcQuery = z.object({
  state: StateParam,
  wages: z.coerce.number().min(0).max(1_000_000),
  frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']).default('BIWEEKLY'),
  filingStatus: z.enum(['SINGLE', 'MARRIED', 'HEAD_OF_HOUSEHOLD']).default('SINGLE'),
  allowances: z.coerce.number().int().min(0).max(30).default(0),
  dependents: z.coerce.number().int().min(0).max(30).default(0),
  federal: z.coerce.number().min(0).max(1_000_000).default(0),
  county: z.string().max(40).optional(),
});

stateTaxRouter.get('/payroll/state-tax/calculate', VIEW, async (req, res) => {
  const q = CalcQuery.parse(req.query);
  const perPeriod = computeStateIncomeTax({
    grossPay: q.wages,
    state: q.state,
    payFrequency: q.frequency as PayFrequency,
    stateW4: { filingStatus: q.filingStatus, allowances: q.allowances, dependents: q.dependents, additionalWithholding: 0, exempt: false, county: q.county ?? null },
    federalFilingStatus: null,
    federalCycleWithholding: q.federal,
  });
  res.json({ state: q.state, perPeriod, coverage: stateCoverageOf(q.state) });
});

/* ----- State withholding certificates ------------------------------------ */

const CertificateInput = z.object({
  state: StateParam,
  filingStatus: z.enum(['SINGLE', 'MARRIED', 'HEAD_OF_HOUSEHOLD']),
  allowances: z.number().int().min(0).max(30),
  dependents: z.number().int().min(0).max(30).default(0),
  additionalWithholding: z.number().min(0).max(5_000).default(0),
  exempt: z.boolean().default(false),
  county: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional()
    .refine((c) => !c || c.toUpperCase() in MD_COUNTY_RATES_2025, 'Pick a Maryland county from the list.'),
});

const certView = (c: {
  state: string;
  filingStatus: string;
  allowances: number;
  dependents: number;
  additionalWithholding: { toString(): string };
  exempt: boolean;
  county: string | null;
  signedAt: Date | null;
}) => ({
  state: c.state,
  stateName: STATE_NAMES[c.state] ?? c.state,
  form: STATE_SPECS[c.state]?.form ?? null,
  filingStatus: c.filingStatus,
  allowances: c.allowances,
  dependents: c.dependents,
  additionalWithholding: Number(c.additionalWithholding),
  exempt: c.exempt,
  county: c.county,
  signedAt: c.signedAt ? c.signedAt.toISOString() : null,
});

async function saveCertificate(associateId: string, input: z.infer<typeof CertificateInput>, actorId: string) {
  const data = {
    filingStatus: input.filingStatus,
    allowances: input.allowances,
    dependents: input.dependents,
    additionalWithholding: input.additionalWithholding,
    exempt: input.exempt,
    county: input.state === 'MD' ? (input.county?.toUpperCase() ?? null) : null,
    signedAt: new Date(),
    updatedById: actorId,
  };
  const row = await prisma.associateStateW4.upsert({
    where: { associateId_state: { associateId, state: input.state } },
    create: { associateId, state: input.state, tenantId: tenantIdForWrite(), ...data },
    update: data,
  });
  await recordCriticalAudit(
    {
      actorUserId: actorId,
      action: 'payroll.state_w4_saved',
      entityType: 'AssociateStateW4',
      entityId: row.id,
      metadata: { associateId, state: input.state, filingStatus: input.filingStatus, allowances: input.allowances, exempt: input.exempt },
    },
    'stateTax.certificate',
  );
  return row;
}

/** The states with their own certificate, for the pickers. */
stateTaxRouter.get('/payroll/state-w4-forms', requireAuth, (_req, res) => {
  res.json({
    forms: Object.values(STATE_SPECS)
      .filter((s) => s.form)
      .map((s) => ({ state: s.state, name: s.name, form: s.form })),
    marylandCounties: Object.keys(MD_COUNTY_RATES_2025).sort(),
  });
});

stateTaxRouter.get('/payroll/state-w4/:associateId', VIEW, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const [rows, who] = await Promise.all([
    prisma.associateStateW4.findMany({ where: { associateId }, orderBy: { state: 'asc' } }),
    prisma.associate.findUnique({ where: { id: associateId }, select: { state: true } }),
  ]);
  res.json({ workState: who?.state?.toUpperCase() ?? null, certificates: rows.map(certView) });
});

stateTaxRouter.put('/payroll/state-w4/:associateId', VIEW, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const input = CertificateInput.parse(req.body ?? {});
  const row = await saveCertificate(associateId, input, req.user!.id);
  res.json({ certificate: certView(row) });
});

stateTaxRouter.get('/me/state-w4', requireAuth, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(404, 'no_person_record', 'Your account has no person record.');
  const [rows, me] = await Promise.all([
    prisma.associateStateW4.findMany({ where: { associateId }, orderBy: { state: 'asc' } }),
    prisma.associate.findUnique({ where: { id: associateId }, select: { state: true } }),
  ]);
  const workState = me?.state?.toUpperCase() ?? null;
  res.json({
    workState,
    // The certificate the person's work state asks for, if it has its own.
    needed: workState && STATE_SPECS[workState]?.form ? { state: workState, name: STATE_NAMES[workState], form: STATE_SPECS[workState]!.form } : null,
    certificates: rows.map(certView),
  });
});

stateTaxRouter.put('/me/state-w4', requireAuth, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(404, 'no_person_record', 'Your account has no person record.');
  const input = CertificateInput.parse(req.body ?? {});
  const row = await saveCertificate(associateId, input, req.user!.id);
  res.json({ certificate: certView(row) });
});
