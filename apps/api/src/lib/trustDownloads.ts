import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { TRUST_DOCUMENT_LABELS, type TrustDocumentKind, type TrustDocumentSummary, type TrustDownloadRequestInput, type TrustDownloadRequestSummary } from '@alto-people/shared';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { getBlobStore } from './blobStore.js';
import { getBrandingSync } from './branding.js';
import { publicBaseUrl } from './emailLayout.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { send } from './notifications.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Trust Center gated downloads (audit 2026-10-21; ux-upgrade §5.5 "gated
 * downloads behind a request"). The public page takes a request — name, work
 * email, company, which document. The operator approves it from the signed-in
 * Trust Center; the requester gets an email with a signed link that works for
 * seven days; GET /trust/downloads/:token streams the document the operator
 * uploaded for that kind. Every download is counted on the request and written
 * to the audit trail. Nothing is sent that was not approved by a person.
 */

type Db = PrismaClient;

export const LINK_DAYS = 7;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_MIMES = new Set(['application/pdf']);

/* ----------------------------------------------------------- signed links -- */

function secret(): string {
  return env.CALENDAR_FEED_SECRET ?? env.JWT_SECRET;
}

function sign(payload: string): Buffer {
  return createHmac('sha256', secret()).update(`trust-download:${payload}`, 'utf8').digest();
}

/** A link for one approved request: the id and its expiry, signed. */
export function mintDownloadToken(requestId: string, expiresAt: Date): string {
  const payload = Buffer.from(`${requestId}|${expiresAt.getTime()}`, 'utf8').toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

export type TokenCheck = { ok: true; requestId: string; expiresAt: Date } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyDownloadToken(token: string, now: Date = new Date()): TokenCheck {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' };
  const payload = token.slice(0, dot);
  let candidate: Buffer;
  let decoded: string;
  try {
    candidate = Buffer.from(token.slice(dot + 1), 'base64url');
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const expected = sign(payload);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return { ok: false, reason: 'invalid' };
  const [requestId, expMs] = decoded.split('|');
  const expiresAt = new Date(Number(expMs));
  if (!requestId || !Number.isFinite(expiresAt.getTime())) return { ok: false, reason: 'invalid' };
  if (expiresAt.getTime() < now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, requestId, expiresAt };
}

export function downloadUrl(token: string): string {
  return `${publicBaseUrl()}/api/trust/downloads/${token}`;
}

/* -------------------------------------------------------------- documents -- */

const documentSummary = (d: { id: string; kind: TrustDocumentKind; title: string; contentType: string; bytes: number; updatedAt: Date }): TrustDocumentSummary => ({
  id: d.id,
  kind: d.kind,
  title: d.title,
  contentType: d.contentType,
  bytes: d.bytes,
  updatedAt: d.updatedAt.toISOString(),
});

export async function listTrustDocuments(db: Db): Promise<TrustDocumentSummary[]> {
  const rows = await db.trustDocument.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { kind: 'asc' } });
  return rows.map(documentSummary);
}

/** One current file per kind: a new upload replaces the old one (the old blob is removed). */
export async function putTrustDocument(db: Db, input: { kind: TrustDocumentKind; title: string; content: Buffer; contentType: string }, actorUserId: string): Promise<TrustDocumentSummary> {
  if (!DOCUMENT_MIMES.has(input.contentType)) throw new HttpError(400, 'invalid_mime', 'Trust documents are PDFs.');
  if (input.content.byteLength === 0 || input.content.byteLength > MAX_DOCUMENT_BYTES) throw new HttpError(400, 'invalid_size', 'The file must be under 25 MB.');
  const tenantId = tenantIdForWrite();
  const s3Key = `trust/${tenantId}/${input.kind.toLowerCase()}-${Date.now()}.pdf`;
  await getBlobStore().put(s3Key, input.content, input.contentType);
  const previous = await db.trustDocument.findUnique({ where: { tenantId_kind: { tenantId, kind: input.kind } }, select: { s3Key: true } });
  const row = await db.trustDocument.upsert({
    where: { tenantId_kind: { tenantId, kind: input.kind } },
    create: { tenantId, kind: input.kind, title: input.title, s3Key, contentType: input.contentType, bytes: input.content.byteLength, uploadedByUserId: actorUserId },
    update: { title: input.title, s3Key, contentType: input.contentType, bytes: input.content.byteLength, uploadedByUserId: actorUserId },
  });
  if (previous && previous.s3Key !== s3Key) await getBlobStore().delete(previous.s3Key).catch(() => undefined);
  enqueueAudit({ actorUserId, clientId: null, tenantId, action: 'trust.document_uploaded', entityType: 'TrustDocument', entityId: row.id, metadata: { kind: input.kind, bytes: input.content.byteLength } }, 'trust');
  return documentSummary(row);
}

/* --------------------------------------------------------------- requests -- */

async function kindsOnFile(db: Db, tenantId: string): Promise<Set<TrustDocumentKind>> {
  const docs = await db.trustDocument.findMany({ where: { tenantId }, select: { kind: true } });
  return new Set(docs.map((d) => d.kind));
}

const requestSummary = (
  r: { id: string; kind: TrustDocumentKind; name: string; email: string; company: string; note: string | null; status: 'PENDING' | 'APPROVED' | 'DECLINED'; requestedAt: Date; decidedAt: Date | null; linkExpiresAt: Date | null; downloadCount: number; lastDownloadedAt: Date | null },
  onFile: Set<TrustDocumentKind>,
): TrustDownloadRequestSummary => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  email: r.email,
  company: r.company,
  note: r.note,
  status: r.status,
  requestedAt: r.requestedAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
  linkExpiresAt: r.linkExpiresAt?.toISOString() ?? null,
  downloadCount: r.downloadCount,
  lastDownloadedAt: r.lastDownloadedAt?.toISOString() ?? null,
  documentOnFile: onFile.has(r.kind),
});

/** The public form. One open request per email and kind: a second ask returns the first. */
export async function requestTrustDocument(db: Db, input: TrustDownloadRequestInput): Promise<{ id: string; status: 'PENDING' }> {
  const tenantId = tenantIdForWrite();
  const open = await db.trustDownloadRequest.findFirst({ where: { tenantId, email: input.email, kind: input.kind, status: 'PENDING' }, select: { id: true } });
  if (open) return { id: open.id, status: 'PENDING' };
  const row = await db.trustDownloadRequest.create({
    data: { tenantId, kind: input.kind, name: input.name, email: input.email, company: input.company, note: input.note ?? null },
    select: { id: true },
  });
  enqueueAudit({ actorUserId: null, clientId: null, tenantId, action: 'trust.document_requested', entityType: 'TrustDownloadRequest', entityId: row.id, metadata: { kind: input.kind, company: input.company } }, 'trust');
  return { id: row.id, status: 'PENDING' };
}

export async function listTrustRequests(db: Db): Promise<TrustDownloadRequestSummary[]> {
  const tenantId = tenantIdForWrite();
  const [rows, onFile] = await Promise.all([
    db.trustDownloadRequest.findMany({ where: { tenantId }, orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }], take: 200 }),
    kindsOnFile(db, tenantId),
  ]);
  return rows.map((r) => requestSummary(r, onFile));
}

/**
 * Approve: the request gets its expiry, and the requester an email with the
 * signed link. Refused when no document of that kind is on file — approving
 * nothing would send a link to a 404. Decline: recorded, no email.
 */
export async function decideTrustRequest(db: Db, id: string, decision: 'APPROVED' | 'DECLINED', actorUserId: string, now: Date = new Date()): Promise<TrustDownloadRequestSummary> {
  const tenantId = tenantIdForWrite();
  const r = await db.trustDownloadRequest.findFirst({ where: { id, tenantId } });
  if (!r) throw new HttpError(404, 'not_found', 'No such request.');
  if (r.status !== 'PENDING') throw new HttpError(409, 'already_decided', `This request was already ${r.status.toLowerCase()}.`);
  const onFile = await kindsOnFile(db, tenantId);
  if (decision === 'APPROVED' && !onFile.has(r.kind)) {
    throw new HttpError(409, 'no_document', `Upload the ${TRUST_DOCUMENT_LABELS[r.kind].toLowerCase()} first; there is nothing to send yet.`);
  }
  const linkExpiresAt = decision === 'APPROVED' ? new Date(now.getTime() + LINK_DAYS * 86_400_000) : null;
  const updated = await db.trustDownloadRequest.update({ where: { id: r.id }, data: { status: decision, decidedAt: now, decidedByUserId: actorUserId, linkExpiresAt } });
  enqueueAudit({ actorUserId, clientId: null, tenantId, action: decision === 'APPROVED' ? 'trust.request_approved' : 'trust.request_declined', entityType: 'TrustDownloadRequest', entityId: r.id, metadata: { kind: r.kind, email: r.email, company: r.company } }, 'trust');
  if (decision === 'APPROVED' && linkExpiresAt) {
    const url = downloadUrl(mintDownloadToken(r.id, linkExpiresAt));
    const org = getBrandingSync().orgName;
    const label = TRUST_DOCUMENT_LABELS[r.kind];
    const tpl = genericNotificationTemplate({
      subject: `${org}: your ${label} is ready`,
      body: `Hello ${r.name},\n\nYour request for the ${org} ${label} was approved. The link below works for ${LINK_DAYS} days and is for ${r.company}'s security review only. Please do not forward it.`,
      linkUrl: url,
    });
    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: r.email },
      subject: `${org}: your ${label} is ready`,
      body: `${tpl.text}\n\n${url}`,
      html: tpl.html,
      category: 'trust_download',
    });
  }
  return requestSummary(updated, onFile);
}

/** The signed link: the document's bytes, the download counted and audited. */
export async function openTrustDownload(db: Db, token: string, now: Date = new Date()): Promise<{ content: Buffer; contentType: string; filename: string }> {
  const check = verifyDownloadToken(token, now);
  if (!check.ok) {
    if (check.reason === 'expired') throw new HttpError(410, 'link_expired', 'This link has expired. Ask for the document again on the Trust Center.');
    throw new HttpError(404, 'not_found', 'No such link.');
  }
  const r = await db.trustDownloadRequest.findUnique({ where: { id: check.requestId } });
  if (!r || r.status !== 'APPROVED' || !r.linkExpiresAt) throw new HttpError(404, 'not_found', 'No such link.');
  if (r.linkExpiresAt.getTime() < now.getTime()) throw new HttpError(410, 'link_expired', 'This link has expired. Ask for the document again on the Trust Center.');
  const doc = await db.trustDocument.findFirst({ where: { tenantId: r.tenantId, kind: r.kind } });
  if (!doc) throw new HttpError(404, 'not_found', 'The document is no longer on file.');
  const content = await getBlobStore().get(doc.s3Key);
  if (!content) throw new HttpError(404, 'not_found', 'The document is no longer on file.');
  await db.trustDownloadRequest.update({ where: { id: r.id }, data: { downloadCount: { increment: 1 }, lastDownloadedAt: now } });
  enqueueAudit({ actorUserId: null, clientId: null, tenantId: r.tenantId, action: 'trust.document_downloaded', entityType: 'TrustDownloadRequest', entityId: r.id, metadata: { kind: r.kind, email: r.email, company: r.company, documentId: doc.id } }, 'trust');
  return { content, contentType: doc.contentType, filename: `${doc.title.replace(/[^\w.-]+/g, '-')}.pdf` };
}
