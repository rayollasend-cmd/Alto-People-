import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Soc2ReportInputSchema, TrustDocumentMetaSchema, TrustDownloadRequestInputSchema, TrustRequestDecisionSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { loginIpLimiter } from '../middleware/rateLimit.js';
import { enqueueAudit } from '../lib/audit.js';
import { __resetTrustCacheForTests, trustSummary, trustSummaryPublic } from '../lib/trustCenter.js';
import { MAX_DOCUMENT_BYTES, decideTrustRequest, listTrustDocuments, listTrustRequests, openTrustDownload, putTrustDocument, requestTrustDocument } from '../lib/trustDownloads.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * The Trust Center (UX upgrade step 4; gated downloads and SOC 2 progress,
 * audit 2026-10-21).
 *
 *   GET  /trust/public             no sign-in: statuses, dates, counts, the
 *                                  sub-processor list, the commitments and the
 *                                  SOC 2 stage. Cached a minute; rate-limited
 *                                  like the login page. Never a control's
 *                                  detail, an address or an identifier.
 *   POST /trust/public/requests    no sign-in: ask for a report (name, work
 *                                  email, company, which document). Rate-limited.
 *   GET  /trust/downloads/:token   no sign-in: the signed, expiring link an
 *                                  approved requester received. 410 once expired.
 *   GET  /trust                    the signed-in view (manage:org, view:executive
 *                                  or view:audit).
 *   GET  /trust/requests           the requests, newest first      (manage:org)
 *   POST /trust/requests/:id       approve (emails the link) or decline
 *   GET  /trust/documents          the documents on file, one per kind
 *   POST /trust/documents          upload or replace one (PDF, 25 MB)
 *   PUT  /trust/soc2               the auditor's report date, or null
 */
export const trustRouter = Router();

const MANAGE = requireCapability('manage:org');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } });

trustRouter.get('/public', loginIpLimiter, async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(await trustSummaryPublic(prisma));
});

trustRouter.post('/public/requests', loginIpLimiter, async (req, res) => {
  const parsed = TrustDownloadRequestInputSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Name, work email, company and the document are needed.', parsed.error.flatten());
  res.status(202).json(await requestTrustDocument(prisma, parsed.data));
});

trustRouter.get('/downloads/:token', loginIpLimiter, async (req, res) => {
  const token = z.string().min(8).max(400).parse(req.params.token);
  const file = await openTrustDownload(prisma, token);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.content);
});

trustRouter.get('/', requireAnyCapability('manage:org', 'view:executive', 'view:audit'), async (_req, res) => {
  res.json(await trustSummary(prisma, tenantIdForWrite()));
});

trustRouter.get('/requests', MANAGE, async (_req, res) => {
  res.json({ requests: await listTrustRequests(prisma) });
});

trustRouter.post('/requests/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { decision } = TrustRequestDecisionSchema.parse(req.body);
  res.json(await decideTrustRequest(prisma, id, decision, req.user!.id));
});

trustRouter.get('/documents', MANAGE, async (_req, res) => {
  res.json({ documents: await listTrustDocuments(prisma) });
});

trustRouter.post('/documents', MANAGE, upload.single('file'), async (req, res) => {
  const meta = TrustDocumentMetaSchema.parse(req.body);
  if (!req.file) throw new HttpError(400, 'no_file', 'Attach the PDF.');
  res.status(201).json(await putTrustDocument(prisma, { kind: meta.kind, title: meta.title, content: req.file.buffer, contentType: req.file.mimetype }, req.user!.id));
});

trustRouter.put('/soc2', MANAGE, async (req, res) => {
  const { reportIssuedOn } = Soc2ReportInputSchema.parse(req.body);
  const value = reportIssuedOn ? new Date(`${reportIssuedOn}T00:00:00.000Z`) : null;
  await prisma.orgSetting.upsert({ where: { tenantId: tenantIdForWrite() }, create: { tenantId: tenantIdForWrite(), soc2ReportIssuedOn: value }, update: { soc2ReportIssuedOn: value } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: tenantIdForWrite(), action: 'trust.soc2_report_dated', entityType: 'OrgSetting', entityId: 'singleton', metadata: { reportIssuedOn } }, 'trust');
  __resetTrustCacheForTests();
  res.json({ reportIssuedOn });
});
