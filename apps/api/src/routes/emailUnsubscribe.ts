import { Router } from 'express';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { verifyUnsubscribeToken } from '../lib/emailUnsubscribe.js';
import { enqueueAudit } from '../lib/audit.js';

export const emailUnsubscribeRouter = Router();

/**
 * POST /communications/unsubscribe/:token  (public — no session)
 *
 * RFC 8058 one-click unsubscribe target for broadcast email. Mailbox
 * providers (Gmail, Yahoo) POST this URL directly when the user clicks
 * their native "Unsubscribe" affordance — no cookies, no interaction, a
 * form-encoded `List-Unsubscribe=One-Click` body we deliberately ignore.
 * The HMAC token minted at send time (lib/emailUnsubscribe.ts) binds the
 * recipient address and IS the authorization.
 *
 * Effect: every ACTIVE user account on that email gets the `broadcast`
 * notification-preference bucket muted for email. IN_APP delivery is
 * untouched — announcements still land in the bell/inbox. Transactional
 * categories are unaffected (they never carry the header).
 *
 * Always 200 on a valid token, even when no matching user exists — the
 * response must not oracle which addresses have accounts, and re-clicking
 * a link after account deletion shouldn't show an error.
 */
emailUnsubscribeRouter.post('/:token', async (req, res, next) => {
  try {
    const email = verifyUnsubscribeToken(req.params.token);
    if (!email) {
      throw new HttpError(400, 'invalid_token', 'Invalid unsubscribe link.');
    }

    const users = await prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const u of users) {
      await prisma.notificationPreference.upsert({
        where: { userId_category: { userId: u.id, category: 'broadcast' } },
        create: { userId: u.id, category: 'broadcast', emailEnabled: false },
        update: { emailEnabled: false },
      });
      enqueueAudit(
        {
          actorUserId: null, // one-click POST from the mailbox provider
          action: 'email.unsubscribed',
          entityType: 'NotificationPreference',
          entityId: u.id,
          metadata: { category: 'broadcast', via: 'list-unsubscribe' },
        },
        'emailUnsubscribe',
      );
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
