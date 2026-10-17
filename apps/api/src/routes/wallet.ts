import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * The credential wallet — what a person has earned, carried with them.
 *
 *   GET  /me/wallet              my qualifications, trainings and verified credential documents, with expiry
 *   POST /me/wallet/share        a link that shows them to someone else for a while (7–90 days)
 *   GET  /wallet/public/:token   what the link shows: name, the credentials, nothing else — no login
 *
 * The link is a signed token (HS256, the session secret, its own audience)
 * that names the person and when it stops working; nothing is stored, so
 * a shared link cannot be enumerated and expires on its own. The public
 * page reads the records live, so a credential revoked after sharing is
 * gone from the link too.
 */
export const walletRouter = Router();

const AUD = 'alto:wallet-share';
const DAY_S = 86_400;

/** Document kinds that are credentials a person carries, not HR paperwork. */
const CREDENTIAL_KINDS = ['ID', 'J1_DS2019', 'J1_VISA', 'BACKGROUND_CHECK_RESULT', 'DRUG_TEST_RESULT', 'I9_VERIFICATION_RESULT'] as const;
const KIND_LABEL: Record<(typeof CREDENTIAL_KINDS)[number], string> = {
  ID: 'Government ID',
  J1_DS2019: 'DS-2019',
  J1_VISA: 'J-1 visa',
  BACKGROUND_CHECK_RESULT: 'Background check',
  DRUG_TEST_RESULT: 'Drug screen',
  I9_VERIFICATION_RESULT: 'Work authorization (I-9)',
};

export interface WalletItem {
  kind: 'qualification' | 'training' | 'document';
  id: string;
  title: string;
  /** Who it came from: the client that defined it, the course, the verifier. */
  issuer: string | null;
  earnedAt: string | null;
  expiresAt: string | null;
  state: 'valid' | 'expiring' | 'expired';
}

function stateOf(expiresAt: Date | null, now: Date): WalletItem['state'] {
  if (!expiresAt) return 'valid';
  if (expiresAt.getTime() < now.getTime()) return 'expired';
  return expiresAt.getTime() - now.getTime() < 30 * DAY_S * 1000 ? 'expiring' : 'valid';
}

export async function walletFor(associateId: string, now = new Date()): Promise<{ person: { name: string; since: string | null }; items: WalletItem[] }> {
  const [person, quals, enrollments, docs] = await Promise.all([
    prisma.associate.findFirst({ where: { id: associateId, deletedAt: null }, select: { firstName: true, lastName: true, createdAt: true } }),
    prisma.associateQualification.findMany({
      where: { associateId, deletedAt: null, qualification: { deletedAt: null } },
      select: { id: true, acquiredAt: true, expiresAt: true, qualification: { select: { name: true, client: { select: { name: true } } } } },
      take: 200,
    }),
    prisma.courseEnrollment.findMany({
      where: { associateId, status: 'COMPLETED' },
      select: { id: true, completedAt: true, expiresAt: true, course: { select: { title: true } } },
      take: 200,
    }),
    prisma.documentRecord.findMany({
      where: { associateId, deletedAt: null, status: 'VERIFIED', kind: { in: [...CREDENTIAL_KINDS] } },
      select: { id: true, kind: true, verifiedAt: true, expiresAt: true },
      take: 100,
    }),
  ]);
  if (!person) throw new HttpError(404, 'not_found', 'Person not found.');
  const items: WalletItem[] = [
    ...quals.map((q) => ({
      kind: 'qualification' as const,
      id: q.id,
      title: q.qualification.name,
      issuer: q.qualification.client?.name ?? null,
      earnedAt: q.acquiredAt?.toISOString() ?? null,
      expiresAt: q.expiresAt?.toISOString() ?? null,
      state: stateOf(q.expiresAt, now),
    })),
    ...enrollments.map((e) => ({
      kind: 'training' as const,
      id: e.id,
      title: e.course.title,
      issuer: null,
      earnedAt: e.completedAt?.toISOString() ?? null,
      expiresAt: e.expiresAt?.toISOString() ?? null,
      state: stateOf(e.expiresAt, now),
    })),
    ...docs.map((d) => ({
      kind: 'document' as const,
      id: d.id,
      title: KIND_LABEL[d.kind as (typeof CREDENTIAL_KINDS)[number]] ?? d.kind,
      issuer: 'Verified by HR',
      earnedAt: d.verifiedAt?.toISOString() ?? null,
      expiresAt: d.expiresAt?.toISOString() ?? null,
      state: stateOf(d.expiresAt, now),
    })),
  ].sort((a, b) => (a.state === b.state ? a.title.localeCompare(b.title) : a.state === 'expired' ? 1 : b.state === 'expired' ? -1 : a.state === 'expiring' ? -1 : 1));
  return { person: { name: `${person.firstName} ${person.lastName}`.trim(), since: person.createdAt.toISOString() }, items };
}

walletRouter.get('/me/wallet', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) throw new HttpError(403, 'not_an_associate', 'The wallet is for associate-linked accounts.');
    res.json(await walletFor(associateId));
  } catch (err) {
    next(err);
  }
});

const ShareBody = z.object({ days: z.number().int().min(1).max(90).default(30) });

walletRouter.post('/me/wallet/share', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) throw new HttpError(403, 'not_an_associate', 'The wallet is for associate-linked accounts.');
    const parsed = ShareBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    const expiresIn = parsed.data.days * DAY_S;
    const token = jwt.sign({ sub: associateId, t: tenantIdForWrite() }, env.JWT_SECRET, { algorithm: 'HS256', audience: AUD, expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'wallet.shared', entityType: 'Associate', entityId: associateId, metadata: { days: parsed.data.days, expiresAt: expiresAt.toISOString() } },
      'wallet.share',
    );
    res.status(201).json({ token, path: `/w/${token}`, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

/** No login: the link is the key. Name and credentials only — never contact details, pay, or documents themselves. */
walletRouter.get('/wallet/public/:token', async (req, res, next) => {
  try {
    let decoded: jwt.JwtPayload;
    try {
      const d = jwt.verify(req.params.token, env.JWT_SECRET, { algorithms: ['HS256'], audience: AUD });
      if (typeof d === 'string' || !d.sub) throw new Error('bad');
      decoded = d;
    } catch {
      throw new HttpError(404, 'link_expired', 'This link has expired or is not valid.');
    }
    const wallet = await walletFor(decoded.sub!);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...wallet, expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null });
  } catch (err) {
    next(err);
  }
});
