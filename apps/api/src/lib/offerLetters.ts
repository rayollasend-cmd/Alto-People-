import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { getBlobStore } from './blobStore.js';
import { renderLetterPdf } from './letterPdf.js';
import { recordDocumentEvent } from './audit.js';

/**
 * Offer-letter automation.
 *
 * The compliance scorecard's "Offer letter on file" signal counts filed
 * OFFER_LETTER documents. Three producers feed it, all through this module
 * so the letters are byte-for-byte the same artifact:
 *
 *   1. the Templates page (single render + "generate for everyone missing
 *      one" bulk button) — routes/docTemplates.ts;
 *   2. the approval hook — approving an application files the letter
 *      immediately (routes/onboarding.ts);
 *   3. the background sweep — a periodic catch-all that backfills any
 *      approved associate still missing one (covers people approved before
 *      this existed, and approvals that skipped because the template or a
 *      data field wasn't ready yet).
 *
 * Every path shares the same guardrail: a letter whose template tokens
 * resolve to nothing for that person is NEVER filed — auto-writing letters
 * with blanked fields as VERIFIED compliance evidence would be worse than
 * the gap they fix.
 */

/* ----- Token renderer (shared with routes/docTemplates.ts) -------------- */

// Token regex: {{ x }} or {{x}}. Whitespace OK; no nested braces.
const TOKEN_RE = /\{\{\s*([\w$.[\]]+)\s*\}\}/g;

function pathLookup(data: unknown, path: string): unknown {
  // Support dot + bracket index: a.b[0].c
  const parts = path.split(/\.|\[|\]/).filter(Boolean);
  let cur: unknown = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function renderTemplateTokens(
  template: string,
  data: unknown,
): { text: string; unresolvedTokens: string[] } {
  // Track every token that resolved to nothing — a typo'd
  // {{associate.firstname}} used to silently produce an offer letter
  // with a blank name.
  const unresolved = new Set<string>();
  const text = template.replace(TOKEN_RE, (_full, path: string) => {
    const v = pathLookup(data, path);
    if (v == null) {
      unresolved.add(path.trim());
      return '';
    }
    return String(v);
  });
  return { text, unresolvedTokens: [...unresolved] };
}

/* ----- Associate render context ----------------------------------------- */

/** Associate fields exposed to templates — one definition everywhere so
 *  {{associate.*}} resolves identically in every producer. */
export const ASSOCIATE_CTX_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  state: true,
  department: { select: { name: true } },
  jobProfile: { select: { title: true } },
} as const;

export type AssociateCtxRow = Prisma.AssociateGetPayload<{
  select: typeof ASSOCIATE_CTX_SELECT;
}>;

export function toAssociateCtx(a: AssociateCtxRow): Record<string, unknown> {
  return {
    ...a,
    department: a.department?.name ?? null,
    jobTitle: a.jobProfile?.title ?? null,
  };
}

export function slugifyTitle(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) ||
    'offer-letter'
  );
}

/* ----- Filing ------------------------------------------------------------ */

/** Render the letter to PDF, store the blob, file it in the associate's
 *  vault as a VERIFIED OFFER_LETTER, and audit — returns the document id. */
export async function fileOfferLetterPdf(opts: {
  templateId: string;
  templateClientId: string | null;
  renderId: string;
  title: string;
  body: string;
  associate: { id: string; firstName: string; lastName: string };
  /** Null for the background sweep — the audit row then names the system. */
  userId: string | null;
  req?: Request;
}): Promise<string> {
  const issuedAt = new Date();
  const pdf = await renderLetterPdf({
    title: opts.title,
    body: opts.body,
    issuedAt,
    issuedTo: `${opts.associate.firstName} ${opts.associate.lastName}`,
  });
  const relativeKey = `letters/${opts.renderId}.pdf`;
  await getBlobStore().put(relativeKey, pdf, 'application/pdf');
  const filed = await prisma.documentRecord.create({
    data: {
      associateId: opts.associate.id,
      clientId: opts.templateClientId,
      kind: 'OFFER_LETTER',
      s3Key: relativeKey,
      filename: `${slugifyTitle(opts.title)}.pdf`,
      mimeType: 'application/pdf',
      size: pdf.byteLength,
      // Issued from a curated, published template — same VERIFIED posture
      // as the admin upload path.
      status: 'VERIFIED',
      verifiedById: opts.userId,
      verifiedAt: issuedAt,
    },
  });
  await recordDocumentEvent({
    actorUserId: opts.userId,
    action: 'document.generated_from_template',
    documentId: filed.id,
    associateId: opts.associate.id,
    clientId: opts.templateClientId,
    metadata: {
      templateId: opts.templateId,
      renderId: opts.renderId,
      kind: 'OFFER_LETTER',
    },
    req: opts.req,
  });
  return filed.id;
}

/* ----- Auto-file: approval hook + sweep ---------------------------------- */

export type AutoFileOutcome =
  | 'filed'
  | 'already_on_file'
  | 'no_template'
  | 'unresolved_tokens'
  | 'no_associate';

/** The published offer-letter template for a client: client-specific wins,
 *  else the global (clientId null) one. Null when neither exists. */
export async function resolveOfferTemplate(clientId: string | null) {
  const candidates = await prisma.documentTemplate.findMany({
    where: {
      kind: 'OFFER_LETTER',
      deletedAt: null,
      currentVersionId: { not: null },
      OR: [{ clientId }, { clientId: null }],
    },
    include: { currentVersion: true },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });
  const pick =
    candidates.find((t) => t.clientId !== null && t.clientId === clientId) ??
    candidates.find((t) => t.clientId === null) ??
    null;
  if (!pick?.currentVersion) return null;
  return { template: pick, version: pick.currentVersion };
}

/**
 * File the offer letter for one associate, if it is safe and needed.
 * Never throws for expected conditions — the approval hook and the sweep
 * both treat the outcome as a report, not an error.
 */
export async function autoFileOfferLetter(opts: {
  associateId: string;
  clientId: string | null;
  actorUserId: string | null;
  req?: Request;
}): Promise<AutoFileOutcome> {
  const existing = await prisma.documentRecord.findFirst({
    where: { associateId: opts.associateId, kind: 'OFFER_LETTER', deletedAt: null },
    select: { id: true },
  });
  if (existing) return 'already_on_file';

  const resolved = await resolveOfferTemplate(opts.clientId);
  if (!resolved) return 'no_template';
  const { template, version } = resolved;

  const a = await prisma.associate.findFirst({
    where: { id: opts.associateId, deletedAt: null },
    select: ASSOCIATE_CTX_SELECT,
  });
  if (!a) return 'no_associate';

  const ctx = { associate: toAssociateCtx(a) };
  const bodyResult = renderTemplateTokens(version.body, ctx);
  const subjectResult = version.subject
    ? renderTemplateTokens(version.subject, ctx)
    : null;
  if (
    bodyResult.unresolvedTokens.length > 0 ||
    (subjectResult?.unresolvedTokens.length ?? 0) > 0
  ) {
    return 'unresolved_tokens';
  }

  const createdRender = await prisma.documentRender.create({
    data: {
      templateId: template.id,
      versionId: version.id,
      associateId: opts.associateId,
      renderedSubject: subjectResult?.text ?? null,
      renderedBody: bodyResult.text,
      data: ctx as Prisma.InputJsonValue,
      renderedById: opts.actorUserId,
    },
  });
  await fileOfferLetterPdf({
    templateId: template.id,
    templateClientId: template.clientId,
    renderId: createdRender.id,
    title: subjectResult?.text.trim() || template.name,
    body: bodyResult.text,
    associate: a,
    userId: opts.actorUserId,
    req: opts.req,
  });
  return 'filed';
}

/**
 * Backfill sweep: every associate in the scorecard population
 * (most-recent application APPROVED) with no OFFER_LETTER document gets
 * one filed from their client's template. Capped per tick; the next tick
 * continues. Skip reasons are counted, not fatal.
 */
const SWEEP_CAP = 200;

export async function runOfferLetterSweep(): Promise<{
  filed: number;
  skipped: Partial<Record<AutoFileOutcome, number>>;
}> {
  const apps = await prisma.application.findMany({
    take: 500,
    where: { status: 'APPROVED', deletedAt: null, associate: { deletedAt: null } },
    select: { associateId: true, clientId: true },
    orderBy: { createdAt: 'desc' },
  });
  // Most-recent approved application per associate decides the client
  // (and therefore which template applies).
  const clientByAssociate = new Map<string, string>();
  for (const a of apps) {
    if (!clientByAssociate.has(a.associateId)) {
      clientByAssociate.set(a.associateId, a.clientId);
    }
  }
  const ids = [...clientByAssociate.keys()];
  if (ids.length === 0) return { filed: 0, skipped: {} };

  const existing = await prisma.documentRecord.findMany({
    take: 1000,
    where: { associateId: { in: ids }, kind: 'OFFER_LETTER', deletedAt: null },
    select: { associateId: true },
  });
  const hasLetter = new Set(existing.map((d) => d.associateId));
  const missing = ids.filter((id) => !hasLetter.has(id)).slice(0, SWEEP_CAP);

  let filed = 0;
  const skipped: Partial<Record<AutoFileOutcome, number>> = {};
  // Sequential on purpose — PDF render + blob write per row; a background
  // sweep has no reason to spike the event loop.
  for (const associateId of missing) {
    try {
      const outcome = await autoFileOfferLetter({
        associateId,
        clientId: clientByAssociate.get(associateId) ?? null,
        actorUserId: null,
      });
      if (outcome === 'filed') filed += 1;
      else skipped[outcome] = (skipped[outcome] ?? 0) + 1;
    } catch (err) {
      console.error('[alto-people/api] offer-letter sweep row failed:', err);
    }
  }
  return { filed, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startOfferLetterCron(): void {
  if (timer) return;
  const seconds = env.OFFER_LETTER_SWEEP_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void runOfferLetterSweep()
      .then((r) => {
        if (r.filed > 0) {
          console.log(`[alto-people/api] offer-letter sweep filed ${r.filed} letter(s)`);
        }
      })
      .catch((err) => {
        console.error('[alto-people/api] offer-letter sweep failed:', err);
      });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] offer-letter sweep armed (every ${seconds}s; cap ${SWEEP_CAP}/tick)`,
  );
}

export function stopOfferLetterCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
