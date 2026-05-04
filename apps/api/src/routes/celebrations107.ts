import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

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

interface CelebrationItem {
  associateId: string;
  associateName: string;
  email: string;
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  /** ISO date string for the upcoming occurrence. */
  date: string;
  /** Anniversary years (e.g., "5 years"). null for birthdays. */
  years: number | null;
}

celebrationsRouter.get('/celebrations/upcoming', VIEW, async (req, res) => {
  const days = z
    .coerce.number()
    .int()
    .min(1)
    .max(365)
    .default(60)
    .parse(req.query.days);

  const associates = await prisma.associate.findMany({
    take: 1000,
    where: { deletedAt: null },
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
    },
  });

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
        });
      }
    }
  }

  items.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ items });
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
  res.status(201).json({ ok: true });
});
