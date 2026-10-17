import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth, requireCapability } from '../middleware/auth.js';
import { signedLinkIpLimiter } from '../middleware/rateLimit.js';
import { enqueueAudit } from '../lib/audit.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import { computeNpsResults, remindNpsWave, sendNpsWave } from '../lib/clientNps.js';
import { hashToken } from '../lib/inviteToken.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Client NPS: the executive (and marketing) read the results; a person with
 * manage:clients sends the quarter's wave or a reminder; the store manager
 * answers on a signed link outside the portal — no login, no portal change.
 */

export const clientNpsRouter = Router();

const READ = requireAnyCapability('view:executive', 'view:marketing');
const SEND = requireCapability('manage:clients');

clientNpsRouter.get('/executive/nps', requireAuth, READ, async (_req, res) => {
  res.json(await computeNpsResults(prisma));
});

clientNpsRouter.post('/executive/nps/send', requireAuth, SEND, async (req, res) => {
  const quarter = z.string().regex(/^\d{4}-Q[1-4]$/).optional().parse(req.body?.quarter);
  const out = await sendNpsWave({ quarter, sentById: req.user!.id });
  if ('error' in out) {
    throw new HttpError(
      409,
      out.error,
      out.error === 'already_sent' ? 'This quarter’s survey has already gone out.' : 'No active store manager account to send it to.',
    );
  }
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'clients.nps_wave_sent', entityType: 'ClientNpsWave', entityId: out.waveId, metadata: { quarter: out.quarter, invited: out.invited }, tenantId: tenantIdForWrite() },
    'clients.nps_wave_sent',
  );
  res.status(201).json(out);
});

clientNpsRouter.post('/executive/nps/remind', requireAuth, SEND, async (req, res) => {
  const reminded = await remindNpsWave(prisma);
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'clients.nps_reminder_sent', entityType: 'ClientNpsWave', entityId: 'current', metadata: { reminded }, tenantId: tenantIdForWrite() },
    'clients.nps_reminder_sent',
  );
  res.json({ reminded });
});

/* ===== The answer page (public, signed link) =============================== */

async function inviteByToken(raw: string) {
  if (!raw || raw.length > 128) throw new HttpError(404, 'not_found', 'This link is not valid.');
  const inv = await prisma.clientNpsInvite.findFirst({
    where: { tokenHash: hashToken(raw) },
    include: { client: { select: { name: true } }, wave: { select: { quarter: true, closesAt: true } } },
  });
  if (!inv) throw new HttpError(404, 'not_found', 'This link is not valid.');
  return inv;
}

clientNpsRouter.get('/nps/:token', signedLinkIpLimiter, async (req, res) => {
  const inv = await inviteByToken(req.params.token);
  const branding = await ensureBrandingLoaded(prisma, inv.tenantId ?? undefined);
  res.json({
    orgName: branding.orgName,
    clientName: inv.client.name,
    quarter: inv.wave.quarter,
    closed: inv.wave.closesAt.getTime() < Date.now(),
    answered: inv.respondedAt !== null,
    score: inv.score,
  });
});

const AnswerSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().trim().max(2000).nullable().optional(),
});

clientNpsRouter.post('/nps/:token', signedLinkIpLimiter, async (req, res) => {
  const input = AnswerSchema.parse(req.body);
  const inv = await inviteByToken(req.params.token);
  if (inv.wave.closesAt.getTime() < Date.now()) throw new HttpError(409, 'closed', 'This survey has closed.');
  // An answer can be changed while the wave is open — the last one counts.
  await prisma.clientNpsInvite.update({
    where: { id: inv.id },
    data: { score: input.score, comment: input.comment ?? null, respondedAt: new Date() },
  });
  res.json({ ok: true });
});
