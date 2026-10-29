import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { dateColumnKey } from '../lib/timezone.js';
import { assertAssociateInScope, scopeActiveAssociates, scopePayrollRuns, scopeWhere } from '../lib/scope.js';
import { PROVIDERS } from '../lib/providers/catalog.js';
import type { PayFrequency } from '../lib/payrollTax.js';
import {
  CONVENIENCE_OF_EMPLOYER,
  LOCAL_JURISDICTIONS,
  RECIPROCITY,
  RECIPROCITY_SOURCE,
  calculateInHouse,
  localAwaitingReview,
  localJurisdiction,
  primeLocalAcknowledgments,
  unresolvedText,
  type EmployeePeriodInput,
  type LocalJurisdiction,
} from '../lib/taxEngine/index.js';
import type { SessionUser } from '../types/express.js';

/**
 * Local and multi-state taxes (lib/taxEngine).
 *
 *   GET    /payroll/tax-jurisdictions                  every local jurisdiction Alto
 *          knows: review status, rate and source, the people it applies to
 *   POST   /payroll/tax-jurisdictions/:code/acknowledge  "reviewed with our tax adviser"
 *   DELETE /payroll/tax-jurisdictions/:code/acknowledge  take it back (runs block again)
 *   GET    /payroll/tax-jurisdictions/calculate         a paycheck's taxes in one place
 *   GET    /payroll/tax-reciprocity                     the reciprocity table
 *   GET|PUT /payroll/tax-profile/:associateId           home jurisdictions + the taxes we withhold and why
 *   POST   /payroll/tax-profile/:associateId/certificates   a state or local certificate
 *   DELETE /payroll/tax-profile/:associateId/certificates/:id  revoke it
 *   GET    /payroll/runs/:id/tax-lines                  the run's taxes by jurisdiction
 *
 * Everything needs process:payroll, like state tax coverage.
 */
export const taxJurisdictionsRouter = Router();

const PAYROLL = requireCapability('process:payroll');

const CodeParam = z
  .string()
  .max(40)
  .refine((c) => !!localJurisdiction(c), 'Not a known jurisdiction.');

const PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  state: true,
  city: true,
  zip: true,
  employmentType: true,
  localTaxRule: { select: { name: true, isActive: true } },
  taxProfile: { select: { residentPsdCode: true, residentMunicipality: true, residentSchoolDistrict: true, residentCountyJan1: true, residentLocalCode: true, notes: true, updatedAt: true } },
  taxCertificates: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, state: true, jurisdictionCode: true, formName: true, signedOn: true, effectiveFrom: true, data: true, createdAt: true } },
  assignments: { where: { endedAt: null }, select: { location: { select: { name: true, state: true, city: true, zip: true } } } },
} satisfies Prisma.AssociateSelect;

type ProfileRow = Prisma.AssociateGetPayload<{ select: typeof PROFILE_SELECT }>;

/** The engine's view of a person: home from their address and profile, work from their open assignments. */
function probeFor(a: ProfileRow, wages = 2000): ReturnType<typeof calculateInHouse> {
  const p = a.taxProfile;
  const work = a.assignments.filter((x) => x.location).map((x) => ({ state: x.location.state ?? a.state, city: x.location.city, zip: x.location.zip, hours: 1 }));
  const input: EmployeePeriodInput = {
    wages,
    payFrequency: 'BIWEEKLY',
    residence: {
      state: a.state,
      city: a.city,
      zip: a.zip,
      psdCode: p?.residentPsdCode,
      municipality: p?.residentMunicipality,
      schoolDistrict: p?.residentSchoolDistrict,
      countyJan1: p?.residentCountyJan1,
      localCode: p?.residentLocalCode,
    },
    work: work.length > 0 ? work : [{ state: a.state, city: a.city, hours: 1 }],
    certificates: a.taxCertificates,
    federalFilingStatus: null,
    federalCycleWithholding: 0,
    stateW4s: {},
  };
  return calculateInHouse(input);
}

function rateText(j: LocalJurisdiction): string {
  const pct = (r: number) => `${(r * 100).toFixed(r * 100 < 1 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '')}%`;
  if (j.annualAmount) return `$${j.annualAmount} a year${j.lowIncomeExemptBelow ? `, exempt under $${j.lowIncomeExemptBelow.toLocaleString('en-US')}` : ''}`;
  if (j.shareOfState) return `${pct(j.shareOfState)} of state tax (residents)${j.nonresidentRate ? `, ${pct(j.nonresidentRate)} nonresidents` : ''}`;
  if (j.residentBrackets) return 'Graduated rates (residents)';
  const r = j.residentRate ?? 0;
  const n = j.nonresidentRate ?? 0;
  if (j.basis === 'EMPLOYER_PAYROLL') return `${pct(n)} employer-paid`;
  if (r && n && r !== n) return `${pct(r)} residents, ${pct(n)} nonresidents`;
  return pct(r || n);
}

async function ackRows(tenantId: string) {
  const acks = await prisma.localTaxAcknowledgment.findMany({ where: { tenantId } });
  const users = await prisma.user.findMany({
    where: { id: { in: acks.map((a) => a.acknowledgedById).filter((x): x is string => !!x) } },
    select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName || u.email]));
  return new Map(acks.map((a) => [a.jurisdictionCode, { ...a, by: a.acknowledgedById ? (nameOf.get(a.acknowledgedById) ?? null) : null }]));
}

taxJurisdictionsRouter.get('/payroll/tax-jurisdictions', PAYROLL, async (req, res) => {
  const tenantId = tenantIdForWrite();
  await primeLocalAcknowledgments(prisma);
  const [acks, people, engineRow] = await Promise.all([
    ackRows(tenantId),
    prisma.associate.findMany({ where: scopeWhere(scopeActiveAssociates(req.user!), { employmentType: 'W2_EMPLOYEE' }), select: PROFILE_SELECT }),
    prisma.providerConnection.findFirst({ where: { tenantId, kind: 'TAX_ENGINE', active: true }, orderBy: { createdAt: 'desc' }, select: { provider: true, environment: true } }),
  ]);
  const workersBy = new Map<string, Set<string>>();
  const unresolved: Array<{ associateId: string; name: string; questions: string[] }> = [];
  for (const a of people) {
    const probe = probeFor(a);
    if (a.localTaxRule?.isActive) continue; // set by hand; the engine's locals don't apply
    const codes = new Set(probe.lines.filter((l) => l.kind !== 'STATE' && l.kind !== 'SUI').map((l) => l.code));
    for (const c of codes) {
      if (!workersBy.has(c)) workersBy.set(c, new Set());
      workersBy.get(c)!.add(a.id);
    }
    if (probe.unresolved.length > 0) unresolved.push({ associateId: a.id, name: `${a.firstName} ${a.lastName}`.trim(), questions: probe.unresolved.map(unresolvedText) });
  }
  const jurisdictions = LOCAL_JURISDICTIONS.map((j) => {
    const ack = acks.get(j.code);
    const workers = workersBy.get(j.code)?.size ?? 0;
    return {
      code: j.code,
      state: j.state,
      name: j.name,
      kind: j.kind,
      basis: j.basis,
      rate: rateText(j),
      residentRate: j.residentRate ?? null,
      nonresidentRate: j.nonresidentRate ?? null,
      annualAmount: j.annualAmount ?? null,
      administeredBy: j.administeredBy ?? null,
      taxYear: j.taxYear,
      source: j.source,
      confidence: j.confidence,
      note: j.note ?? null,
      workers,
      review: ack
        ? { status: ack.taxYear === j.taxYear ? ('reviewed' as const) : ('outdated' as const), taxYear: ack.taxYear, at: ack.acknowledgedAt.toISOString(), by: ack.by, note: ack.note }
        : { status: 'awaiting' as const, taxYear: null, at: null, by: null, note: null },
    };
  }).sort((a, b) => b.workers - a.workers || a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  const inUse = jurisdictions.filter((j) => j.workers > 0);
  const blocked = new Set<string>();
  for (const j of inUse) if (j.review.status !== 'reviewed') for (const id of workersBy.get(j.code) ?? []) blocked.add(id);
  const provider = engineRow ? PROVIDERS.find((p) => p.id === engineRow.provider) : null;
  res.json({
    engine: engineRow ? { key: engineRow.provider, label: provider?.label ?? engineRow.provider, environment: engineRow.environment } : { key: 'IN_HOUSE', label: 'Built-in engine', environment: null },
    jurisdictions,
    counts: {
      inUse: inUse.length,
      awaitingInUse: inUse.filter((j) => j.review.status !== 'reviewed').length,
      reviewed: jurisdictions.filter((j) => j.review.status === 'reviewed').length,
      blockedWorkers: blocked.size,
      unresolvedWorkers: unresolved.length,
    },
    unresolved: unresolved.slice(0, 100),
  });
});

/** For the Inbox: local jurisdictions in use that nobody has reviewed. */
export async function localJurisdictionsAwaitingReview(user: SessionUser): Promise<number> {
  await primeLocalAcknowledgments(prisma);
  const people = await prisma.associate.findMany({ where: scopeWhere(scopeActiveAssociates(user), { employmentType: 'W2_EMPLOYEE' }), select: PROFILE_SELECT });
  const codes = new Set<string>();
  for (const a of people) if (!a.localTaxRule?.isActive) for (const c of probeFor(a).jurisdictionsUsed) if (localAwaitingReview(c)) codes.add(c);
  return codes.size;
}

taxJurisdictionsRouter.post('/payroll/tax-jurisdictions/:code/acknowledge', PAYROLL, async (req, res) => {
  const code = CodeParam.parse(req.params.code);
  const j = localJurisdiction(code)!;
  const body = z.object({ confirm: z.literal(true), note: z.string().trim().max(500).optional() }).safeParse(req.body ?? {});
  if (!body.success) throw new HttpError(400, 'confirm_required', 'Confirm the rate was reviewed with your tax adviser.');
  const tenantId = tenantIdForWrite();
  const ack = await prisma.localTaxAcknowledgment.upsert({
    where: { tenantId_jurisdictionCode_taxYear: { tenantId, jurisdictionCode: code, taxYear: j.taxYear } },
    create: { tenantId, jurisdictionCode: code, taxYear: j.taxYear, acknowledgedById: req.user!.id, note: body.data.note ?? null },
    update: { acknowledgedById: req.user!.id, acknowledgedAt: new Date(), note: body.data.note ?? null },
  });
  await recordCriticalAudit(
    {
      actorUserId: req.user!.id,
      action: 'payroll.local_tax_acknowledged',
      entityType: 'LocalTaxAcknowledgment',
      entityId: ack.id,
      metadata: { jurisdiction: code, taxYear: j.taxYear, confidence: j.confidence, source: j.source, note: body.data.note ?? null },
    },
    'taxJurisdictions.acknowledge',
  );
  await primeLocalAcknowledgments(prisma);
  res.json({ ok: true, code, taxYear: j.taxYear });
});

taxJurisdictionsRouter.delete('/payroll/tax-jurisdictions/:code/acknowledge', PAYROLL, async (req, res) => {
  const code = CodeParam.parse(req.params.code);
  const removed = await prisma.localTaxAcknowledgment.deleteMany({ where: { tenantId: tenantIdForWrite(), jurisdictionCode: code } });
  if (removed.count === 0) throw new HttpError(404, 'not_acknowledged', 'That jurisdiction hasn’t been reviewed.');
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.local_tax_acknowledgment_revoked', entityType: 'LocalTaxAcknowledgment', entityId: code, metadata: { jurisdiction: code } },
    'taxJurisdictions.revoke',
  );
  await primeLocalAcknowledgments(prisma);
  res.status(204).end();
});

const CalcQuery = z.object({
  code: CodeParam,
  wages: z.coerce.number().min(0).max(1_000_000),
  frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']).default('BIWEEKLY'),
  resident: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

/**
 * One paycheck's state and local taxes for a worker who lives (or only
 * works) in a jurisdiction — what a reviewer checks against the
 * jurisdiction's own calculator before acknowledging it.
 */
taxJurisdictionsRouter.get('/payroll/tax-jurisdictions/calculate', PAYROLL, async (req, res) => {
  const q = CalcQuery.parse(req.query);
  const j = localJurisdiction(q.code)!;
  const city = j.cities?.[0] ?? null;
  const county = j.counties?.[0] ?? null;
  const place = { state: j.state, city, county };
  const result = calculateInHouse({
    wages: q.wages,
    payFrequency: q.frequency as PayFrequency,
    residence: q.resident
      ? { ...place, psdCode: j.psdCodes?.[0] ?? null, countyJan1: county, schoolDistrict: j.kind === 'SCHOOL' && j.state === 'OH' ? j.code.replace('OH-SD-', '') : null, localCode: j.code }
      : { state: null, city: null },
    work: [{ ...place, hours: 1 }],
    certificates: [],
    federalFilingStatus: null,
    federalCycleWithholding: 0,
    stateW4s: {},
  });
  res.json({
    code: j.code,
    resident: q.resident,
    wages: q.wages,
    frequency: q.frequency,
    lines: result.lines.filter((l) => l.kind !== 'SUI'),
    localTotal: result.localTotal,
    stateTotal: result.stateTotal,
    employerLocalTotal: result.employerLocalTotal,
    unresolved: result.unresolved.map(unresolvedText),
  });
});

taxJurisdictionsRouter.get('/payroll/tax-reciprocity', PAYROLL, (_req, res) => {
  res.json({
    source: RECIPROCITY_SOURCE,
    agreements: Object.entries(RECIPROCITY)
      .map(([workState, r]) => ({ workState, residentStates: r.states, form: r.form }))
      .sort((a, b) => a.workState.localeCompare(b.workState)),
    convenienceOfEmployer: Object.entries(CONVENIENCE_OF_EMPLOYER).map(([state, name]) => ({ state, name })),
  });
});

/* ----- A person's tax setup ------------------------------------------------- */

const CERT_KINDS = ['NONRESIDENCY', 'LST_EXEMPTION', 'PA_RESIDENCY', 'OH_IT4', 'NY_LOCAL'] as const;

function profileView(a: ProfileRow) {
  const probe = probeFor(a);
  const manual = !!a.localTaxRule?.isActive;
  const lines = probe.lines.filter((l) => (manual ? l.kind === 'STATE' || l.kind === 'SUI' : true));
  const withholding = lines.map((l) => {
    const j = localJurisdiction(l.code);
    const why =
      l.kind === 'SUI'
        ? (l.note ?? '')
        : l.kind === 'STATE'
          ? l.resident
            ? `Lives in ${l.code.slice(3)}.`
            : `Works in ${l.workState}.`
          : l.resident
            ? `Lives in ${j?.name.replace(/ (earned income|wage|income|occupational license) tax.*$/i, '') ?? 'this jurisdiction'}.`
            : `Works in ${j?.cities?.[0] ? j.cities[0].replace(/\b\w/g, (c) => c.toUpperCase()) : (j?.name ?? 'this jurisdiction')}.`;
    return {
      code: l.code,
      kind: l.kind,
      label: l.label,
      resident: l.resident,
      employer: l.employer,
      rate: j ? rateText(j) : null,
      why,
      note: l.kind === 'SUI' ? null : l.note,
      review: j ? (localAwaitingReview(l.code) ? 'awaiting' : 'reviewed') : null,
    };
  });
  if (manual) {
    withholding.push({ code: 'LOCAL_RULE', kind: 'LOCAL', label: a.localTaxRule!.name, resident: true, employer: false, rate: null, why: 'Set by hand on this person; it replaces the local taxes the engine would work out.', note: null, review: null });
  }
  return {
    associateId: a.id,
    name: `${a.firstName} ${a.lastName}`.trim(),
    employmentType: a.employmentType,
    home: { state: a.state, city: a.city, zip: a.zip },
    workSites: a.assignments.map((x) => ({ name: x.location.name, state: x.location.state, city: x.location.city })),
    profile: a.taxProfile
      ? { ...a.taxProfile, updatedAt: a.taxProfile.updatedAt.toISOString() }
      : { residentPsdCode: null, residentMunicipality: null, residentSchoolDistrict: null, residentCountyJan1: null, residentLocalCode: null, notes: null, updatedAt: null },
    certificates: a.taxCertificates.map((c) => ({
      ...c,
      signedOn: c.signedOn ? dateColumnKey(c.signedOn) : null,
      effectiveFrom: c.effectiveFrom ? dateColumnKey(c.effectiveFrom) : null,
      createdAt: c.createdAt.toISOString(),
    })),
    withholding,
    unresolved: manual ? [] : probe.unresolved.map(unresolvedText),
    manualLocalRule: manual ? a.localTaxRule!.name : null,
  };
}

async function loadProfile(associateId: string): Promise<ProfileRow> {
  const a = await prisma.associate.findUnique({ where: { id: associateId }, select: PROFILE_SELECT });
  if (!a) throw new HttpError(404, 'not_found', 'Associate not found.');
  return a;
}

taxJurisdictionsRouter.get('/payroll/tax-profile/:associateId', PAYROLL, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  await primeLocalAcknowledgments(prisma);
  res.json(profileView(await loadProfile(associateId)));
});

const ProfileInput = z.object({
  residentPsdCode: z.string().trim().regex(/^\d{6}$/, 'A PSD code is six digits.').nullable().optional(),
  residentMunicipality: z.string().trim().max(120).nullable().optional(),
  residentSchoolDistrict: z.string().trim().regex(/^\d{4}$/, 'An Ohio school district number is four digits.').nullable().optional(),
  residentCountyJan1: z.string().trim().max(60).nullable().optional(),
  residentLocalCode: z.string().trim().max(40).refine((c) => !!localJurisdiction(c), 'Not a known jurisdiction.').nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

taxJurisdictionsRouter.put('/payroll/tax-profile/:associateId', PAYROLL, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const input = ProfileInput.parse(req.body ?? {});
  const data = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v === '' ? null : v])) as z.infer<typeof ProfileInput>;
  const row = await prisma.associateTaxProfile.upsert({
    where: { associateId },
    create: { associateId, tenantId: tenantIdForWrite(), ...data, updatedById: req.user!.id },
    update: { ...data, updatedById: req.user!.id },
  });
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.tax_profile_saved', entityType: 'AssociateTaxProfile', entityId: row.id, metadata: { associateId, ...data } },
    'taxJurisdictions.profile',
  );
  await primeLocalAcknowledgments(prisma);
  res.json(profileView(await loadProfile(associateId)));
});

const CertificateInput = z
  .object({
    kind: z.enum(CERT_KINDS),
    state: z.string().length(2).transform((s) => s.toUpperCase()),
    jurisdictionCode: z.string().max(40).nullable().optional(),
    formName: z.string().trim().max(80).nullable().optional(),
    signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    psdCode: z.string().trim().regex(/^\d{6}$/, 'A PSD code is six digits.').optional(),
    schoolDistrict: z.string().trim().regex(/^\d{4}$/, 'An Ohio school district number is four digits.').optional(),
    municipality: z.string().trim().max(120).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind === 'NONRESIDENCY' && !RECIPROCITY[c.state]) ctx.addIssue({ code: 'custom', path: ['state'], message: `${c.state} has no reciprocity agreement, so a nonresidency certificate doesn’t change its withholding.` });
    if (c.kind === 'PA_RESIDENCY' && !c.psdCode) ctx.addIssue({ code: 'custom', path: ['psdCode'], message: 'The residency certificate gives the home PSD code.' });
    if (c.jurisdictionCode && !localJurisdiction(c.jurisdictionCode)) ctx.addIssue({ code: 'custom', path: ['jurisdictionCode'], message: 'Not a known jurisdiction.' });
  });

const FORM_NAME: Record<(typeof CERT_KINDS)[number], (state: string) => string> = {
  NONRESIDENCY: (st) => RECIPROCITY[st]?.form ?? 'Nonresidency certificate',
  LST_EXEMPTION: () => 'LST exemption certificate',
  PA_RESIDENCY: () => 'PA residency certification',
  OH_IT4: () => 'Ohio IT 4',
  NY_LOCAL: () => 'IT-2104 (NYC / Yonkers)',
};

taxJurisdictionsRouter.post('/payroll/tax-profile/:associateId/certificates', PAYROLL, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const c = CertificateInput.parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const cert = await prisma.$transaction(async (tx) => {
    // A newer certificate of the same kind for the same place replaces the old one.
    await tx.associateTaxCertificate.updateMany({
      where: { associateId, kind: c.kind, state: c.state, jurisdictionCode: c.jurisdictionCode ?? null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const row = await tx.associateTaxCertificate.create({
      data: {
        tenantId,
        associateId,
        kind: c.kind,
        state: c.state,
        jurisdictionCode: c.jurisdictionCode ?? null,
        formName: c.formName ?? FORM_NAME[c.kind](c.state),
        signedOn: c.signedOn ? new Date(`${c.signedOn}T00:00:00Z`) : null,
        effectiveFrom: c.effectiveFrom ? new Date(`${c.effectiveFrom}T00:00:00Z`) : null,
        data: { psdCode: c.psdCode ?? null, schoolDistrict: c.schoolDistrict ?? null, municipality: c.municipality ?? null },
        recordedById: req.user!.id,
      },
    });
    // The certificates that answer a home-jurisdiction question also set it.
    const profile: Prisma.AssociateTaxProfileUncheckedUpdateInput = {};
    if (c.kind === 'PA_RESIDENCY') Object.assign(profile, { residentPsdCode: c.psdCode, ...(c.municipality ? { residentMunicipality: c.municipality } : {}) });
    if (c.kind === 'OH_IT4' && c.schoolDistrict) profile.residentSchoolDistrict = c.schoolDistrict;
    if (c.kind === 'NY_LOCAL' && c.jurisdictionCode) profile.residentLocalCode = c.jurisdictionCode;
    if (Object.keys(profile).length > 0) {
      await tx.associateTaxProfile.upsert({
        where: { associateId },
        create: { ...(profile as Omit<Prisma.AssociateTaxProfileUncheckedCreateInput, 'associateId'>), associateId, tenantId, updatedById: req.user!.id },
        update: { ...profile, updatedById: req.user!.id },
      });
    }
    return row;
  });
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.tax_certificate_recorded', entityType: 'AssociateTaxCertificate', entityId: cert.id, metadata: { associateId, kind: c.kind, state: c.state, jurisdictionCode: c.jurisdictionCode ?? null } },
    'taxJurisdictions.certificate',
  );
  await primeLocalAcknowledgments(prisma);
  res.status(201).json(profileView(await loadProfile(associateId)));
});

taxJurisdictionsRouter.delete('/payroll/tax-profile/:associateId/certificates/:id', PAYROLL, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  const id = z.string().uuid().parse(req.params.id);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const done = await prisma.associateTaxCertificate.updateMany({ where: { id, associateId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (done.count === 0) throw new HttpError(404, 'not_found', 'Certificate not found.');
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.tax_certificate_revoked', entityType: 'AssociateTaxCertificate', entityId: id, metadata: { associateId } },
    'taxJurisdictions.certificateRevoke',
  );
  res.status(204).end();
});

/* ----- A run's taxes by jurisdiction ---------------------------------------- */

taxJurisdictionsRouter.get('/payroll/runs/:id/tax-lines', PAYROLL, async (req, res) => {
  const runId = z.string().uuid().parse(req.params.id);
  const run = await prisma.payrollRun.findFirst({ where: scopeWhere<Prisma.PayrollRunWhereInput>({ id: runId }, scopePayrollRuns(req.user!)), select: { id: true } });
  if (!run) throw new HttpError(404, 'not_found', 'Payroll run not found.');
  const lines = await prisma.payrollItemTaxLine.findMany({
    where: { payrollItem: { payrollRunId: runId } },
    select: { code: true, kind: true, label: true, resident: true, workState: true, wages: true, amount: true, employer: true, note: true, payrollItem: { select: { associateId: true } } },
    orderBy: [{ kind: 'asc' }, { code: 'asc' }],
  });
  const groups = new Map<string, { code: string; kind: string; name: string; employer: boolean; wages: number; amount: number; people: Set<string> }>();
  for (const l of lines) {
    if (l.kind === 'SUI') continue;
    const name = localJurisdiction(l.code)?.name ?? l.label.replace(/ \((resident|nonresident|resident rate|work location rate|work county)\)$/, '');
    const g = groups.get(l.code) ?? { code: l.code, kind: l.kind, name, employer: l.employer, wages: 0, amount: 0, people: new Set<string>() };
    g.wages += Number(l.wages);
    g.amount += Number(l.amount);
    g.people.add(l.payrollItem.associateId);
    groups.set(l.code, g);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const jurisdictions = [...groups.values()]
    .map((g) => ({ code: g.code, kind: g.kind, name: g.name, employer: g.employer, wages: r2(g.wages), amount: r2(g.amount), people: g.people.size }))
    .sort((a, b) => (a.kind === 'STATE' ? 0 : 1) - (b.kind === 'STATE' ? 0 : 1) || b.amount - a.amount);
  res.json({
    jurisdictions,
    totals: {
      state: r2(jurisdictions.filter((j) => j.kind === 'STATE').reduce((s, j) => s + j.amount, 0)),
      local: r2(jurisdictions.filter((j) => j.kind !== 'STATE' && j.kind !== 'STATE_PROGRAM' && !j.employer).reduce((s, j) => s + j.amount, 0)),
      // State disability, paid-leave and employee unemployment contributions withheld (employer shares are in `employer`).
      programs: r2(jurisdictions.filter((j) => j.kind === 'STATE_PROGRAM' && !j.employer).reduce((s, j) => s + j.amount, 0)),
      employer: r2(jurisdictions.filter((j) => j.employer).reduce((s, j) => s + j.amount, 0)),
    },
  });
});
