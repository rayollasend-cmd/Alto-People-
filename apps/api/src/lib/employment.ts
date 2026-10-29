import type { EmployerOrganization, EmploymentType, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { getBrandingSync } from './branding.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from './tenant.js';
import { orgDateKey } from './timeAnomalies.js';
import { dateColumnKey } from './timezone.js';

/**
 * Brief 2-1b, step 4 — the employer of record.
 *
 *   An Employment is one spell: this person, employed by this
 *   EmployerOrganization, from hireDate to endDate. Opened when an
 *   application is approved, ended by the separation, removed when a hire
 *   is undone. The employer is the tenant's own row (the default), a
 *   client's row (a staffing company whose clients carry the legal facts
 *   today), or a third party.
 *
 *   The W-2/1099 employer and the paystub's company block come from here
 *   (employerFor), never from a Client row — the owner's decision 3.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The legal facts a form prints. The same shape a Client row used to give. */
export interface EmployerFacts {
  id: string;
  kind: EmployerOrganization['kind'];
  legalName: string;
  ein: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** NY Labor Law §195 prints it on wage statements and pay notices. */
  phone: string | null;
  /** CA Labor Code §2810.5 names the workers' comp carrier on the pay notice. */
  wcCarrierName: string | null;
  wcCarrierAddress: string | null;
  wcCarrierPhone: string | null;
  wcPolicyNumber: string | null;
  clientId: string | null;
}

const FACTS = { id: true, kind: true, legalName: true, ein: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true, phone: true, wcCarrierName: true, wcCarrierAddress: true, wcCarrierPhone: true, wcPolicyNumber: true, clientId: true } as const;

/** The tenant's own employer row; created from the organization name when the table is empty (a fresh database). */
export async function defaultEmployerOrg(db: Db = defaultPrisma, tenantId: string = tenantIdForWrite()): Promise<EmployerFacts> {
  const found = await db.employerOrganization.findFirst({ where: { tenantId, isDefault: true }, select: FACTS });
  if (found) return found;
  return db.employerOrganization.create({
    data: { tenantId, kind: 'TENANT', legalName: getBrandingSync().orgName || 'Alto HR', isDefault: true },
    select: FACTS,
  });
}

/** A client's own employer row, when the client carries legal facts; made on first use. */
export async function employerOrgForClient(db: Db, clientId: string): Promise<EmployerFacts | null> {
  const existing = await db.employerOrganization.findUnique({ where: { clientId }, select: FACTS });
  if (existing) return existing;
  const client = await db.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, tenantId: true, name: true, legalName: true, ein: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true, sutaRateOverride: true, sutaWageBaseOverride: true } });
  if (!client || (!client.legalName && !client.ein)) return null;
  return db.employerOrganization.create({
    data: {
      tenantId: client.tenantId ?? ALTO_TENANT_ID,
      kind: 'CLIENT',
      legalName: client.legalName ?? client.name,
      ein: client.ein,
      addressLine1: client.addressLine1,
      addressLine2: client.addressLine2,
      city: client.city,
      state: client.state,
      zip: client.zip,
      sutaRateOverride: client.sutaRateOverride,
      sutaWageBaseOverride: client.sutaWageBaseOverride,
      clientId: client.id,
    },
    select: FACTS,
  });
}

/** A day as the @db.Date columns hold it. A Date here is a date column's value (UTC midnight of its day). */
const dateOnly = (d: Date | string) => new Date(`${typeof d === 'string' ? d.slice(0, 10) : dateColumnKey(d)}T00:00:00.000Z`);

/** Today on the company's calendar, as a date column holds it (never UTC's day, which is tomorrow after 5 PM Pacific). */
const companyToday = (): Date => new Date(`${orgDateKey(new Date())}T00:00:00.000Z`);

/** The employment in force on a day (the latest one that covers it). */
export async function currentEmployment(db: Db, associateId: string, on: Date = companyToday()) {
  const day = dateOnly(on);
  return db.employment.findFirst({
    where: { associateId, hireDate: { lte: day }, OR: [{ endDate: null }, { endDate: { gte: day } }] },
    orderBy: { hireDate: 'desc' },
    include: { employer: { select: FACTS } },
  });
}

/** The employer of record for a person on a day: the employment's, else the tenant's default. */
export async function employerFor(db: Db, associateId: string, on: Date = companyToday()): Promise<EmployerFacts> {
  const e = await currentEmployment(db, associateId, on);
  if (e) return e.employer;
  // No spell yet (a person hired before the record existed, or an applicant): the tenant's own row.
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { tenantId: true } });
  return defaultEmployerOrg(db, a?.tenantId ?? tenantIdForWrite());
}

/**
 * Every employer a person had in a tax year (one W-2 per employer); the
 * default employer when no spell touches the year.
 */
export async function employersForYear(db: Db, associateId: string, taxYear: number): Promise<EmployerFacts[]> {
  const jan1 = new Date(Date.UTC(taxYear, 0, 1));
  const dec31 = new Date(Date.UTC(taxYear, 11, 31));
  const spells = await db.employment.findMany({
    where: { associateId, hireDate: { lte: dec31 }, OR: [{ endDate: null }, { endDate: { gte: jan1 } }] },
    orderBy: { hireDate: 'asc' },
    include: { employer: { select: FACTS } },
  });
  const seen = new Map<string, EmployerFacts>();
  for (const s of spells) seen.set(s.employer.id, s.employer);
  if (seen.size === 0) {
    // No spell on file (a person hired before the record existed): the
    // employers are the ones whose payroll paid them in the year — each
    // client with legal facts through its own employer row (made on first
    // use), the client-less runs through the tenant's default.
    const runs = await db.payrollRun.findMany({
      where: { status: { not: 'CANCELLED' }, disbursedAt: { gte: jan1, lt: new Date(Date.UTC(taxYear + 1, 0, 1)) }, items: { some: { associateId, status: { not: 'VOIDED' } } } },
      select: { clientId: true },
      distinct: ['clientId'],
    });
    for (const r of runs) {
      const e = (r.clientId ? await employerOrgForClient(db, r.clientId) : null) ?? (await employerFor(db, associateId, dec31));
      seen.set(e.id, e);
    }
    if (seen.size === 0) {
      const d = await employerFor(db, associateId, dec31);
      seen.set(d.id, d);
    }
  }
  return [...seen.values()];
}

/** The employer with the EIN a form was stamped with, within the tenant. */
export async function employerByEin(db: Db, ein: string, tenantId: string = tenantIdForWrite()): Promise<EmployerFacts | null> {
  return db.employerOrganization.findFirst({ where: { tenantId, ein }, orderBy: { isDefault: 'desc' }, select: FACTS });
}

/**
 * Open a spell at approval. Idempotent on the application. The employer is
 * the client's own row when the client carries legal facts (what the tax
 * forms read yesterday), else the tenant's default.
 */
export async function openEmployment(
  db: Db,
  input: { associateId: string; applicationId: string | null; clientId: string | null; siteId: string | null; hireDate: Date | string; employmentType?: EmploymentType; employerOrgId?: string },
): Promise<{ id: string; employerOrgId: string }> {
  if (input.applicationId) {
    const existing = await db.employment.findUnique({ where: { applicationId: input.applicationId }, select: { id: true, employerOrgId: true } });
    if (existing) return existing;
  }
  const associate = await db.associate.findUnique({ where: { id: input.associateId }, select: { tenantId: true, employmentType: true } });
  if (!associate) throw new HttpError(404, 'associate_not_found', 'No such associate.');
  const tenantId = associate.tenantId ?? ALTO_TENANT_ID;
  const employerOrgId =
    input.employerOrgId ?? (input.clientId ? (await employerOrgForClient(db, input.clientId))?.id : null) ?? (await defaultEmployerOrg(db, tenantId)).id;
  const row = await db.employment.create({
    data: {
      tenantId,
      associateId: input.associateId,
      employerOrgId,
      employmentType: input.employmentType ?? associate.employmentType,
      hireDate: dateOnly(input.hireDate),
      applicationId: input.applicationId,
      siteId: input.siteId,
    },
    select: { id: true, employerOrgId: true },
  });
  return row;
}

/** End every open spell on the last day worked. */
export async function endEmployment(db: Db, associateId: string, lastDay: Date | string): Promise<number> {
  const r = await db.employment.updateMany({ where: { associateId, endDate: null }, data: { endDate: dateOnly(lastDay) } });
  return r.count;
}

/** A hire undone: the spell its application opened goes with it. */
export async function dropEmploymentOfApplication(db: Db, applicationId: string): Promise<void> {
  await db.employment.deleteMany({ where: { applicationId } });
}

/** Every spell for a person, newest first — for the record and the audits. */
export async function employmentHistory(db: Db, associateId: string) {
  return db.employment.findMany({ where: { associateId }, orderBy: { hireDate: 'desc' }, include: { employer: { select: FACTS }, site: { select: { id: true, name: true } } } });
}
