import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import { emitLiveEvent } from '../lib/liveEvents.js';
import type { Prisma } from '@prisma/client';
import { scopeActiveAssociates } from '../lib/scope.js';

/**
 * Phase 107 — Birthdays & work anniversaries.
 *
 * Pulls dates from existing fields:
 *   - birthday  = Associate.dob (year-agnostic; we display month/day)
 *   - hire date = earliest Application.startDate the associate has
 *
 * Anniversary years = floor(yearsBetween(hireDate, today)) + 1 if the
 * upcoming anniversary day is still ahead this year, else +0.
 *
 * No DB schema change. The frontend can render the next 30 days as
 * "this week" / "next week" / "this month" buckets.
 */

export const celebrationsRouter = Router();

const VIEW = requireCapability('view:org');
// A shift supervisor sees their own crew's celebrations (scopeActiveAssociates
// clamps a bounded role to its client or store).
const VIEW_CREW = requireAnyCapability('view:org', 'message:crew');

interface CelebrationItem {
  associateId: string;
  associateName: string;
  email: string;
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  /** ISO date string for the upcoming occurrence. */
  date: string;
  /** Anniversary years (e.g., "5 years"). null for birthdays. */
  years: number | null;
  /** Where they work now — for the store and client filters. */
  locationId: string | null;
  siteName: string | null;
  clientId: string | null;
  clientName: string | null;
}

celebrationsRouter.get('/celebrations/upcoming', VIEW_CREW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const locationId = z.string().uuid().optional().parse(req.query.locationId);
  const days = z
    .coerce.number()
    .int()
    .min(1)
    .max(365)
    .default(60)
    .parse(req.query.days);

  // Active people in the caller's tenant and reach who have a date to
  // celebrate — every one of them, read in pages (a cap of 1,000 in no
  // particular order used to drop an arbitrary part of the company).
  const where: Prisma.AssociateWhereInput = {
    AND: [
      scopeActiveAssociates(req.user!),
      { OR: [{ dob: { not: null } }, { applications: { some: { deletedAt: null, startDate: { not: null } } } }] },
      locationId || clientId
        ? { assignments: { some: { endedAt: null, ...(locationId ? { locationId } : { location: { is: { clientId } } }) } } }
        : {},
    ],
  };
  const associates: Awaited<ReturnType<typeof page>> = [];
  const page = (cursor?: string) => prisma.associate.findMany({
    where,
    orderBy: { id: 'asc' },
    take: 5000,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      dob: true,
      applications: {
        where: { deletedAt: null, startDate: { not: null } },
        select: { startDate: true },
        orderBy: { startDate: 'asc' },
        take: 1,
      },
      assignments: {
        where: { endedAt: null },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { location: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } } },
      },
    },
  });
  for (let cursor: string | undefined; ; ) {
    const rows = await page(cursor);
    associates.push(...rows);
    if (rows.length < 5000) break;
    cursor = rows[rows.length - 1]!.id;
  }

  const now = new Date();
  // Use UTC math throughout — birthdays are date-only and don't care
  // about timezone. The window is `days` calendar days from today.
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const horizon = new Date(startOfToday);
  horizon.setUTCDate(horizon.getUTCDate() + days);

  const items: CelebrationItem[] = [];

  const nextOccurrence = (month: number, day: number): Date => {
    // month is 1..12, day is 1..31
    const thisYear = new Date(
      Date.UTC(startOfToday.getUTCFullYear(), month - 1, day),
    );
    if (thisYear.getTime() >= startOfToday.getTime()) return thisYear;
    return new Date(
      Date.UTC(startOfToday.getUTCFullYear() + 1, month - 1, day),
    );
  };

  for (const a of associates) {
    const name = `${a.firstName} ${a.lastName}`.trim();
    const where = a.assignments[0]?.location;
    const place = {
      locationId: where?.id ?? null,
      siteName: where?.name ?? null,
      clientId: where?.clientId ?? null,
      clientName: where?.client?.name ?? null,
    };
    if (a.dob) {
      const dob = new Date(a.dob);
      const next = nextOccurrence(
        dob.getUTCMonth() + 1,
        dob.getUTCDate(),
      );
      if (next.getTime() <= horizon.getTime()) {
        items.push({
          associateId: a.id,
          associateName: name,
          email: a.email,
          kind: 'BIRTHDAY',
          date: next.toISOString().slice(0, 10),
          years: null,
          ...place,
        });
      }
    }
    const hire = a.applications[0]?.startDate;
    if (hire) {
      const h = new Date(hire);
      const next = nextOccurrence(
        h.getUTCMonth() + 1,
        h.getUTCDate(),
      );
      // Skip the very-first-day-of-hire entry — that's not an anniversary.
      const yearsAtNext =
        next.getUTCFullYear() - h.getUTCFullYear();
      if (yearsAtNext >= 1 && next.getTime() <= horizon.getTime()) {
        items.push({
          associateId: a.id,
          associateName: name,
          email: a.email,
          kind: 'ANNIVERSARY',
          date: next.toISOString().slice(0, 10),
          years: yearsAtNext,
          ...place,
        });
      }
    }
  }

  items.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ items });
});

// ----- My own celebration (associate self-serve) ---------------------------
// The upcoming list above is view:org (managers planning shout-outs). This
// is the associate's own moment: is TODAY my birthday or work anniversary?
// Drives the dashboard ribbon — the app should be the first to say it.
celebrationsRouter.get('/celebrations/me', requireAuth, async (req, res) => {
  const associateId = req.user?.associateId;
  if (!associateId) {
    res.json({ birthday: false, anniversaryYears: null, firstName: null });
    return;
  }
  const a = await prisma.associate.findFirst({
    where: { id: associateId, deletedAt: null },
    select: {
      firstName: true,
      dob: true,
      applications: {
        where: { deletedAt: null, startDate: { not: null } },
        select: { startDate: true },
        orderBy: { startDate: 'asc' },
        take: 1,
      },
    },
  });
  if (!a) {
    res.json({ birthday: false, anniversaryYears: null, firstName: null });
    return;
  }
  const now = new Date();
  const isToday = (d: Date) =>
    d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
  const birthday = Boolean(a.dob && isToday(new Date(a.dob)));
  let anniversaryYears: number | null = null;
  const hire = a.applications[0]?.startDate;
  if (hire) {
    const h = new Date(hire);
    const years = now.getUTCFullYear() - h.getUTCFullYear();
    if (isToday(h) && years >= 1) anniversaryYears = years;
  }
  res.json({ birthday, anniversaryYears, firstName: a.firstName });
});

// High-five — fire-and-forget congratulations message via the
// existing in-app notification system. Throttle: at most one
// high-five per (sender, recipient, occurrence) per day.
const HighFiveSchema = z.object({
  associateId: z.string().uuid(),
  kind: z.enum(['BIRTHDAY', 'ANNIVERSARY']),
  message: z.string().min(1).max(500),
});

celebrationsRouter.post('/celebrations/high-five', VIEW, async (req, res) => {
  const input = HighFiveSchema.parse(req.body);
  const target = await prisma.associate.findUnique({
    where: { id: input.associateId },
    select: {
      firstName: true,
      lastName: true,
      user: { select: { id: true, email: true, status: true } },
    },
  });
  if (!target) {
    throw new HttpError(404, 'not_found', 'Associate not found.');
  }
  if (!target.user || target.user.status !== 'ACTIVE') {
    throw new HttpError(
      400,
      'no_user',
      'This associate has no active user account to receive the message.',
    );
  }
  await prisma.notification.create({
    data: {
      channel: 'IN_APP',
      status: 'QUEUED',
      recipientUserId: target.user.id,
      recipientEmail: target.user.email,
      subject:
        input.kind === 'BIRTHDAY'
          ? '🎂 Happy birthday!'
          : '🎉 Happy work anniversary!',
      body: input.message,
      category: input.kind === 'BIRTHDAY' ? 'birthday' : 'anniversary',
      senderUserId: req.user!.id,
    },
  });
  emitLiveEvent(target.user.id, 'notification');
  res.status(201).json({ ok: true });
});
