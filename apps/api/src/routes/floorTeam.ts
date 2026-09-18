import { Router, type Request } from 'express';
import { z } from 'zod';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';
import { ledWindows } from '../lib/shiftWindows.js';
import { dateKeyInZone, orgDateKey } from '../lib/timeAnomalies.js';
import {
  FLOOR_WHERE,
  LEAD_WHERE,
  firstName,
  floorTeamOf,
  fmtDateSpan,
  onClockSince,
  personName,
  validLead,
} from '../lib/floorLeads.js';

/**
 * Floor team — the shift supervisor in charge of each floor supervisor,
 * and the days a shift supervisor hands their shift (SOP included) to one.
 *
 *   GET    /me/floor-team                 a shift supervisor's floor
 *                                         supervisors + hand-overs; a floor
 *                                         supervisor's lead + the days
 *                                         they're covering
 *   GET    /admin/users/:id/floor-team    the same, for a shift supervisor
 *                                         (HR / Workforce)
 *   PUT    /admin/users/:id/lead          set a floor supervisor's shift
 *                                         supervisor (manage:org)
 *   POST   /shift-covers                  hand a shift over for a day or days
 *   DELETE /shift-covers/:id              take it back
 *
 * Handing over is the shift supervisor's own call (their floor supervisors
 * only), or HR's / Workforce's (manage:org) when the shift supervisor can't
 * — out sick at home without the app.
 */
export const floorTeamRouter = Router();

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const MAX_COVER_DAYS = 31;

const personSelect = {
  id: true,
  email: true,
  clientId: true,
  associateId: true,
  associate: { select: { firstName: true, lastName: true } },
} as const;

/** "Today" on the user's store clock — the first store of their shift. */
async function todayKeyFor(userId: string, now = new Date()): Promise<string> {
  const w = await prisma.supervisorShiftWindow.findFirst({
    where: { userId },
    select: { location: { select: { timezone: true } } },
  });
  return w ? dateKeyInZone(now, w.location.timezone) : orgDateKey(now);
}

async function windowsOf(userId: string) {
  return (await ledWindows(prisma, { userId })).map((w) => ({
    locationId: w.locationId,
    locationName: w.locationName,
    label: w.label,
    startMinute: w.startMinute,
    endMinute: w.endMinute,
  }));
}

async function presence(u: { associateId: string | null }) {
  const e = await onClockSince(prisma, u.associateId);
  return e ? e.clockInAt.toISOString() : null;
}

/** A shift supervisor's floor team and hand-overs. */
async function leadView(lead: { id: string; clientId: string | null }) {
  const today = await todayKeyFor(lead.id);
  const [team, covers] = await Promise.all([
    floorTeamOf(prisma, lead),
    prisma.shiftCover.findMany({
      where: { leadUserId: lead.id, cancelledAt: null, toDate: { gte: today } },
      orderBy: { fromDate: 'asc' },
      select: {
        id: true,
        fromDate: true,
        toDate: true,
        note: true,
        cover: { select: personSelect },
      },
    }),
  ]);
  return {
    role: 'lead' as const,
    today,
    team: await Promise.all(
      team.map(async (m) => ({
        userId: m.id,
        name: personName(m),
        associateId: m.associateId,
        onClockSince: await presence(m),
        windows: await windowsOf(m.id),
        coveringToday: covers.some((c) => c.cover.id === m.id && c.fromDate <= today && c.toDate >= today),
      })),
    ),
    covers: covers.map((c) => ({
      id: c.id,
      fromDate: c.fromDate,
      toDate: c.toDate,
      note: c.note,
      coverUserId: c.cover.id,
      coverName: personName(c.cover),
    })),
  };
}

floorTeamRouter.get('/me/floor-team', requireAuth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { ...personSelect, role: true, leadUserId: true },
  });
  if (!me) throw new HttpError(404, 'not_found', 'User not found.');
  if (me.role === 'SHIFT_SUPERVISOR') {
    res.json(await leadView(me));
    return;
  }
  if (me.role !== 'FLOOR_SUPERVISOR') {
    res.json({ role: null });
    return;
  }
  const today = await todayKeyFor(me.id);
  const [lead, covers] = await Promise.all([
    validLead(prisma, me),
    prisma.shiftCover.findMany({
      where: { coverUserId: me.id, cancelledAt: null, toDate: { gte: today }, lead: { deletedAt: null } },
      orderBy: { fromDate: 'asc' },
      select: { id: true, fromDate: true, toDate: true, note: true, lead: { select: personSelect } },
    }),
  ]);
  res.json({
    role: 'floor' as const,
    today,
    lead: lead
      ? {
          userId: lead.id,
          name: personName(lead),
          associateId: lead.associateId,
          onClockSince: await presence(lead),
          windows: await windowsOf(lead.id),
        }
      : null,
    covers: covers.map((c) => ({
      id: c.id,
      fromDate: c.fromDate,
      toDate: c.toDate,
      note: c.note,
      leadUserId: c.lead.id,
      leadName: personName(c.lead),
      today: c.fromDate <= today && c.toDate >= today,
    })),
  });
});

floorTeamRouter.get(
  '/admin/users/:id/floor-team',
  requireAnyCapability('view:hr-admin', 'manage:org'),
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const lead = await prisma.user.findFirst({
      where: { id, ...LEAD_WHERE },
      select: { id: true, clientId: true },
    });
    if (!lead) throw new HttpError(404, 'not_found', 'Shift supervisor not found.');
    res.json(await leadView(lead));
  },
);

floorTeamRouter.put('/admin/users/:id/lead', requireCapability('manage:org'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { leadUserId } = z.object({ leadUserId: z.string().uuid().nullable() }).parse(req.body);
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, clientId: true, deletedAt: true, leadUserId: true },
  });
  if (!target || target.deletedAt) throw new HttpError(404, 'not_found', 'User not found.');
  if (target.role !== 'FLOOR_SUPERVISOR') {
    throw new HttpError(400, 'not_a_floor_supervisor', 'Only floor supervisors report to a shift supervisor.');
  }
  if (!target.clientId) {
    throw new HttpError(400, 'client_required', 'Assign the floor supervisor a client first.');
  }
  if (leadUserId) {
    const lead = await prisma.user.findFirst({
      where: { id: leadUserId, ...LEAD_WHERE },
      select: { id: true, clientId: true },
    });
    if (!lead) {
      throw new HttpError(400, 'lead_not_found', 'Pick an active shift supervisor.');
    }
    if (lead.clientId !== target.clientId) {
      throw new HttpError(
        400,
        'lead_other_client',
        "That shift supervisor works another client — pick one at the floor supervisor's client.",
      );
    }
  }
  await prisma.user.update({ where: { id }, data: { leadUserId } });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId: target.clientId,
      action: 'user.lead_set',
      entityType: 'User',
      entityId: id,
      metadata: { from: target.leadUserId, to: leadUserId },
    },
    'user.lead_set',
  );
  res.json({ leadUserId });
});

const CoverInput = z.object({
  coverUserId: z.string().uuid(),
  fromDate: YMD,
  toDate: YMD,
  /** HR / Workforce handing over for a shift supervisor. */
  leadUserId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
});

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** The lead a cover is for, and whether the caller may hand it over. */
async function leadForCover(req: Request, leadUserId: string | undefined) {
  const caller = req.user!;
  if (caller.role === 'SHIFT_SUPERVISOR' && (!leadUserId || leadUserId === caller.id)) {
    return prisma.user.findFirstOrThrow({ where: { id: caller.id }, select: personSelect });
  }
  if (!hasCapability(caller.role, 'manage:org')) {
    throw new HttpError(403, 'forbidden', 'Only the shift supervisor — or HR and Workforce — can hand a shift over.');
  }
  if (!leadUserId) throw new HttpError(400, 'lead_required', 'Whose shift is being handed over?');
  const lead = await prisma.user.findFirst({ where: { id: leadUserId, ...LEAD_WHERE }, select: personSelect });
  if (!lead) throw new HttpError(404, 'not_found', 'Shift supervisor not found.');
  return lead;
}

floorTeamRouter.post('/shift-covers', requireAuth, async (req, res) => {
  const input = CoverInput.parse(req.body);
  const lead = await leadForCover(req, input.leadUserId);
  const selfService = lead.id === req.user!.id;
  if (input.toDate < input.fromDate) {
    throw new HttpError(400, 'dates_backwards', 'The last day comes after the first.');
  }
  const today = await todayKeyFor(lead.id);
  if (input.toDate < today) throw new HttpError(400, 'dates_past', 'Those days have already gone by.');
  if (daysBetween(input.fromDate, input.toDate) > MAX_COVER_DAYS) {
    throw new HttpError(400, 'too_long', `Hand over at most ${MAX_COVER_DAYS} days at a time.`);
  }
  const cover = await prisma.user.findFirst({
    where: { id: input.coverUserId, ...FLOOR_WHERE, status: 'ACTIVE', clientId: lead.clientId ?? undefined },
    select: { ...personSelect, leadUserId: true },
  });
  if (!cover || !lead.clientId) {
    throw new HttpError(400, 'cover_not_found', 'Pick an active floor supervisor at the same client.');
  }
  // A shift supervisor hands over to their own floor supervisors.
  if (selfService && cover.leadUserId !== lead.id) {
    throw new HttpError(400, 'not_your_team', `${personName(cover)} doesn't report to you.`);
  }
  const clash = await prisma.shiftCover.findFirst({
    where: {
      leadUserId: lead.id,
      cancelledAt: null,
      fromDate: { lte: input.toDate },
      toDate: { gte: input.fromDate },
    },
    select: { fromDate: true, toDate: true, cover: { select: personSelect } },
  });
  if (clash) {
    throw new HttpError(
      409,
      'cover_overlaps',
      `${personName(clash.cover)} already covers ${fmtDateSpan(clash.fromDate, clash.toDate)} — take that back first.`,
    );
  }
  const created = await prisma.shiftCover.create({
    data: {
      leadUserId: lead.id,
      coverUserId: cover.id,
      fromDate: input.fromDate,
      toDate: input.toDate,
      note: input.note || null,
      createdById: req.user!.id,
    },
    select: { id: true, fromDate: true, toDate: true, note: true },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId: lead.clientId,
      action: 'ops.shift_handed_over',
      entityType: 'ShiftCover',
      entityId: created.id,
      metadata: { lead: lead.id, cover: cover.id, fromDate: input.fromDate, toDate: input.toDate },
    },
    'ops.shifts',
  );
  const windows = await ledWindows(prisma, { userId: lead.id });
  const labels = [...new Set(windows.map((w) => w.label))].join(' & ') || 'store';
  const stores = [...new Set(windows.map((w) => w.locationName))].join(', ');
  const span = fmtDateSpan(input.fromDate, input.toDate);
  void trackNotificationWork(
    notifyUser(cover.id, {
      subject: `${firstName(lead)} handed you the ${labels} shift — ${span}`,
      body:
        `On ${span} you run ${firstName(lead)}'s ${labels} shift${stores ? ` at ${stores}` : ''}: clocking in at ` +
        `the store tablet opens the SOP for you. Read the previous shift's notes, work the checklist, hand over, ` +
        `and submit it before you clock out.` +
        (input.note ? `\n\n${firstName(lead)}: ${input.note}` : ''),
      category: 'ops.sop',
      linkUrl: '/',
    }),
  );
  if (!selfService) {
    void trackNotificationWork(
      notifyUser(lead.id, {
        subject: `${personName(cover)} covers your shift — ${span}`,
        body: `Your ${labels} shift and its SOP go to ${personName(cover)} on ${span}. Clock in on one of those days and it comes back to you.`,
        category: 'ops.sop',
        linkUrl: '/',
      }),
    );
  }
  res.status(201).json({
    cover: { ...created, coverUserId: cover.id, coverName: personName(cover) },
  });
});

floorTeamRouter.delete('/shift-covers/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = await prisma.shiftCover.findUnique({
    where: { id },
    select: {
      id: true,
      cancelledAt: true,
      fromDate: true,
      toDate: true,
      leadUserId: true,
      lead: { select: personSelect },
      cover: { select: personSelect },
    },
  });
  if (!row || row.cancelledAt) throw new HttpError(404, 'not_found', 'That hand-over is gone.');
  if (row.leadUserId !== req.user!.id && !hasCapability(req.user!.role, 'manage:org')) {
    throw new HttpError(403, 'forbidden', 'Only the shift supervisor — or HR and Workforce — can take a shift back.');
  }
  await prisma.shiftCover.update({ where: { id }, data: { cancelledAt: new Date() } });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId: row.lead.clientId,
      action: 'ops.shift_handover_cancelled',
      entityType: 'ShiftCover',
      entityId: id,
      metadata: { lead: row.leadUserId, cover: row.cover.id },
    },
    'ops.shifts',
  );
  void trackNotificationWork(
    notifyUser(row.cover.id, {
      subject: `${firstName(row.lead)} took their shift back — ${fmtDateSpan(row.fromDate, row.toDate)}`,
      body: `You're no longer covering ${firstName(row.lead)}'s shift on ${fmtDateSpan(row.fromDate, row.toDate)}. Help on their SOP as usual.`,
      category: 'ops.sop',
      linkUrl: '/',
    }),
  );
  res.status(204).end();
});
