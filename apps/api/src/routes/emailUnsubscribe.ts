import { Router, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { pageLang, readUnsubscribeToken, unsubscribePageHtml, type UnsubscribePageState } from '../lib/emailUnsubscribe.js';
import { enqueueAudit } from '../lib/audit.js';

export const emailUnsubscribeRouter = Router();

/** The footer link's page posts back with ?via=page and is answered with a page. */
const fromPage = (req: Request) => req.query.via === 'page';

function sendPage(res: Response, req: Request, status: number, state: UnsubscribePageState, bucket: string | null) {
  res
    .status(status)
    // The token in the address is the authorization: never cache the page,
    // never let it be indexed.
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex')
    .type('html')
    .send(unsubscribePageHtml({ state, lang: pageLang(req.get('accept-language')), bucket }));
}

/**
 * GET /communications/unsubscribe/:token  (public — no session)
 *
 * What "Stop emails like this" in an email footer opens: a small page that
 * says which emails will stop and offers one button. The GET itself changes
 * nothing — mail scanners and link previewers fetch every link in a
 * message, and a GET that unsubscribed would mute people who never clicked.
 * The page is the API's own HTML, not the app (app.ts lets this path
 * through the SPA shell).
 */
emailUnsubscribeRouter.get('/:token', (req, res) => {
  const target = readUnsubscribeToken(req.params.token);
  if (!target) return sendPage(res, req, 400, 'invalid', null);
  sendPage(res, req, 200, target.mandatory ? 'always_on' : 'confirm', target.bucket);
});

/**
 * POST /communications/unsubscribe/:token  (public — no session)
 *
 * RFC 8058 one-click unsubscribe target. Mailbox providers (Gmail, Yahoo)
 * POST this URL directly when the user clicks their native "Unsubscribe"
 * affordance — no cookies, no interaction, a form-encoded
 * `List-Unsubscribe=One-Click` body we deliberately ignore. The page above
 * posts here too (?via=page). The HMAC token minted at send time
 * (lib/emailUnsubscribe.ts) binds the recipient address — and, for the
 * per-kind tokens every notice now carries, the settings bucket — and IS
 * the authorization.
 *
 * Effect: every ACTIVE user account on that email gets that one bucket
 * muted for email (the two-part announcement tokens in older emails mean
 * `broadcast`, exactly as before). IN_APP delivery is untouched — the
 * notices still land in the bell. A required bucket (security,
 * emergencies, formal HR notices) is refused: those always reach people.
 *
 * Always 200 on a valid token, even when no matching user exists — the
 * response must not oracle which addresses have accounts, and re-clicking
 * a link after account deletion shouldn't show an error.
 */
emailUnsubscribeRouter.post('/:token', async (req, res, next) => {
  try {
    const target = readUnsubscribeToken(req.params.token);
    if (!target) {
      if (fromPage(req)) return sendPage(res, req, 400, 'invalid', null);
      throw new HttpError(400, 'invalid_token', 'Invalid unsubscribe link.');
    }
    if (target.mandatory) {
      if (fromPage(req)) return sendPage(res, req, 403, 'always_on', target.bucket);
      throw new HttpError(403, 'always_on', 'These notices can’t be turned off.');
    }

    const users = await prisma.user.findMany({
      where: { email: { equals: target.email, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true },
    });
    for (const u of users) {
      await prisma.notificationPreference.upsert({
        where: { userId_category: { userId: u.id, category: target.bucket } },
        create: { userId: u.id, category: target.bucket, emailEnabled: false },
        update: { emailEnabled: false },
      });
      enqueueAudit(
        {
          actorUserId: null, // one-click POST from the mailbox provider, or the page's button
          action: 'email.unsubscribed',
          entityType: 'NotificationPreference',
          entityId: u.id,
          metadata: { category: target.bucket, via: fromPage(req) ? 'unsubscribe-page' : 'list-unsubscribe' },
        },
        'emailUnsubscribe',
      );
    }

    if (fromPage(req)) return sendPage(res, req, 200, 'done', target.bucket);
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
