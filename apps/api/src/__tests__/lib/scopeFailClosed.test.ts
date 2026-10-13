import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma, Role } from '@prisma/client';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import {
  scopeApplications,
  scopeAssociates,
  scopeClients,
  scopeDocuments,
  scopePayrollItems,
  scopePayrollRuns,
  scopeQualificationWrites,
  scopeShifts,
  scopeTimeEntries,
  scopeTimeOffRequests,
} from '../../lib/scope.js';
import type { SessionUser } from '../../types/express.js';

/**
 * Brief 2-1b, step 3 — the guardrail, written BEFORE the scope code changes
 * (the owner's ruling on risk 2).
 *
 *   When "Client" becomes optional, rows with no client exist. A client-
 *   bounded account (client portal, shift supervisor, floor supervisor)
 *   with no client of its own must then resolve to its TENANT and its
 *   SITE — and to nothing at all when it has neither. It must never fail
 *   open onto the rows whose client is null, and never onto another
 *   tenant's rows.
 *
 *   The checks run the scope filters against real rows, not against their
 *   shape, so a filter that happens to be `{ clientId: null }` is caught by
 *   the rows it matches.
 */

const BOUNDED: Role[] = ['CLIENT_PORTAL', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'];
const T2 = '22222222-2222-4222-8222-222222222222';

const sessionUser = (role: Role, overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: '00000000-0000-4000-8000-00000000aaaa',
  email: `${role.toLowerCase()}@example.com`,
  role,
  primaryRole: role,
  availableRoles: [role],
  status: 'ACTIVE',
  clientId: null,
  locationId: null,
  regionId: null,
  associateId: null,
  tokenVersion: 0,
  firstName: null,
  lastName: null,
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
  tenantId: ALTO_TENANT_ID,
  ...overrides,
});

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Tenant one's world: a client with two sites, rows at each, and rows with NO client at all. */
async function world() {
  const client = await createClient('Coastal Resort');
  const siteA = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const siteB = await prisma.site.create({ data: { clientId: client.id, name: 'Pier Park', timezone: 'America/Chicago' } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Site A' });
  const bo = await createAssociate({ firstName: 'Bo', lastName: 'Site B' });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: siteA.id, startedAt: new Date('2026-05-01') } });
  await prisma.associateAssignment.create({ data: { associateId: bo.id, locationId: siteB.id, startedAt: new Date('2026-05-01') } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const at = (h: number) => new Date(Date.now() + h * 3_600_000);
  const shiftA = await prisma.shift.create({ data: { clientId: client.id, locationId: siteA.id, position: 'Associate', startsAt: at(24), endsAt: at(32), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() } });
  const shiftB = await prisma.shift.create({ data: { clientId: client.id, locationId: siteB.id, position: 'Associate', startsAt: at(24), endsAt: at(32), status: 'ASSIGNED', assignedAssociateId: bo.id, publishedAt: new Date() } });
  const entryA = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: client.id, locationId: siteA.id, clockInAt: at(-9), clockOutAt: at(-1), status: 'APPROVED' } });
  const entryB = await prisma.timeEntry.create({ data: { associateId: bo.id, clientId: client.id, locationId: siteB.id, clockInAt: at(-9), clockOutAt: at(-1), status: 'APPROVED' } });
  // The rows the hotel will have: no client, a site (or not even that).
  const entryNoClientAtA = await prisma.timeEntry.create({ data: { associateId: ana.id, clientId: null, locationId: siteA.id, clockInAt: at(-20), clockOutAt: at(-12), status: 'APPROVED' } });
  const entryNoClientNoSite = await prisma.timeEntry.create({ data: { associateId: bo.id, clientId: null, locationId: null, clockInAt: at(-20), clockOutAt: at(-12), status: 'APPROVED' } });
  const docNoClient = await prisma.documentRecord.create({ data: { associateId: ana.id, clientId: null, kind: 'ID', filename: 'id.pdf', mimeType: 'application/pdf', size: 1 } });
  const docClient = await prisma.documentRecord.create({ data: { associateId: bo.id, clientId: client.id, kind: 'ID', filename: 'id2.pdf', mimeType: 'application/pdf', size: 1 } });
  const application = await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, locationId: siteA.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  const runNoClient = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status: 'DRAFT', createdById: hr.id, clientId: null } });
  const runClient = await prisma.payrollRun.create({ data: { periodStart: new Date('2026-09-26'), periodEnd: new Date('2026-10-09'), status: 'DRAFT', createdById: hr.id, clientId: client.id } });
  const qualNoClient = await prisma.qualification.create({ data: { code: 'FOOD', name: 'Food handler', clientId: null } });
  const qualClient = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift', clientId: client.id } });
  const timeOffA = await prisma.timeOffRequest.create({ data: { associateId: ana.id, category: 'VACATION', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), requestedMinutes: 960 } });
  return { client, siteA, siteB, ana, bo, shiftA, shiftB, entryA, entryB, entryNoClientAtA, entryNoClientNoSite, docNoClient, docClient, application, runNoClient, runClient, qualNoClient, qualClient, timeOffA };
}

async function visible(user: SessionUser) {
  const [clients, shifts, entries, associates, documents, applications, runs, qualWrites, timeOff, items] = await Promise.all([
    prisma.client.findMany({ where: scopeClients(user), select: { id: true } }),
    prisma.shift.findMany({ where: scopeShifts(user), select: { id: true } }),
    prisma.timeEntry.findMany({ where: scopeTimeEntries(user), select: { id: true } }),
    prisma.associate.findMany({ where: scopeAssociates(user), select: { id: true } }),
    prisma.documentRecord.findMany({ where: scopeDocuments(user), select: { id: true } }),
    prisma.application.findMany({ where: scopeApplications(user), select: { id: true } }),
    prisma.payrollRun.findMany({ where: scopePayrollRuns(user), select: { id: true } }),
    prisma.qualification.findMany({ where: scopeQualificationWrites(user), select: { id: true } }),
    prisma.timeOffRequest.findMany({ where: scopeTimeOffRequests(user), select: { id: true } }),
    prisma.payrollItem.findMany({ where: scopePayrollItems(user) as Prisma.PayrollItemWhereInput, select: { id: true } }),
  ]);
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
  return { clients: ids(clients), shifts: ids(shifts), entries: ids(entries), associates: ids(associates), documents: ids(documents), applications: ids(applications), runs: ids(runs), qualWrites: ids(qualWrites), timeOff: ids(timeOff), items: ids(items) };
}

describe('a client-bounded account with no client and no site sees nothing', () => {
  for (const role of BOUNDED) {
    it(`${role}: every data scope resolves to no rows — including the rows whose client is null`, async () => {
      await world();
      const v = await visible(sessionUser(role, { clientId: null, locationId: null }));
      expect(v).toEqual({ clients: [], shifts: [], entries: [], associates: [], documents: [], applications: [], runs: [], qualWrites: [], timeOff: [], items: [] });
    });
  }
});

describe('a client-bounded account with a site and no client sees its site, and only its site', () => {
  for (const role of BOUNDED) {
    it(`${role}: shifts, time entries, people, documents and applications at the site; never the other site, never the client-less rows elsewhere`, async () => {
      const w = await world();
      const v = await visible(sessionUser(role, { clientId: null, locationId: w.siteA.id }));
      expect(v.shifts).toEqual([w.shiftA.id]);
      expect(v.entries).toEqual([w.entryA.id, w.entryNoClientAtA.id].sort());
      expect(v.associates).toEqual([w.ana.id]);
      expect(v.applications).toEqual([w.application.id]);
      expect(v.documents).toEqual([w.docNoClient.id]);
      // Nothing that lives on a client: the client list, its payroll runs, its qualifications.
      expect(v.clients).toEqual([]);
      expect(v.runs).toEqual([]);
      expect(v.qualWrites).toEqual([]);
      // The row with neither client nor site belongs to nobody's site.
      expect(v.entries).not.toContain(w.entryNoClientNoSite.id);
    });
  }
});

describe('the tenant is part of every bounded scope', () => {
  for (const role of BOUNDED) {
    it(`${role}: the same account under another tenant, or with no tenant, sees nothing of tenant one`, async () => {
      const w = await world();
      const other = await visible(sessionUser(role, { clientId: w.client.id, locationId: w.siteA.id, tenantId: T2 }));
      expect(other).toEqual({ clients: [], shifts: [], entries: [], associates: [], documents: [], applications: [], runs: [], qualWrites: [], timeOff: [], items: [] });
      const none = await visible(sessionUser(role, { clientId: w.client.id, locationId: w.siteA.id, tenantId: null }));
      expect(none).toEqual({ clients: [], shifts: [], entries: [], associates: [], documents: [], applications: [], runs: [], qualWrites: [], timeOff: [], items: [] });
    });
  }

  it('with its client and its tenant the account still sees exactly its client (the rule that exists today)', async () => {
    const w = await world();
    const v = await visible(sessionUser('SHIFT_SUPERVISOR', { clientId: w.client.id }));
    expect(v.clients).toEqual([w.client.id]);
    expect(v.shifts).toEqual([w.shiftA.id, w.shiftB.id].sort());
    expect(v.entries).toEqual([w.entryA.id, w.entryB.id].sort());
    expect(v.entries).not.toContain(w.entryNoClientAtA.id);
    expect(v.applications).toEqual([w.application.id]);
    expect(v.timeOff).toEqual([w.timeOffA.id]);
  });
});
