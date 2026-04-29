import { Router } from 'express';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { buildIcs, verifyCalendarToken } from '../lib/calendarFeed.js';

/**
 * Public iCal feed endpoint.
 *
 * Mounted OUTSIDE the auth chain because calendar clients (Google,
 * Apple, Outlook) poll on a schedule with no credentials. The token in
 * the URL is the authorization — it's an HMAC of the associate id, so
 * an attacker can't forge it without the server-side feed secret.
 *
 * The `.ics` extension on the URL is convention; some clients use it to
 * pick a parser. We accept both `/:associateId/:token` and
 * `/:associateId/:token.ics` to be friendly to whatever the user pastes.
 */
export const calendarFeedRouter = Router();

calendarFeedRouter.get('/v1/:associateId/:tokenWithExt', async (req, res, next) => {
  try {
    const { associateId } = req.params;
    const tokenWithExt = req.params.tokenWithExt;
    const token = tokenWithExt.endsWith('.ics')
      ? tokenWithExt.slice(0, -4)
      : tokenWithExt;

    if (!verifyCalendarToken(associateId, token)) {
      throw new HttpError(404, 'feed_not_found', 'Feed not found');
    }

    const associate = await prisma.associate.findFirst({
      where: { id: associateId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!associate) {
      throw new HttpError(404, 'feed_not_found', 'Feed not found');
    }

    // Pull a generous window so a calendar app rolling forward doesn't see
    // gaps. 90 days back covers payroll lookups; 180 days forward covers
    // long-range planning. Same publish gate as /me/shifts — drafts stay
    // private until published.
    const now = Date.now();
    const from = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const to = new Date(now + 180 * 24 * 60 * 60 * 1000);

    const shifts = await prisma.shift.findMany({
      where: {
        assignedAssociateId: associate.id,
        publishedAt: { not: null },
        startsAt: { gte: from, lt: to },
      },
      orderBy: { startsAt: 'asc' },
      include: { client: { select: { name: true } } },
      take: 1000,
    });

    const ics = buildIcs({
      calendarName: `${associate.firstName} ${associate.lastName} — Alto People`,
      events: shifts.map((s) => {
        const summaryParts = [s.position];
        if (s.client?.name) summaryParts.push(`@ ${s.client.name}`);
        return {
          uid: `shift-${s.id}@alto-people`,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          summary: summaryParts.join(' '),
          location: s.location,
          description: s.notes,
          status:
            s.status === 'CANCELLED'
              ? ('CANCELLED' as const)
              : s.status === 'DRAFT' || s.status === 'OPEN'
                ? ('TENTATIVE' as const)
                : ('CONFIRMED' as const),
        };
      }),
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // Encourage clients to refresh hourly — matches REFRESH-INTERVAL in the body.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="alto-${associate.id}.ics"`,
    );
    res.send(ics);
  } catch (err) {
    next(err);
  }
});
