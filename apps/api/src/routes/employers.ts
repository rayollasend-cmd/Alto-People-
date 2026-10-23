import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { scopeActiveAssociates } from '../lib/scope.js';
import { enqueueAudit } from '../lib/audit.js';
import { defaultEmployerOrg, employmentHistory } from '../lib/employment.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-1b, step 4 — the employers of record and a person's employment.
 *
 *   GET   /admin/employers              every employer organization of the tenant
 *   POST  /admin/employers              a third-party employer of record
 *   PATCH /admin/employers/:id          the legal facts (name, EIN, address, SUTA)
 *   GET   /org/associates/:id/employment   the person's spells, newest first
 */
export const employersRouter = Router();

const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:org');

const FactsInput = z.object({
  legalName: z.string().trim().min(1).max(255).optional(),
  ein: z.string().trim().regex(/^\d{2}-?\d{7}$/, 'EIN is nine digits').nullable().optional(),
  addressLine1: z.string().trim().max(255).nullable().optional(),
  addressLine2: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().length(2).toUpperCase().nullable().optional(),
  zip: z.string().trim().max(10).nullable().optional(),
  phone: z.string().trim().max(32).regex(/^[0-9+().\-\s]*$/, 'Use digits, spaces and + ( ) - only').nullable().optional(),
  wcCarrierName: z.string().trim().max(255).nullable().optional(),
  wcCarrierAddress: z.string().trim().max(500).nullable().optional(),
  wcCarrierPhone: z.string().trim().max(32).regex(/^[0-9+().\-\s]*$/, 'Use digits, spaces and + ( ) - only').nullable().optional(),
  wcPolicyNumber: z.string().trim().max(64).nullable().optional(),
  sutaRateOverride: z.number().min(0).max(1).nullable().optional(),
  sutaWageBaseOverride: z.number().min(0).nullable().optional(),
});

const view = (e: {
  id: string;
  kind: string;
  legalName: string;
  ein: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone?: string | null;
  wcCarrierName?: string | null;
  wcCarrierAddress?: string | null;
  wcCarrierPhone?: string | null;
  wcPolicyNumber?: string | null;
  sutaRateOverride: unknown;
  sutaWageBaseOverride: unknown;
  clientId: string | null;
  isDefault: boolean;
  client?: { name: string } | null;
  _count?: { employments: number };
}) => ({
  id: e.id,
  kind: e.kind,
  legalName: e.legalName,
  ein: e.ein,
  address: { line1: e.addressLine1, line2: e.addressLine2, city: e.city, state: e.state, zip: e.zip },
  phone: e.phone ?? null,
  workersComp: { carrier: e.wcCarrierName ?? null, address: e.wcCarrierAddress ?? null, phone: e.wcCarrierPhone ?? null, policyNumber: e.wcPolicyNumber ?? null },
  sutaRateOverride: e.sutaRateOverride == null ? null : Number(e.sutaRateOverride),
  sutaWageBaseOverride: e.sutaWageBaseOverride == null ? null : Number(e.sutaWageBaseOverride),
  clientId: e.clientId,
  clientName: e.client?.name ?? null,
  isDefault: e.isDefault,
  employments: e._count?.employments ?? 0,
});

employersRouter.get('/admin/employers', VIEW, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  await defaultEmployerOrg(prisma, tenantId);
  const rows = await prisma.employerOrganization.findMany({
    where: { tenantId },
    // People on the books (lib/peopleStatus: hired, not separated) with an
    // open spell here. An open spell left behind on someone separated or
    // removed made "People employed" read higher than the headcount.
    include: { client: { select: { name: true } }, _count: { select: { employments: { where: { endDate: null, associate: { deletedAt: null, erasedAt: null, separatedAt: null } } } } } },
    orderBy: [{ isDefault: 'desc' }, { kind: 'asc' }, { legalName: 'asc' }],
  });
  res.json({ employers: rows.map(view) });
});

employersRouter.post('/admin/employers', MANAGE, async (req, res) => {
  const input = FactsInput.extend({ legalName: z.string().trim().min(1).max(255) }).parse(req.body);
  const row = await prisma.employerOrganization.create({
    data: { tenantId: tenantIdForWrite(), kind: 'THIRD_PARTY', ...input },
    include: { client: { select: { name: true } } },
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'employer.created', entityType: 'EmployerOrganization', entityId: row.id, metadata: { legalName: row.legalName, ein: row.ein } }, 'employers');
  res.status(201).json({ employer: view(row) });
});

employersRouter.patch('/admin/employers/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = FactsInput.parse(req.body);
  const existing = await prisma.employerOrganization.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!existing) throw new HttpError(404, 'employer_not_found', 'No such employer.');
  const row = await prisma.employerOrganization.update({ where: { id }, data: input, include: { client: { select: { name: true } } } });
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: existing.clientId, action: 'employer.updated', entityType: 'EmployerOrganization', entityId: id, metadata: { changed: Object.keys(input), einChanged: input.ein !== undefined && input.ein !== existing.ein } },
    'employers',
  );
  res.json({ employer: view(row) });
});

// HR reads it; so does the onboarding desk (manage:onboarding — the
// recruiter opens the spell it approved, owner 2026-10-23), for the people
// in its reach.
employersRouter.get('/org/associates/:id/employment', requireAnyCapability('view:hr-admin', 'manage:onboarding'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  // The person must be this tenant's and in the caller's reach; anyone else does not exist here.
  const person = await prisma.associate.findFirst({ where: { AND: [{ id }, scopeActiveAssociates(req.user!, { former: true })] }, select: { id: true } });
  if (!person) throw new HttpError(404, 'associate_not_found', 'No such associate.');
  const rows = await employmentHistory(prisma, id);
  res.json({
    employment: rows.map((e) => ({
      id: e.id,
      employer: { id: e.employer.id, kind: e.employer.kind, legalName: e.employer.legalName, ein: e.employer.ein, clientId: e.employer.clientId },
      employmentType: e.employmentType,
      hireDate: e.hireDate.toISOString().slice(0, 10),
      endDate: e.endDate ? e.endDate.toISOString().slice(0, 10) : null,
      applicationId: e.applicationId,
      site: e.site,
    })),
  });
});
