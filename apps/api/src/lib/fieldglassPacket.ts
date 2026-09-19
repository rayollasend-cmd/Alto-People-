import { prisma } from '../db.js';
import { localDateKey } from './timezone.js';
import { currentClientOf } from './fieldglassNotify.js';

/**
 * The Fieldglass registration packet — everything the buyer's "new SOW
 * worker" form asks for, in the order it asks, so finance registers a
 * worker in one sitting without hunting through the People record:
 *
 *   the worker     legal name, email, phone, date of birth, last 4 of SSN,
 *                  home address
 *   the engagement the client (SOW), the Site exactly as Fieldglass spells
 *                  it, the bill rate, the job (their first shift's
 *                  position), the start date, the store and its manager
 *   the screening  background check, drug test, I-9, E-Verify — what the
 *                  buyer's onboarding checklist attests
 *
 * `missing` names whatever Fieldglass will ask for that Alto doesn't have
 * yet, so it's fixed before the form, not halfway through it.
 */

export interface FieldglassPacket {
  associateId: string;
  worker: {
    firstName: string;
    middleInitial: string | null;
    lastName: string;
    /** "Last, First M" — how Fieldglass lists workers. */
    listName: string;
    email: string;
    phone: string | null;
    dob: string | null;
    ssnLast4: string | null;
    address: { line1: string; line2: string | null; city: string; state: string; zip: string } | null;
  };
  engagement: {
    clientId: string | null;
    clientName: string | null;
    /** The Fieldglass Site label, verbatim (null: not set on the client). */
    site: string | null;
    billRate: number | null;
    position: string | null;
    firstShiftAt: string | null;
    /** The first shift's store-local date, YYYY-MM-DD. */
    startDate: string | null;
    store: { name: string; address: string | null } | null;
    /** The store's manager on the client side — often the timesheet approver. */
    siteManager: { name: string; email: string } | null;
  };
  screening: {
    backgroundCheck: { status: string; completedAt: string | null } | null;
    drugTest: { status: string; completedAt: string | null } | null;
    i9: { section1At: string | null; section2At: string | null } | null;
    eVerify: string | null;
  };
  registration: { workerId: string | null; addedAt: string; clientName: string | null } | null;
  separatedAt: string | null;
  missing: string[];
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export async function buildFieldglassPacket(associateId: string): Promise<FieldglassPacket | null> {
  const a = await prisma.associate.findFirst({
    where: { id: associateId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      middleInitial: true,
      lastName: true,
      email: true,
      phone: true,
      dob: true,
      ssnLast4: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      zip: true,
      separatedAt: true,
      fieldglassRegistration: {
        select: { workerId: true, addedAt: true, client: { select: { name: true } } },
      },
    },
  });
  if (!a) return null;
  const client = await currentClientOf(a.id);
  const [clientRow, shifts, bg, drug, i9] = await Promise.all([
    client
      ? prisma.client.findUnique({ where: { id: client.id }, select: { fieldglassSiteName: true, fieldglassBillRate: true } })
      : Promise.resolve(null),
    prisma.shift.findMany({
      where: {
        assignedAssociateId: a.id,
        status: { in: ['ASSIGNED', 'COMPLETED'] },
        ...(client ? { clientId: client.id } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 60,
      select: {
        startsAt: true,
        position: true,
        locationRel: {
          select: { id: true, name: true, timezone: true, addressLine1: true, city: true, state: true, zip: true },
        },
      },
    }),
    prisma.backgroundCheck.findFirst({ where: { associateId: a.id }, orderBy: { initiatedAt: 'desc' }, select: { status: true, completedAt: true } }),
    prisma.drugTest.findFirst({ where: { associateId: a.id }, orderBy: { initiatedAt: 'desc' }, select: { status: true, completedAt: true } }),
    prisma.i9Verification.findUnique({
      where: { associateId: a.id },
      select: { section1CompletedAt: true, section2CompletedAt: true, eVerifyStatus: true },
    }),
  ]);
  // The job and store: their next shift there, else their first. The
  // start date is the first day they actually worked there, when they
  // already have — Fieldglass wants the real start, not the next shift.
  const now = Date.now();
  const first = shifts.find((s) => s.startsAt.getTime() >= now) ?? shifts[0] ?? null;
  const loc = first?.locationRel ?? null;
  const firstWorked = client
    ? await prisma.timeEntry.findFirst({
        where: { associateId: a.id, clientId: client.id, status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] } },
        orderBy: { clockInAt: 'asc' },
        select: { clockInAt: true, location: { select: { timezone: true } } },
      })
    : null;
  const startAt =
    firstWorked && (!shifts[0] || firstWorked.clockInAt < shifts[0].startsAt) ? firstWorked.clockInAt : (shifts[0]?.startsAt ?? null);
  const startTz = firstWorked && startAt === firstWorked.clockInAt ? (firstWorked.location?.timezone ?? loc?.timezone) : loc?.timezone;
  const manager = loc
    ? await prisma.user.findFirst({
        where: { role: 'CLIENT_PORTAL', locationId: loc.id, status: 'ACTIVE', deletedAt: null },
        select: { email: true, associate: { select: { firstName: true, lastName: true } } },
      })
    : null;
  const address =
    a.addressLine1 && a.city && a.state && a.zip
      ? { line1: a.addressLine1, line2: a.addressLine2, city: a.city, state: a.state, zip: a.zip }
      : null;
  const billRate = clientRow?.fieldglassBillRate != null ? Number(clientRow.fieldglassBillRate) : null;

  const missing: string[] = [];
  if (!a.phone) missing.push('Phone');
  if (!a.dob) missing.push('Date of birth');
  if (!a.ssnLast4) missing.push('Last 4 of SSN');
  if (!address) missing.push('Home address');
  if (!startAt) missing.push('A first shift (their start date)');
  if (client && !clientRow?.fieldglassSiteName) missing.push(`The Fieldglass Site label for ${client.name}`);
  if (client && billRate === null) missing.push(`The bill rate for ${client.name}`);
  if (bg?.status !== 'PASSED') missing.push(bg ? `Background check (${bg.status.toLowerCase().replace('_', ' ')})` : 'Background check');
  if (!i9?.section2CompletedAt) missing.push('I-9 Section 2');

  return {
    associateId: a.id,
    worker: {
      firstName: a.firstName,
      middleInitial: a.middleInitial,
      lastName: a.lastName,
      listName: `${a.lastName}, ${a.firstName}${a.middleInitial ? ` ${a.middleInitial}` : ''}`,
      email: a.email,
      phone: a.phone,
      dob: a.dob ? a.dob.toISOString().slice(0, 10) : null,
      ssnLast4: a.ssnLast4,
      address,
    },
    engagement: {
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      site: clientRow?.fieldglassSiteName ?? null,
      billRate,
      position: first?.position ?? null,
      firstShiftAt: iso(first?.startsAt),
      startDate: startAt ? localDateKey(startAt, startTz ?? 'America/New_York') : null,
      store: loc
        ? { name: loc.name, address: [loc.addressLine1, loc.city, [loc.state, loc.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null }
        : null,
      siteManager: manager
        ? { name: manager.associate ? `${manager.associate.firstName} ${manager.associate.lastName}` : '', email: manager.email }
        : null,
    },
    screening: {
      backgroundCheck: bg ? { status: bg.status, completedAt: iso(bg.completedAt) } : null,
      drugTest: drug ? { status: drug.status, completedAt: iso(drug.completedAt) } : null,
      i9: i9 ? { section1At: iso(i9.section1CompletedAt), section2At: iso(i9.section2CompletedAt) } : null,
      eVerify: i9?.eVerifyStatus ?? null,
    },
    registration: a.fieldglassRegistration
      ? {
          workerId: a.fieldglassRegistration.workerId,
          addedAt: a.fieldglassRegistration.addedAt.toISOString(),
          clientName: a.fieldglassRegistration.client?.name ?? null,
        }
      : null,
    separatedAt: iso(a.separatedAt),
    missing,
  };
}
