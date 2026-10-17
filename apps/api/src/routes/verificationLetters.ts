import { Router } from 'express';
import { z } from 'zod';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { renderLetterPdf } from '../lib/letterPdf.js';
import { getBrandingSync } from '../lib/branding.js';
import { notifyAllAdmins, notifyAssociate, ADMIN_EMAIL_HR_ONLY } from '../lib/notify.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Employment and income verification letters (HR pack 2026-10).
 *
 *   A person asks for one from their documents (who it is for, why). HR
 *   approves it — and at that moment the letter's facts are frozen into a
 *   snapshot (employer of record, title, dates, employment type, pay when
 *   it is an income letter), so the PDF reads the same next year as today.
 *   Declining needs a reason the person sees. Every decision is audited.
 *
 *   POST /my/verification-letters         { kind, addressedTo?, purpose? }
 *   GET  /my/verification-letters
 *   GET  /verification-letters            HR queue (?status=)
 *   POST /verification-letters/:id/approve
 *   POST /verification-letters/:id/decline { reason }
 *   GET  /verification-letters/:id/pdf     the person (own) or HR
 */

export const verificationLettersRouter = Router();

const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:documents');

const RequestSchema = z.object({
  kind: z.enum(['EMPLOYMENT', 'INCOME']),
  addressedTo: z.string().trim().max(160).optional().nullable(),
  purpose: z.string().trim().max(500).optional().nullable(),
});

interface Snapshot {
  employer: { name: string; ein: string | null; address: string | null };
  person: { name: string; title: string | null; employmentType: string; hireDate: string | null; endDate: string | null; status: 'current' | 'former' };
  pay: { payType: string; amount: string; currency: string } | null;
}

async function snapshotFor(associateId: string, includePay: boolean): Promise<Snapshot> {
  const a = await prisma.associate.findUnique({
    where: { id: associateId },
    select: {
      firstName: true,
      lastName: true,
      employmentType: true,
      hireDate: true,
      separatedAt: true,
      jobProfile: { select: { title: true } },
      employments: { where: { endDate: null }, orderBy: { hireDate: 'desc' }, take: 1, select: { employer: { select: { legalName: true, ein: true, addressLine1: true, city: true, state: true, zip: true } } } },
      compRecords: { where: { effectiveTo: null }, take: 1, select: { payType: true, amount: true, currency: true } },
    },
  });
  if (!a) throw new HttpError(404, 'not_found', 'Person not found.');
  const emp = a.employments[0]?.employer ?? null;
  const branding = getBrandingSync();
  const comp = a.compRecords[0] ?? null;
  return {
    employer: {
      name: emp?.legalName ?? branding.orgName,
      ein: emp?.ein ?? null,
      address: emp ? [emp.addressLine1, emp.city, emp.state, emp.zip].filter(Boolean).join(', ') || null : null,
    },
    person: {
      name: `${a.firstName} ${a.lastName}`.trim(),
      title: a.jobProfile?.title ?? null,
      employmentType: a.employmentType,
      hireDate: a.hireDate?.toISOString().slice(0, 10) ?? null,
      endDate: a.separatedAt?.toISOString().slice(0, 10) ?? null,
      status: a.separatedAt ? 'former' : 'current',
    },
    pay: includePay && comp ? { payType: comp.payType, amount: comp.amount.toFixed(2), currency: comp.currency } : null,
  };
}

function letterBody(kind: 'EMPLOYMENT' | 'INCOME', s: Snapshot, addressedTo: string | null, issuedOn: Date): string {
  const date = issuedOn.toISOString().slice(0, 10);
  const verb = s.person.status === 'current' ? 'is employed' : 'was employed';
  const since = s.person.hireDate ? ` since ${s.person.hireDate}` : '';
  const until = s.person.endDate ? ` until ${s.person.endDate}` : '';
  const title = s.person.title ? ` as ${s.person.title}` : '';
  const type = s.person.employmentType.replace(/_/g, ' ').toLowerCase();
  const lines = [
    `${date}`,
    addressedTo ? `To: ${addressedTo}` : 'To whom it may concern,',
    `This letter confirms that ${s.person.name} ${verb} by ${s.employer.name}${title}${since}${until}, on a ${type} basis.`,
  ];
  if (kind === 'INCOME' && s.pay) {
    const rate = s.pay.payType === 'HOURLY' ? `${s.pay.currency} ${s.pay.amount} per hour` : `${s.pay.currency} ${s.pay.amount} per year`;
    lines.push(`${s.person.name}'s current rate of pay is ${rate}.`);
  }
  if (s.employer.ein) lines.push(`Employer identification number: ${s.employer.ein}.`);
  if (s.employer.address) lines.push(`${s.employer.name}, ${s.employer.address}.`);
  lines.push('This letter was issued at the request of the person named above and reflects our records on the date shown.');
  lines.push(`Human Resources\n${s.employer.name}`);
  return lines.join('\n\n');
}

function shape(l: { id: string; associateId: string; kind: string; status: string; addressedTo: string | null; purpose: string | null; decidedAt: Date | null; declineReason: string | null; createdAt: Date; associate?: { firstName: string; lastName: string; email: string | null } }) {
  return {
    id: l.id,
    associateId: l.associateId,
    associateName: l.associate ? `${l.associate.firstName} ${l.associate.lastName}`.trim() : undefined,
    associateEmail: l.associate?.email ?? undefined,
    kind: l.kind,
    status: l.status,
    addressedTo: l.addressedTo,
    purpose: l.purpose,
    decidedAt: l.decidedAt?.toISOString() ?? null,
    declineReason: l.declineReason,
    createdAt: l.createdAt.toISOString(),
  };
}

verificationLettersRouter.post('/my/verification-letters', requireAuth, async (req, res) => {
  if (!req.user!.associateId) throw new HttpError(403, 'no_associate_record', 'Only a worker can ask for a letter.');
  const input = RequestSchema.parse(req.body);
  const open = await prisma.verificationLetter.count({ where: { associateId: req.user!.associateId, kind: input.kind, status: 'REQUESTED' } });
  if (open > 0) throw new HttpError(409, 'already_requested', 'You already have one of these waiting on HR.');
  const created = await prisma.verificationLetter.create({
    data: { associateId: req.user!.associateId, kind: input.kind, addressedTo: input.addressedTo ?? null, purpose: input.purpose ?? null, requestedByUserId: req.user!.id },
  });
  void notifyAllAdmins({
    subject: `Verification letter requested`,
    body: `A ${input.kind === 'INCOME' ? 'proof of income' : 'proof of employment'} letter was requested${input.addressedTo ? ` for ${input.addressedTo}` : ''}. Approve it from Documents › Letters.`,
    category: 'documents',
    linkUrl: '/documents?tab=letters',
    excludeUserId: req.user!.id,
    emailRoles: ADMIN_EMAIL_HR_ONLY,
  });
  res.status(201).json({ id: created.id });
});

verificationLettersRouter.get('/my/verification-letters', requireAuth, async (req, res) => {
  if (!req.user!.associateId) return res.json({ letters: [] });
  const rows = await prisma.verificationLetter.findMany({ where: { associateId: req.user!.associateId }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ letters: rows.map(shape) });
});

verificationLettersRouter.get('/verification-letters', VIEW, async (req, res) => {
  const status = z.enum(['REQUESTED', 'APPROVED', 'DECLINED']).optional().parse(req.query.status);
  const rows = await prisma.verificationLetter.findMany({
    where: { tenantId: tenantIdForWrite(), ...(status ? { status } : {}) },
    include: { associate: { select: { firstName: true, lastName: true, email: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 300,
  });
  res.json({ letters: rows.map(shape) });
});

verificationLettersRouter.post('/verification-letters/:id/approve', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const l = await prisma.verificationLetter.findUnique({ where: { id } });
  if (!l) throw new HttpError(404, 'not_found', 'Letter not found.');
  if (l.status !== 'REQUESTED') throw new HttpError(409, 'decided', `Already ${l.status.toLowerCase()}.`);
  const snapshot = await snapshotFor(l.associateId, l.kind === 'INCOME');
  await prisma.verificationLetter.update({ where: { id }, data: { status: 'APPROVED', decidedById: req.user!.id, decidedAt: new Date(), snapshot: snapshot as never } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'verification_letter.approved', entityType: 'VerificationLetter', entityId: id, metadata: { associateId: l.associateId, kind: l.kind } }, 'verification_letter.approved');
  void notifyAssociate(l.associateId, {
    subject: 'Your verification letter is ready',
    body: `Your ${l.kind === 'INCOME' ? 'proof of income' : 'proof of employment'} letter was approved. Download it from Documents.`,
    category: 'documents',
    linkUrl: '/documents?tab=letters',
    emailFallback: true,
  });
  res.json({ ok: true });
});

verificationLettersRouter.post('/verification-letters/:id/decline', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const reason = z.string().trim().min(2).max(500).parse(req.body?.reason);
  const l = await prisma.verificationLetter.findUnique({ where: { id } });
  if (!l) throw new HttpError(404, 'not_found', 'Letter not found.');
  if (l.status !== 'REQUESTED') throw new HttpError(409, 'decided', `Already ${l.status.toLowerCase()}.`);
  await prisma.verificationLetter.update({ where: { id }, data: { status: 'DECLINED', decidedById: req.user!.id, decidedAt: new Date(), declineReason: reason } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'verification_letter.declined', entityType: 'VerificationLetter', entityId: id, metadata: { associateId: l.associateId, kind: l.kind, reason } }, 'verification_letter.declined');
  void notifyAssociate(l.associateId, {
    subject: 'About your verification letter',
    body: `HR could not issue your ${l.kind === 'INCOME' ? 'proof of income' : 'proof of employment'} letter: ${reason}`,
    category: 'documents',
    linkUrl: '/documents?tab=letters',
    emailFallback: true,
  });
  res.json({ ok: true });
});

verificationLettersRouter.get('/verification-letters/:id/pdf', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const l = await prisma.verificationLetter.findUnique({ where: { id } });
  if (!l) throw new HttpError(404, 'not_found', 'Letter not found.');
  const own = req.user!.associateId === l.associateId;
  if (!own && !hasCapability(req.user!.role, 'view:hr-admin')) throw new HttpError(404, 'not_found', 'Letter not found.');
  if (l.status !== 'APPROVED' || !l.snapshot) throw new HttpError(409, 'not_approved', 'This letter has not been approved.');
  const snapshot = l.snapshot as unknown as Snapshot;
  const kind = l.kind as 'EMPLOYMENT' | 'INCOME';
  const issuedAt = l.decidedAt ?? l.createdAt;
  const pdf = await renderLetterPdf({
    title: kind === 'INCOME' ? 'Verification of employment and income' : 'Verification of employment',
    body: letterBody(kind, snapshot, l.addressedTo, issuedAt),
    issuedAt,
    issuedTo: snapshot.person.name,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'verification_letter.downloaded', entityType: 'VerificationLetter', entityId: id, metadata: { own } }, 'verification_letter.downloaded');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="verification-${kind.toLowerCase()}-${issuedAt.toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
});
