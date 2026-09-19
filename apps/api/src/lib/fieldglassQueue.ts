import type { FieldglassStatus } from '@alto-people/shared';
import { prisma } from '../db.js';
import { primaryClientsForAssociates } from './associateClients.js';
import { DEFAULT_TIMEZONE, localDateKey } from './timezone.js';

/**
 * Fieldglass setup — who has to be registered, moved or closed in the
 * buyer's Fieldglass, and who already is.
 *
 *   the queue   ADD: approved and scheduled (or already working) but not
 *               registered; TRANSFER: registered under one client, working
 *               at another; CLOSE: separated but still registered. Close-
 *               outs first, then transfers, then adds — someone already
 *               working unbilled first among them, then the soonest shift.
 *   the roster  everyone registered: their Worker ID, the client, since
 *               when and by whom, when they last worked, and where their
 *               newest Fieldglass timesheet stands.
 *
 * The finance dashboard shows the top of the queue; the Fieldglass setup
 * page works all of it.
 */

const DAY_MS = 86_400_000;

export async function buildFieldglassQueue(now: Date = new Date()) {
  // The Fieldglass setup queue — approved+scheduled workers not yet
  // marked as registered. Windowed to recent approvals so the first
  // deploy never floods the list with historical associates.
  const fgWindowStart = new Date(now.getTime() - 60 * DAY_MS);
  const recentApproved = await prisma.application.findMany({
    where: {
      status: 'APPROVED',
      approvedAt: { gte: fgWindowStart },
      deletedAt: null,
    },
    orderBy: { approvedAt: 'desc' },
    take: 100,
    select: {
      associateId: true,
      approvedAt: true,
      client: { select: { name: true } },
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          hireDate: true,
          separatedAt: true,
          deactivatedAt: true,
          fieldglassRegistration: { select: { associateId: true } },
        },
      },
    },
  });
  // Never ask Finance to ADD someone who has since separated or is
  // paused — their released shifts already dropped them in practice;
  // this makes it explicit.
  const fgCandidates = recentApproved.filter(
    (a) =>
      a.associate.fieldglassRegistration === null &&
      a.associate.separatedAt === null &&
      a.associate.deactivatedAt === null,
  );
  const fgShifts =
    fgCandidates.length > 0
      ? await prisma.shift.findMany({
          where: {
            assignedAssociateId: { in: fgCandidates.map((a) => a.associateId) },
            status: { in: ['ASSIGNED', 'COMPLETED'] },
          },
          orderBy: { startsAt: 'asc' },
          take: 500,
          select: {
            assignedAssociateId: true,
            startsAt: true,
            position: true,
            client: { select: { name: true } },
          },
        })
      : [];
  // Where each candidate works NOW: a transfer before they were added
  // to Fieldglass means "add under the new client" — their first shift
  // and their application both sit at the client they left.
  const fgCurrent = await primaryClientsForAssociates(fgCandidates.map((a) => a.associateId));
  const firstShiftByAssociate = new Map<string, (typeof fgShifts)[number]>();
  for (const s of fgShifts) {
    if (s.assignedAssociateId && !firstShiftByAssociate.has(s.assignedAssociateId)) {
      firstShiftByAssociate.set(s.assignedAssociateId, s);
    }
  }
  // TRANSFERS: registered under one client, currently assigned to
  // another → "close old account, open new one". Not windowed — a
  // two-year associate can transfer.
  const regs = await prisma.fieldglassRegistration.findMany({
    take: 500,
    select: {
      associateId: true,
      clientId: true,
      workerId: true,
      client: { select: { name: true } },
      associate: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          hireDate: true,
          deletedAt: true,
          separatedAt: true,
          assignments: {
            where: { endedAt: null },
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: {
              location: {
                select: { client: { select: { id: true, name: true } } },
              },
            },
          },
        },
      },
    },
  });
  // CLOSE-OUTS: separated (or erased) workers still registered — a
  // live account at the client for someone who no longer works here.
  // Keys off separatedAt, NEVER deactivatedAt: deactivation is a
  // reversible pause and must not close anyone's account.
  const closeRows = regs
    .filter(
      (r) => r.associate.separatedAt !== null || r.associate.deletedAt !== null,
    )
    .map((r) => ({
      kind: 'close' as const,
      associateId: r.associateId,
      name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      clientName: r.client?.name ?? null,
      fromClientName: null as string | null,
      workerId: r.workerId,
      position: null as string | null,
      firstShiftAt: null as string | null,
      approvedAt: null as string | null,
      email: r.associate.email,
      phone: r.associate.phone,
      hireDate: r.associate.hireDate
        ? r.associate.hireDate.toISOString().slice(0, 10)
        : null,
    }));
  const transferRows = regs
    .filter((r) => {
      const cur = r.associate.assignments[0]?.location.client;
      return (
        r.associate.deletedAt === null &&
        r.associate.separatedAt === null &&
        cur !== undefined &&
        r.clientId !== null &&
        cur.id !== r.clientId
      );
    })
    .map((r) => {
      const cur = r.associate.assignments[0]!.location.client!;
      return {
        kind: 'transfer' as const,
        associateId: r.associateId,
        name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
        clientName: cur.name,
        fromClientName: r.client?.name ?? null,
        workerId: r.workerId,
        position: null as string | null,
        firstShiftAt: null as string | null,
        approvedAt: null as string | null,
        email: r.associate.email,
        phone: r.associate.phone,
        hireDate: r.associate.hireDate
          ? r.associate.hireDate.toISOString().slice(0, 10)
          : null,
      };
    });
  // Earliest upcoming shift at the NEW client — the transfer deadline.
  if (transferRows.length > 0) {
    const upcoming = await prisma.shift.findMany({
      where: {
        assignedAssociateId: { in: transferRows.map((r) => r.associateId) },
        status: 'ASSIGNED',
        startsAt: { gte: now },
      },
      orderBy: { startsAt: 'asc' },
      take: 200,
      select: { assignedAssociateId: true, startsAt: true, position: true },
    });
    for (const row of transferRows) {
      const s = upcoming.find((u) => u.assignedAssociateId === row.associateId);
      if (s) {
        row.firstShiftAt = s.startsAt.toISOString();
        row.position = s.position;
      }
    }
  }

  const addRows = fgCandidates
    .map((a) => {
      const shift = firstShiftByAssociate.get(a.associateId);
      if (!shift) return null; // approved but not yet scheduled
      return {
        kind: 'add' as const,
        associateId: a.associateId,
        name: `${a.associate.firstName} ${a.associate.lastName}`.trim(),
        clientName: fgCurrent.get(a.associateId)?.clientName ?? shift.client?.name ?? a.client?.name ?? null,
        // Moved before being added: say where from, so nobody adds them
        // under the client they left.
        fromClientName: (() => {
          const now = fgCurrent.get(a.associateId)?.clientName;
          const started = shift.client?.name ?? a.client?.name ?? null;
          return now && started && now !== started ? started : null;
        })() as string | null,
        workerId: null as string | null,
        position: shift.position as string | null,
        firstShiftAt: shift.startsAt.toISOString() as string | null,
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        // The Fieldglass entry facts — on the row, so most workers
        // never require leaving the dashboard at all.
        email: a.associate.email,
        phone: a.associate.phone,
        hireDate: a.associate.hireDate
          ? a.associate.hireDate.toISOString().slice(0, 10)
          : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  // HOURS ALREADY WORKED by someone not in Fieldglass under that client
  // — the costliest add: those hours can't be billed until they are.
  // Not tied to the approval window or a scheduled shift: a walk-in or
  // an old hire working now is found here too.
  const workedSince = new Date(now.getTime() - 21 * DAY_MS);
  const workedEntries = await prisma.timeEntry.findMany({
    where: {
      clockInAt: { gte: workedSince },
      status: { in: ['APPROVED', 'COMPLETED'] },
      clientId: { not: null },
      clockOutAt: { not: null },
    },
    select: { associateId: true, clientId: true, clockInAt: true, clockOutAt: true },
    take: 5000,
  });
  const workedBy = new Map<string, { associateId: string; clientId: string; hours: number; firstAt: Date }>();
  for (const e of workedEntries) {
    const k = `${e.associateId}|${e.clientId}`;
    const row = workedBy.get(k) ?? { associateId: e.associateId, clientId: e.clientId!, hours: 0, firstAt: e.clockInAt };
    row.hours += (e.clockOutAt!.getTime() - e.clockInAt.getTime()) / 3_600_000;
    if (e.clockInAt < row.firstAt) row.firstAt = e.clockInAt;
    workedBy.set(k, row);
  }
  const regByAssociate = new Map(regs.map((r) => [r.associateId, r]));
  const unregistered = [...workedBy.values()].filter((w) => {
    const reg = regByAssociate.get(w.associateId);
    // Registered elsewhere is the transfer queue's; not registered at all is ours.
    return !reg && w.hours > 0;
  });
  const unbilledHours = new Map<string, number>();
  if (unregistered.length > 0) {
    const [people, clientNames] = await Promise.all([
      prisma.associate.findMany({
        where: { id: { in: unregistered.map((u) => u.associateId) }, deletedAt: null, separatedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, hireDate: true },
      }),
      prisma.client.findMany({
        where: { id: { in: [...new Set(unregistered.map((u) => u.clientId))] } },
        select: { id: true, name: true },
      }),
    ]);
    const person = new Map(people.map((p) => [p.id, p]));
    const clientName = new Map(clientNames.map((c) => [c.id, c.name]));
    for (const u of unregistered) {
      const p = person.get(u.associateId);
      if (!p) continue;
      const hours = Math.round(u.hours * 10) / 10;
      unbilledHours.set(u.associateId, (unbilledHours.get(u.associateId) ?? 0) + hours);
      if (addRows.some((r) => r.associateId === u.associateId)) continue;
      addRows.push({
        kind: 'add' as const,
        associateId: u.associateId,
        name: `${p.firstName} ${p.lastName}`.trim(),
        clientName: clientName.get(u.clientId) ?? '—',
        fromClientName: null,
        workerId: null,
        position: null,
        firstShiftAt: u.firstAt.toISOString(),
        approvedAt: null,
        email: p.email,
        phone: p.phone,
        hireDate: p.hireDate ? p.hireDate.toISOString().slice(0, 10) : null,
      });
    }
  }

  // Close-outs outrank transfers outrank adds (a dead account for a
  // departed worker is the worst kind of open baton); among adds,
  // someone already working unbilled comes first; then soonest shift.
  const KIND_RANK = { close: 0, transfer: 1, add: 2 } as const;
  const shiftTime = (v: string | null) =>
    v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER;
  return [...closeRows, ...transferRows, ...addRows]
    .map((r) => ({ ...r, hoursUnbilled: unbilledHours.get(r.associateId) ?? 0 }))
    .sort((x, y) => {
      if (x.kind !== y.kind) return KIND_RANK[x.kind] - KIND_RANK[y.kind];
      if ((y.hoursUnbilled > 0 ? 1 : 0) !== (x.hoursUnbilled > 0 ? 1 : 0)) return y.hoursUnbilled > 0 ? 1 : -1;
      return shiftTime(x.firstShiftAt) - shiftTime(y.firstShiftAt);
    });

}

export interface FieldglassRosterRow {
  associateId: string;
  name: string;
  photoUrl: string | null;
  clientId: string | null;
  clientName: string | null;
  workerId: string | null;
  addedAt: string;
  addedBy: string | null;
  /** Separated while still registered — on the queue to close. */
  separated: boolean;
  /** Their last clock-in, YYYY-MM-DD (store-local). */
  lastWorked: string | null;
  /** Their newest Fieldglass timesheet: its week and where it stands. */
  lastTimesheet: { weekEnd: string; status: FieldglassStatus | null; entered: boolean } | null;
}

/** Everyone registered in Fieldglass, newest first. */
export async function buildFieldglassRoster(): Promise<FieldglassRosterRow[]> {
  const regs = await prisma.fieldglassRegistration.findMany({
    where: { associate: { deletedAt: null } },
    orderBy: { addedAt: 'desc' },
    take: 1000,
    select: {
      associateId: true,
      clientId: true,
      workerId: true,
      addedAt: true,
      client: { select: { name: true } },
      addedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
      associate: { select: { firstName: true, lastName: true, photoS3Key: true, separatedAt: true } },
    },
  });
  const ids = regs.map((r) => r.associateId);
  const [sheets, last] = ids.length
    ? await Promise.all([
        prisma.fieldglassTimesheet.findMany({
          where: { associateId: { in: ids } },
          orderBy: [{ associateId: 'asc' }, { weekStart: 'desc' }],
          distinct: ['associateId'],
          select: { associateId: true, weekStart: true, fgStatus: true, enteredAt: true },
        }),
        prisma.timeEntry.findMany({
          where: { associateId: { in: ids } },
          orderBy: [{ associateId: 'asc' }, { clockInAt: 'desc' }],
          distinct: ['associateId'],
          select: { associateId: true, clockInAt: true, location: { select: { timezone: true } } },
        }),
      ])
    : [[], []];
  const sheetOf = new Map(sheets.map((s) => [s.associateId, s]));
  const lastOf = new Map(last.map((e) => [e.associateId, e]));
  return regs.map((r) => {
    const sheet = sheetOf.get(r.associateId);
    const worked = lastOf.get(r.associateId);
    const weekEnd = sheet ? new Date(sheet.weekStart.getTime() + 6 * DAY_MS).toISOString().slice(0, 10) : null;
    return {
      associateId: r.associateId,
      name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      photoUrl: r.associate.photoS3Key ? `/api/associates/${r.associateId}/photo` : null,
      clientId: r.clientId,
      clientName: r.client?.name ?? null,
      workerId: r.workerId,
      addedAt: r.addedAt.toISOString(),
      addedBy: r.addedBy
        ? r.addedBy.associate
          ? `${r.addedBy.associate.firstName} ${r.addedBy.associate.lastName}`
          : r.addedBy.email
        : null,
      separated: r.associate.separatedAt !== null,
      lastWorked: worked ? localDateKey(worked.clockInAt, worked.location?.timezone ?? DEFAULT_TIMEZONE) : null,
      lastTimesheet: sheet && weekEnd
        ? { weekEnd, status: (sheet.fgStatus as FieldglassStatus | null) ?? null, entered: !!sheet.enteredAt }
        : null,
    };
  });
}
