import { Router, raw } from 'express';
import { prisma } from '../../db.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { logEvent } from '../../lib/books/qbo/connection.js';
import { runSync } from '../../lib/books/qbo/sync.js';
import { parseWebhook, verifyWebhook, webhookVerifier } from '../../lib/books/qbo/webhook.js';

/**
 * POST /books/quickbooks/webhook — Intuit's change notifications for the
 * company QuickBooks. Mounted before express.json so the signature
 * (intuit-signature: base64 HMAC-SHA256 of the raw body with the verifier
 * token) is checked over the exact bytes. Intuit wants an answer within
 * three seconds, so the pull runs after the 200.
 */

export const booksQuickbooksWebhookRouter = Router();

const inFlight = new Set<Promise<unknown>>();
/** Tests wait for the pulls a webhook started. */
export async function flushQuickbooksWebhookWork(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

booksQuickbooksWebhookRouter.post('/', raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!webhookVerifier()) {
    res.status(503).json({ error: 'webhooks_off' });
    return;
  }
  if (!verifyWebhook(body, req.get('intuit-signature') ?? undefined)) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  const notices = parseWebhook(body);
  // Tracked before the answer goes out, so a test (or shutdown) can wait for it.
  const work = (async () => {
    for (const n of notices) {
      // An unauthenticated request: the realm names the tenant (a single-record lookup, not narrowed).
      const conn = await prisma.qboCompanyConnection.findFirst({ where: { realmId: n.realmId }, select: { tenantId: true, status: true } });
      if (!conn || conn.status !== 'CONNECTED') continue;
      await runWithTenant(conn.tenantId ?? ALTO_TENANT_ID, 'job', async () => {
        await logEvent(prisma, { direction: 'PULL', result: 'OK', message: `QuickBooks reported ${n.entities.length} change${n.entities.length === 1 ? '' : 's'} (${[...new Set(n.entities.map((e) => e.name))].join(', ') || 'unspecified'}).` });
        await runSync(prisma, { push: false });
      });
    }
  })().catch((err) => console.error('[books] QuickBooks webhook pull failed', err));
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
  res.status(200).json({ ok: true });
});
