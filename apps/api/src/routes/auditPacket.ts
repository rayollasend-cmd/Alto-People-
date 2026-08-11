import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { bulkPiiExportLimiter } from '../middleware/rateLimit.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { getBlobStore } from '../lib/blobStore.js';
import { COMPANY_INFO, formatRef } from '../lib/emailTemplates.js';
import { ALTO_POLICIES } from '../lib/altoHrContent.js';
import { buildPaystubDataFromItem, paystubItemInclude } from '../lib/paystubData.js';
import { renderPaystubPdf } from '../lib/paystub.js';
import { ReportPdf } from '../lib/reportPdf.js';

/**
 * Client-audit packet generator.
 *
 * Built for the recurring vendor-compliance audits our clients run
 * (Walmart's scope letter is the template): one download assembles the
 * entire response — worker roster, Form I-9s with identity documents,
 * E-Verify confirmations, signed attestation letters for the legal-history
 * items, pay-lawfulness evidence (punches, pay register, paystubs,
 * externally-processed payments), the harassment-reporting process with
 * its acknowledgment log, and the background-check register — as one ZIP
 * whose numbered folders mirror the audit scope.
 *
 * Presentation standard: every human-facing artifact is a letterheaded,
 * page-numbered PDF in the house style (lib/reportPdf); each register also
 * ships a CSV twin for the auditor's data team. Nothing in the packet is
 * bare text.
 *
 * This is the single largest PII export in the product (I-9 images, SSN
 * cards, pay data for a whole roster in one file), so it takes the same
 * posture as the SSN reveal: view:hr-admin, a written reason, the bulk-PII
 * rate limiter, and a CRITICAL audit row persisted before the first byte
 * streams.
 */

export const auditPacketRouter = Router();

const HR_ADMIN = requireCapability('view:hr-admin');

const GenerateInputSchema = z.object({
  /**
   * CLIENT_PERIOD — workers tied to one client during the period (vendor
   * audits). ALL_WORKFORCE — every associate who has EVER worked for the
   * company; the period still bounds the pay/time sections. INDIVIDUAL —
   * one associate's complete evidence file for the period (wage claims,
   * subpoenas, single-worker I-9 inspections).
   */
  scope: z.enum(['CLIENT_PERIOD', 'ALL_WORKFORCE', 'INDIVIDUAL']).default('CLIENT_PERIOD'),
  clientId: z.string().uuid().optional(),
  associateId: z.string().uuid().optional(),
  /** Calendar dates, YYYY-MM-DD, inclusive. */
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  reason: z.string().trim().min(10).max(500),
});

/* ----- small helpers ----------------------------------------------------- */

const csvCell = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: Array<Array<string | number | null | undefined>>): string =>
  rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const ymd = (d: Date | null | undefined): string =>
  d ? d.toISOString().slice(0, 10) : '';
const iso = (d: Date | null | undefined): string => (d ? d.toISOString() : '');
const money = (v: unknown): string =>
  v === null || v === undefined ? '' : `$${Number(v).toFixed(2)}`;

const safeName = (s: string): string =>
  s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';

/* ----- the generator ------------------------------------------------------ */

auditPacketRouter.post(
  '/generate',
  HR_ADMIN,
  bulkPiiExportLimiter,
  async (req: Request, res: Response) => {
    const input = GenerateInputSchema.parse(req.body);
    if (input.periodEnd < input.periodStart) {
      throw new HttpError(400, 'invalid_period', 'periodEnd must be on or after periodStart.');
    }
    if (input.scope === 'CLIENT_PERIOD' && !input.clientId) {
      throw new HttpError(400, 'client_required', 'clientId is required for a client-scoped packet.');
    }
    if (input.scope === 'INDIVIDUAL' && !input.associateId) {
      throw new HttpError(400, 'associate_required', 'associateId is required for an individual packet.');
    }
    const start = new Date(`${input.periodStart}T00:00:00Z`);
    const endExcl = new Date(`${input.periodEnd}T00:00:00Z`);
    endExcl.setUTCDate(endExcl.getUTCDate() + 1);

    const client =
      input.scope === 'CLIENT_PERIOD'
        ? await prisma.client.findFirst({
            where: { id: input.clientId!, deletedAt: null },
            select: { id: true, name: true },
          })
        : null;
    if (input.scope === 'CLIENT_PERIOD' && !client) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }

    /* Roster derivation per scope.
     *
     * CLIENT_PERIOD — the union of three corroborating signals tying a
     * worker to the client during the period: site assignments, approved
     * worked time (client snapshotted at clock-in), and schedule-COMPLETED
     * shifts. Union, because each source catches the others' blind spots.
     *
     * ALL_WORKFORCE — every associate who has ever worked for the company,
     * separated or not; the period bounds the transactional sections only.
     *
     * INDIVIDUAL — exactly one associate, whatever their current status.
     *
     * Assignment/time/shift context is loaded in every scope (client-
     * filtered only for CLIENT_PERIOD) so the roster's sites and worked-
     * footprint columns stay populated. */
    const locations = await prisma.location.findMany({
      where: { ...(client ? { clientId: client.id } : {}), deletedAt: null },
      select: { id: true, name: true },
    });
    const locationName = new Map(locations.map((l) => [l.id, l.name]));
    const associateFilter =
      input.scope === 'INDIVIDUAL' ? { associateId: input.associateId! } : {};

    const [assignments, workedEntries, completedShifts] = await Promise.all([
      prisma.associateAssignment.findMany({
        where: {
          ...(client ? { locationId: { in: locations.map((l) => l.id) } } : {}),
          ...associateFilter,
          startedAt: { lt: endExcl },
          OR: [{ endedAt: null }, { endedAt: { gte: start } }],
        },
        select: { associateId: true, locationId: true, startedAt: true, endedAt: true },
      }),
      prisma.timeEntry.findMany({
        where: {
          ...(client ? { clientId: client.id } : {}),
          ...associateFilter,
          status: 'APPROVED',
          clockInAt: { gte: start, lt: endExcl },
        },
        select: {
          associateId: true,
          clockInAt: true,
          clockOutAt: true,
          status: true,
          locationId: true,
          breaks: { select: { startedAt: true, endedAt: true } },
        },
        orderBy: { clockInAt: 'asc' },
        take: 50_000,
      }),
      prisma.shift.findMany({
        where: {
          ...(client ? { clientId: client.id } : {}),
          ...(input.scope === 'INDIVIDUAL'
            ? { assignedAssociateId: input.associateId! }
            : { assignedAssociateId: { not: null } }),
          status: 'COMPLETED',
          startsAt: { gte: start, lt: endExcl },
        },
        select: { assignedAssociateId: true },
      }),
    ]);

    let rosterIds: string[];
    if (input.scope === 'INDIVIDUAL') {
      rosterIds = [input.associateId!];
    } else if (input.scope === 'ALL_WORKFORCE') {
      const everyone = await prisma.associate.findMany({ select: { id: true } });
      rosterIds = everyone.map((a) => a.id);
    } else {
      rosterIds = [
        ...new Set([
          ...assignments.map((a) => a.associateId),
          ...workedEntries.map((e) => e.associateId),
          ...completedShifts.map((s) => s.assignedAssociateId!),
        ]),
      ];
    }
    if (rosterIds.length === 0) {
      throw new HttpError(
        404,
        'empty_roster',
        input.scope === 'CLIENT_PERIOD'
          ? 'No workers were assigned to, worked approved time at, or completed shifts for this client in the selected period.'
          : 'No workers matched this scope.',
      );
    }

    // NO deletedAt filter — the audit covers the PERIOD, so a worker who
    // provided services in March and separated in June belongs on the
    // list. Their current status is disclosed instead of the row being
    // silently dropped. (Privacy-erased associates appear with their
    // anonymized identity; the manifest notes this.)
    const associates = await prisma.associate.findMany({
      where: { id: { in: rosterIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        employmentType: true,
        deletedAt: true,
        erasedAt: true,
        i9Verification: {
          select: {
            citizenshipStatus: true,
            section1CompletedAt: true,
            section2CompletedAt: true,
            documentList: true,
            supportingDocIds: true,
            section2Verifier: { select: { email: true } },
            eVerifyCaseNumber: true,
            eVerifyStatus: true,
            eVerifyCaseOpenedAt: true,
            eVerifyClosedAt: true,
          },
        },
        applications: {
          // Client scope: the position they held FOR that client. Other
          // scopes: their most recent engagement, whichever client.
          where: { deletedAt: null, ...(client ? { clientId: client.id } : {}) },
          orderBy: { invitedAt: 'desc' },
          take: 1,
          select: { position: true, startDate: true, status: true },
        },
        backgroundChecks: {
          select: { provider: true, status: true, initiatedAt: true, completedAt: true },
          orderBy: { initiatedAt: 'desc' },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    const refId = formatRef();
    const generatedAt = new Date();
    const periodLabel = `${input.periodStart} to ${input.periodEnd}`;
    const subjectAssociate = input.scope === 'INDIVIDUAL' ? associates[0] : null;
    if (input.scope === 'INDIVIDUAL' && !subjectAssociate) {
      throw new HttpError(404, 'associate_not_found', 'Associate not found');
    }
    const audience =
      input.scope === 'CLIENT_PERIOD'
        ? `${client!.name} vendor-compliance audit`
        : input.scope === 'ALL_WORKFORCE'
          ? 'company-wide workforce compliance audit'
          : `individual personnel audit — ${subjectAssociate!.firstName} ${subjectAssociate!.lastName}`;
    /** Standard letterhead facts column, shared by every PDF in the packet. */
    const facts = (extra?: Array<{ label: string; value: string }>) => [
      { label: 'Prepared for', value: audience },
      { label: 'Audit period', value: periodLabel },
      { label: 'Generated', value: generatedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' },
      ...(extra ?? []),
    ];
    const confidentialityNote = `CONFIDENTIAL — prepared solely for the ${audience}. Handle per the data-handling terms of the applicable MSA.`;

    // The audit row lands BEFORE any PII streams — same rule as the SSN
    // reveal: a missing row is the difference between an audited
    // disclosure and silent exfiltration.
    // ALL_WORKFORCE gets its own action name — it is the maximum possible
    // PII export and must be findable at a glance in the audit feed.
    const auditAction =
      input.scope === 'ALL_WORKFORCE'
        ? 'compliance.audit_packet_generated_workforce'
        : 'compliance.audit_packet_generated';
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        clientId: client?.id ?? null,
        action: auditAction,
        entityType: client ? 'Client' : subjectAssociate ? 'Associate' : 'Organization',
        entityId: client?.id ?? subjectAssociate?.id ?? 'ALL_WORKFORCE',
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          scope: input.scope,
          reason: input.reason,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          workerCount: associates.length,
          reference: refId,
        },
      },
      auditAction,
    );

    const { default: archiver } = await import('archiver');
    const zipStem =
      input.scope === 'CLIENT_PERIOD'
        ? safeName(client!.name)
        : input.scope === 'ALL_WORKFORCE'
          ? 'workforce'
          : safeName(`${subjectAssociate!.lastName}-${subjectAssociate!.firstName}`);
    const zipName = `audit-packet-${zipStem}-${input.periodStart}-to-${input.periodEnd}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err: Error) => {
      console.error('[audit-packet] archive error', err);
      res.destroy(err);
    });
    archive.pipe(res);

    const blobStore = getBlobStore();

    /* 01 — Worker roster --------------------------------------------------- */
    // Every row carries its PROVENANCE: which signal(s) put the worker on
    // this list, the assignment span, and the actually-worked footprint.
    // An auditor (and the officer reviewing before transmission) can see
    // the evidentiary basis per person instead of trusting a bare list.
    const netMinutesOf = (e: (typeof workedEntries)[number]): number => {
      if (!e.clockOutAt) return 0;
      const end = e.clockOutAt.getTime();
      let ms = end - e.clockInAt.getTime();
      for (const b of e.breaks) {
        const bEnd = b.endedAt ? b.endedAt.getTime() : end;
        ms -= Math.max(0, bEnd - b.startedAt.getTime());
      }
      return Math.max(0, Math.round(ms / 60_000));
    };
    const assignmentsByAssociate = new Map<string, typeof assignments>();
    for (const a of assignments) {
      const arr = assignmentsByAssociate.get(a.associateId) ?? [];
      arr.push(a);
      assignmentsByAssociate.set(a.associateId, arr);
    }
    const workByAssociate = new Map<
      string,
      { first: Date; last: Date; netMinutes: number; punches: number }
    >();
    for (const e of workedEntries) {
      const w = workByAssociate.get(e.associateId);
      const mins = netMinutesOf(e);
      if (!w) {
        workByAssociate.set(e.associateId, {
          first: e.clockInAt,
          last: e.clockInAt,
          netMinutes: mins,
          punches: 1,
        });
      } else {
        if (e.clockInAt < w.first) w.first = e.clockInAt;
        if (e.clockInAt > w.last) w.last = e.clockInAt;
        w.netMinutes += mins;
        w.punches += 1;
      }
    }
    const shiftCountByAssociate = new Map<string, number>();
    for (const s of completedShifts) {
      const id = s.assignedAssociateId!;
      shiftCountByAssociate.set(id, (shiftCountByAssociate.get(id) ?? 0) + 1);
    }
    const sitesFor = (associateId: string): string =>
      [
        ...new Set(
          (assignmentsByAssociate.get(associateId) ?? []).map(
            (x) => locationName.get(x.locationId) ?? x.locationId,
          ),
        ),
      ].join('; ');
    const assignmentSpanFor = (associateId: string): string => {
      const rows = assignmentsByAssociate.get(associateId) ?? [];
      if (rows.length === 0) return '';
      const from = rows.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), rows[0].startedAt);
      const open = rows.some((r) => r.endedAt === null);
      const to = open
        ? 'present'
        : ymd(rows.reduce((m, r) => (r.endedAt! > m ? r.endedAt! : m), rows[0].endedAt!));
      return `${ymd(from)} → ${to}`;
    };
    const basisFor = (associateId: string): string => {
      const parts: string[] = [];
      if (assignmentsByAssociate.has(associateId)) parts.push('Site assignment');
      if (workByAssociate.has(associateId)) parts.push('Approved worked time');
      if (shiftCountByAssociate.has(associateId)) parts.push('Completed shifts');
      // Workforce/individual scopes include people with no period activity
      // — their membership rests on the employment record itself.
      return parts.join(' · ') || 'Employment record';
    };
    const workedSummaryFor = (associateId: string): string => {
      const w = workByAssociate.get(associateId);
      if (!w) return '—';
      return `${ymd(w.first)} → ${ymd(w.last)} · ${(w.netMinutes / 60).toFixed(1)}h`;
    };
    const statusOf = (a: { deletedAt: Date | null; erasedAt: Date | null }): string =>
      a.erasedAt ? 'Separated (record anonymized)' : a.deletedAt ? 'Separated' : 'Active';
    const separatedCount = associates.filter((a) => a.deletedAt !== null).length;

    {
      const pdf = new ReportPdf({
        title: 'Worker Roster',
        subtitle:
          input.scope === 'CLIENT_PERIOD'
            ? `Workers providing services on ${client!.name} properties during the audit period. Inclusion is evidence-based — the union of site assignment records, approved worked time, and schedule-completed shifts; each row states its basis. Workers who separated after providing services in the period remain listed with their status.`
            : input.scope === 'ALL_WORKFORCE'
              ? 'Every associate who has ever worked for the Company, current and separated. The worked-footprint columns reflect activity within the audit period; workers without period activity are included on the strength of their employment record.'
              : `Complete personnel evidence file for ${subjectAssociate!.firstName} ${subjectAssociate!.lastName}, covering the audit period.`,
        facts: facts([
          { label: 'Workers', value: String(associates.length) },
          ...(separatedCount > 0
            ? [{ label: 'Of which separated', value: String(separatedCount) }]
            : []),
        ]),
        reference: refId,
        confidentialityNote,
      });
      pdf.table(
        [
          { label: 'Worker', width: 104 },
          { label: 'Position', width: 66 },
          { label: 'Status', width: 58 },
          { label: 'Site(s)' },
          { label: 'Inclusion basis', width: 92 },
          { label: 'Worked (period)', width: 92 },
          { label: 'I-9', width: 46 },
        ],
        associates.map((a) => {
          const i9 = a.i9Verification;
          return [
            `${a.lastName}, ${a.firstName}`,
            a.applications[0]?.position ?? '',
            statusOf(a),
            sitesFor(a.id) || '—',
            basisFor(a.id),
            workedSummaryFor(a.id),
            i9?.section1CompletedAt && i9?.section2CompletedAt ? 'Complete' : 'Incomplete',
          ];
        }),
      );
      archive.append(await pdf.render(), { name: '01-worker-roster/worker-roster.pdf' });
    }
    archive.append(
      csv([
        ['Last name', 'First name', 'Email', 'Position', 'Employment type', 'Employment status', 'Client start date', 'Site(s)', 'Assignment span', 'Inclusion basis', 'First worked', 'Last worked', 'Net hours (period)', 'Approved punches', 'Completed shifts', 'I-9 complete', 'E-Verify case'],
        ...associates.map((a) => {
          const app = a.applications[0];
          const i9 = a.i9Verification;
          const w = workByAssociate.get(a.id);
          return [
            a.lastName,
            a.firstName,
            a.email,
            app?.position ?? '',
            a.employmentType,
            statusOf(a),
            ymd(app?.startDate ?? null),
            sitesFor(a.id),
            assignmentSpanFor(a.id),
            basisFor(a.id),
            w ? ymd(w.first) : '',
            w ? ymd(w.last) : '',
            w ? (w.netMinutes / 60).toFixed(2) : '',
            w?.punches ?? 0,
            shiftCountByAssociate.get(a.id) ?? 0,
            i9?.section1CompletedAt && i9?.section2CompletedAt ? 'Yes' : 'No',
            i9?.eVerifyCaseNumber ?? '',
          ];
        }),
      ]),
      { name: '01-worker-roster/worker-roster.csv' },
    );

    /* 02 — Form I-9s + identity documents ---------------------------------- */
    const i9DocKinds = ['ID', 'SSN_CARD', 'I9_SUPPORTING', 'J1_VISA', 'J1_DS2019'] as const;
    const i9Docs = await prisma.documentRecord.findMany({
      where: {
        associateId: { in: rosterIds },
        deletedAt: null,
        status: { notIn: ['REJECTED', 'EXPIRED'] },
        kind: { in: [...i9DocKinds] },
      },
      select: {
        associateId: true,
        kind: true,
        filename: true,
        s3Key: true,
        i9DocTitle: true,
        i9List: true,
        side: true,
        verifiedAt: true,
      },
    });
    const docsByAssociate = new Map<string, typeof i9Docs>();
    for (const d of i9Docs) {
      const arr = docsByAssociate.get(d.associateId) ?? [];
      arr.push(d);
      docsByAssociate.set(d.associateId, arr);
    }
    let missingBlobs = 0;
    for (const a of associates) {
      const folder = `02-form-i9/${safeName(`${a.lastName}-${a.firstName}`)}-${a.id.slice(0, 4)}`;
      const i9 = a.i9Verification;
      const docs = docsByAssociate.get(a.id) ?? [];
      const pdf = new ReportPdf({
        title: `Form I-9 Record — ${a.firstName} ${a.lastName}`,
        subtitle: 'Employment-eligibility verification record from the Alto People compliance system. Copies of the presented documents accompany this sheet in the same folder.',
        facts: facts(),
        reference: refId,
        confidentialityNote,
      });
      pdf.heading('Verification record');
      pdf.kv([
        { label: 'Worker', value: `${a.firstName} ${a.lastName}` },
        { label: 'Citizenship attestation', value: i9?.citizenshipStatus?.replace(/_/g, ' ') ?? 'NOT ON FILE' },
        { label: 'Section 1 completed', value: iso(i9?.section1CompletedAt) || 'NOT ON FILE' },
        { label: 'Section 2 completed', value: iso(i9?.section2CompletedAt) || 'NOT ON FILE' },
        { label: 'Section 2 verifier', value: i9?.section2Verifier?.email ?? '—' },
        { label: 'Document list used', value: i9?.documentList?.replace(/_/g, ' ') ?? '—' },
      ]);
      pdf.heading('Identity / eligibility documents on file');
      if (docs.length) {
        pdf.table(
          [
            { label: 'Type', width: 96 },
            { label: 'Document' },
            { label: 'List', width: 36 },
            { label: 'Side', width: 44 },
            { label: 'Verified', width: 62 },
          ],
          docs.map((d) => [
            d.kind.replace(/_/g, ' '),
            d.i9DocTitle ?? d.filename,
            d.i9List ?? '—',
            d.side ?? '—',
            ymd(d.verifiedAt) || '—',
          ]),
        );
      } else {
        pdf.para('No documents on file.', { muted: true });
      }
      archive.append(await pdf.render(), { name: `${folder}/i9-record.pdf` });
      for (const d of docs) {
        if (!d.s3Key) {
          missingBlobs += 1;
          continue;
        }
        const blob = await blobStore.get(d.s3Key);
        if (!blob) {
          missingBlobs += 1;
          continue;
        }
        archive.append(blob, {
          name: `${folder}/${safeName(`${d.kind}${d.side ? `-${d.side}` : ''}-${d.filename}`)}`,
        });
      }
    }

    /* 03 — E-Verify confirmation ------------------------------------------- */
    const everifyRows = associates.map((a) => [
      `${a.lastName}, ${a.firstName}`,
      a.i9Verification?.eVerifyCaseNumber ?? 'NO CASE ON FILE',
      a.i9Verification?.eVerifyStatus?.replace(/_/g, ' ') ?? '—',
      ymd(a.i9Verification?.eVerifyCaseOpenedAt) || '—',
      ymd(a.i9Verification?.eVerifyClosedAt) || '—',
    ]);
    {
      const pdf = new ReportPdf({
        title: 'E-Verify Register',
        subtitle: `E-Verify case confirmation for every worker in the roster. Case numbers are issued by the DHS E-Verify system.`,
        facts: facts([{ label: 'Workers', value: String(associates.length) }]),
        reference: refId,
        confidentialityNote,
      });
      pdf.table(
        [
          { label: 'Worker', width: 140 },
          { label: 'E-Verify case number' },
          { label: 'Status', width: 110 },
          { label: 'Opened', width: 62 },
          { label: 'Closed', width: 62 },
        ],
        everifyRows,
      );
      archive.append(await pdf.render(), { name: '03-e-verify/e-verify-register.pdf' });
    }
    archive.append(
      csv([
        ['Last name', 'First name', 'E-Verify case number', 'Status', 'Case opened', 'Case closed'],
        ...associates.map((a) => [
          a.lastName,
          a.firstName,
          a.i9Verification?.eVerifyCaseNumber ?? 'NO CASE ON FILE',
          a.i9Verification?.eVerifyStatus ?? '',
          iso(a.i9Verification?.eVerifyCaseOpenedAt),
          iso(a.i9Verification?.eVerifyClosedAt),
        ]),
      ]),
      { name: '03-e-verify/e-verify-register.csv' },
    );

    /* 04 — Attestation letters (legal-history scope items) ------------------ */
    const attestationIntro = `${COMPANY_INFO.legalName} ("the Company") provides this attestation in connection with the ${audience}, covering the twenty-four (24) months preceding the date of signature below.`;
    const attestationClose =
      'The undersigned is an authorized officer of the Company and affirms, after reasonable inquiry, that the statements above are true and correct as of the date of signature. Supporting documentation, where any exists, is included alongside this letter.';
    const reviewWarning =
      'REVIEW BEFORE SIGNING — this letter is generated as a template stating a clean history. If any covered incident exists, correct this letter and attach the relevant documentation in this folder before the packet is transmitted.';
    const attestations: Array<{ file: string; title: string; body: string }> = [
      {
        file: '04-attestations/attestation-1-immigration-enforcement.pdf',
        title: 'Attestation — Immigration Enforcement History',
        body:
          'The Company has NOT been fined, criminally charged, or convicted of knowingly employing unauthorized workers by U.S. Immigration and Customs Enforcement (ICE), the Department of Justice (DOJ), U.S. Border Patrol, the Department of Labor (DOL), or the Office of Immigrant and Employee Rights (IER) within the past twenty-four (24) months.',
      },
      {
        file: '04-attestations/attestation-2-wage-and-hour.pdf',
        title: 'Attestation — Wage & Hour Compliance History',
        body:
          'The Company has NOT been fined, issued a warning notice, criminally charged with, or convicted of failing to pay at least the minimum wage, failing to pay overtime, or failing to allow workers to take meal and rest breaks as required by law.',
      },
      {
        file: '04-attestations/attestation-3-back-wages.pdf',
        title: 'Attestation — Back Wages',
        body:
          'The Company has NOT paid back wages in connection with any civil or administrative proceeding (whether or not subject to a settlement agreement containing a confidentiality, non-admission-of-liability, or similar clause) due to failure to pay at least the minimum or prevailing wage, applicable overtime rates, or failure to allow workers to take meal and rest breaks as required by law.',
      },
    ];
    // Company-level attestations belong in company-level packets; an
    // individual evidence file (wage claim, subpoena) doesn't carry them.
    const includeAttestations = input.scope !== 'INDIVIDUAL';
    if (includeAttestations) {
      for (const att of attestations) {
        const pdf = new ReportPdf({
          title: att.title,
          facts: facts(),
          reference: refId,
          confidentialityNote,
        });
        pdf.para(attestationIntro);
        pdf.para(att.body);
        pdf.callout(reviewWarning);
        pdf.para(attestationClose);
        pdf.signatureBlock();
        archive.append(await pdf.render(), { name: att.file });
      }
    }

    /* 05 — Pay-lawfulness records ------------------------------------------ */
    const netMin = netMinutesOf;
    const nameById = new Map(associates.map((a) => [a.id, `${a.lastName}, ${a.firstName}`]));
    archive.append(
      csv([
        ['Worker', 'Date', 'Clock in (UTC)', 'Clock out (UTC)', 'Break minutes', 'Net worked minutes', 'Site', 'Status'],
        ...workedEntries.map((e) => [
          nameById.get(e.associateId) ?? e.associateId,
          ymd(e.clockInAt),
          iso(e.clockInAt),
          iso(e.clockOutAt),
          e.clockOutAt
            ? Math.round(
                (e.clockOutAt.getTime() - e.clockInAt.getTime()) / 60_000 - netMin(e),
              )
            : '',
          e.clockOutAt ? netMin(e) : '',
          e.locationId ? locationName.get(e.locationId) ?? '' : '',
          e.status,
        ]),
      ]),
      { name: '05-pay-records/time-punch-records.csv' },
    );

    const payItems = await prisma.payrollItem.findMany({
      where: {
        associateId: { in: rosterIds },
        payrollRun: {
          status: { not: 'CANCELLED' },
          periodStart: { lt: endExcl },
          periodEnd: { gte: start },
        },
      },
      include: paystubItemInclude(),
      orderBy: [{ payrollRun: { periodStart: 'asc' } }, { associate: { lastName: 'asc' } }],
      take: 2_000,
    });
    archive.append(
      csv([
        ['Worker', 'Period start', 'Period end', 'Run status', 'Hours', 'Gross', 'Federal tax', 'FICA', 'Medicare', 'State tax', 'Local tax', 'Net pay', 'Disbursed at'],
        ...payItems.map((it) => [
          `${it.associate.lastName}, ${it.associate.firstName}`,
          ymd(it.payrollRun.periodStart),
          ymd(it.payrollRun.periodEnd),
          it.payrollRun.status,
          Number(it.hoursWorked).toFixed(2),
          Number(it.grossPay).toFixed(2),
          Number(it.federalWithholding).toFixed(2),
          Number(it.fica).toFixed(2),
          Number(it.medicare).toFixed(2),
          Number(it.stateWithholding).toFixed(2),
          Number(it.localWithholding).toFixed(2),
          Number(it.netPay).toFixed(2),
          iso(it.payrollRun.disbursedAt),
        ]),
      ]),
      { name: '05-pay-records/pay-register.csv' },
    );

    // Wage-compliance summary — the auditor-facing narrative: one line per
    // worker reconciling worked time against pay across the period.
    const summaryByAssociate = new Map<
      string,
      { punches: number; netMinutes: number; gross: number; net: number; periods: number }
    >();
    for (const e of workedEntries) {
      const s = summaryByAssociate.get(e.associateId) ?? { punches: 0, netMinutes: 0, gross: 0, net: 0, periods: 0 };
      s.punches += 1;
      s.netMinutes += netMin(e);
      summaryByAssociate.set(e.associateId, s);
    }
    for (const it of payItems) {
      if (it.status !== 'DISBURSED') continue;
      const s = summaryByAssociate.get(it.associateId) ?? { punches: 0, netMinutes: 0, gross: 0, net: 0, periods: 0 };
      s.gross += Number(it.grossPay);
      s.net += Number(it.netPay);
      s.periods += 1;
      summaryByAssociate.set(it.associateId, s);
    }
    const externalPayments = await prisma.externalPayment.findMany({
      where: {
        associateId: { in: rosterIds },
        deletedAt: null,
        periodStart: { lt: endExcl },
        periodEnd: { gte: start },
      },
      include: {
        evidence: { where: { deletedAt: null } },
        createdBy: { select: { email: true } },
      },
      orderBy: { periodEnd: 'asc' },
    });
    for (const p of externalPayments) {
      const s = summaryByAssociate.get(p.associateId) ?? { punches: 0, netMinutes: 0, gross: 0, net: 0, periods: 0 };
      s.gross += Number(p.grossAmount ?? 0);
      s.net += Number(p.netAmount ?? 0);
      s.periods += 1;
      summaryByAssociate.set(p.associateId, s);
    }
    {
      const pdf = new ReportPdf({
        title: 'Wage Compliance Summary',
        subtitle:
          'Per-worker reconciliation of approved worked time (net of unpaid breaks) against compensation disbursed for the audit period. Detail behind every line: time-punch records (CSV), the pay register (CSV), individual paystub PDFs, and externally-processed payment records with evidence, all in this folder.',
        facts: facts([{ label: 'Workers', value: String(associates.length) }]),
        reference: refId,
        confidentialityNote,
      });
      pdf.table(
        [
          { label: 'Worker', width: 150 },
          { label: 'Approved punches', width: 78, align: 'right' },
          { label: 'Net hours worked', width: 82, align: 'right' },
          { label: 'Pay periods', width: 60, align: 'right' },
          { label: 'Gross paid', align: 'right' },
          { label: 'Net paid', align: 'right' },
        ],
        associates.map((a) => {
          const s = summaryByAssociate.get(a.id) ?? { punches: 0, netMinutes: 0, gross: 0, net: 0, periods: 0 };
          return [
            `${a.lastName}, ${a.firstName}`,
            s.punches,
            (s.netMinutes / 60).toFixed(2),
            s.periods,
            money(s.gross),
            money(s.net),
          ];
        }),
      );
      pdf.para(
        'Pay is computed on worked time net of unpaid breaks; meal and rest breaks are recorded per punch and are itemized in the time-punch CSV. Paystubs itemize gross-to-net including all withholdings.',
        { muted: true, size: 8.5 },
      );
      archive.append(await pdf.render(), { name: '05-pay-records/wage-compliance-summary.pdf' });
    }

    const PAYSTUB_CAP = 300;
    const disbursed = payItems.filter((it) => it.status === 'DISBURSED');
    let stubCount = 0;
    for (const it of disbursed) {
      if (stubCount >= PAYSTUB_CAP) break;
      try {
        const data = await buildPaystubDataFromItem(prisma, it);
        const pdf = await renderPaystubPdf(data);
        archive.append(pdf, {
          name: `05-pay-records/paystubs/${safeName(`${it.associate.lastName}-${it.associate.firstName}`)}-${ymd(it.payrollRun.periodStart)}.pdf`,
        });
        stubCount += 1;
      } catch (err) {
        console.warn('[audit-packet] paystub render failed for item', it.id, err);
      }
    }

    if (externalPayments.length > 0) {
      archive.append(
        csv([
          ['Worker', 'Period start', 'Period end', 'Pay date', 'Gross', 'Net', 'Method', 'Reference', 'Evidence files'],
          ...externalPayments.map((p) => [
            nameById.get(p.associateId) ?? p.associateId,
            ymd(p.periodStart),
            ymd(p.periodEnd),
            ymd(p.payDate),
            p.grossAmount === null ? '' : Number(p.grossAmount).toFixed(2),
            p.netAmount === null ? '' : Number(p.netAmount).toFixed(2),
            p.method,
            p.reference ?? '',
            p.evidence.map((d) => d.filename).join('; '),
          ]),
        ]),
        { name: '05-pay-records/external-payments/external-payments.csv' },
      );
      for (const p of externalPayments) {
        const worker = nameById.get(p.associateId) ?? p.associateId;
        const stem = `05-pay-records/external-payments/${safeName(worker)}-${ymd(p.periodEnd)}`;
        // A letterheaded copy of the RECORD itself — the paystub-equivalent
        // for a period processed by the external payroll provider. The raw
        // evidence uploads accompany it under the same filename stem so an
        // auditor can match record → proof at a glance.
        const pdf = new ReportPdf({
          title: 'External Payment Record',
          subtitle:
            'Compensation for this pay period was processed by the Company\'s external payroll provider and documented in the Alto People compliance system. Uploaded evidence of payment accompanies this record under the same filename stem.',
          facts: facts(),
          reference: refId,
          confidentialityNote,
        });
        pdf.heading('Payment record');
        pdf.kv([
          { label: 'Worker', value: worker },
          { label: 'Pay period', value: `${ymd(p.periodStart)} to ${ymd(p.periodEnd)}` },
          { label: 'Pay date', value: ymd(p.payDate) || '—' },
          { label: 'Gross amount', value: p.grossAmount === null ? '—' : money(p.grossAmount) },
          { label: 'Net amount', value: p.netAmount === null ? '—' : money(p.netAmount) },
          { label: 'Payment method', value: p.method.replace(/_/g, ' ') },
          { label: 'Reference', value: p.reference ?? '—' },
          ...(p.note ? [{ label: 'Note', value: p.note }] : []),
          { label: 'Recorded by', value: p.createdBy?.email ?? '—' },
          { label: 'Recorded at', value: iso(p.createdAt) },
        ]);
        pdf.heading('Evidence of payment on file');
        if (p.evidence.length) {
          pdf.table(
            [{ label: 'File' }, { label: 'Uploaded', width: 96 }],
            p.evidence.map((d) => [d.filename, iso(d.createdAt).slice(0, 16).replace('T', ' ')]),
          );
        } else {
          pdf.para('No evidence file is attached to this payment record.', { muted: true });
        }
        archive.append(await pdf.render(), { name: `${stem}-payment-record.pdf` });

        for (const d of p.evidence) {
          if (!d.s3Key) continue;
          const blob = await blobStore.get(d.s3Key);
          if (!blob) {
            missingBlobs += 1;
            continue;
          }
          archive.append(blob, { name: `${stem}-${safeName(d.filename)}` });
        }
      }
    }

    /* 06 — Harassment / discrimination reporting process -------------------- */
    {
      const pdf = new ReportPdf({
        title: 'Harassment & Discrimination Reporting Process',
        subtitle: 'How Alto HR associates report harassment or discrimination, and the policy framework behind it.',
        facts: facts(),
        reference: refId,
        confidentialityNote,
      });
      pdf.heading('Reporting channels');
      pdf.para(
        'Every associate has three always-available channels. No channel requires going through the associate\'s direct supervisor, and all reports are handled confidentially:',
      );
      pdf.kv([
        { label: '1 · In-app concern reporting', value: 'The Alto People portal includes a concern-reporting tool (HR case system). Cases carry a documented status history and are visible only to HR case managers.' },
        { label: '2 · Direct to HR', value: 'The HR Administrator is reachable directly; contact details appear in every company email footer and in the associate portal.' },
        { label: '3 · Company contact', value: `${COMPANY_INFO.email} · ${COMPANY_INFO.phone} (${COMPANY_INFO.hours})` },
      ]);
      pdf.heading('Policy framework');
      pdf.para(
        "The Anti-Harassment policy is incorporated into every associate's employment agreement (Section 17 — Equal Employment Opportunity and Anti-Harassment) and is acknowledged at onboarding. The full policy text and the acknowledgment log for the audited roster accompany this document in the same folder.",
      );
      archive.append(await pdf.render(), { name: '06-harassment-reporting/reporting-process.pdf' });
    }
    const eeoPolicy = ALTO_POLICIES.find((p) => /anti-harassment/i.test(p.title));
    if (eeoPolicy) {
      const pdf = new ReportPdf({
        title: eeoPolicy.title,
        subtitle: `Policy version ${eeoPolicy.version} — binding on every associate through the employment agreement.`,
        facts: facts(),
        reference: refId,
        confidentialityNote,
      });
      for (const paragraph of eeoPolicy.body.split(/\n{2,}/)) {
        const trimmed = paragraph.trim();
        if (trimmed) pdf.para(trimmed.replace(/\n/g, ' '), { size: 9.5 });
      }
      archive.append(await pdf.render(), {
        name: `06-harassment-reporting/${safeName(eeoPolicy.title)}.pdf`,
      });
    }
    const acks = await prisma.policyAcknowledgment.findMany({
      where: { associateId: { in: rosterIds } },
      select: {
        associateId: true,
        acknowledgedAt: true,
        policy: { select: { title: true } },
      },
      orderBy: { acknowledgedAt: 'asc' },
    });
    {
      const pdf = new ReportPdf({
        title: 'Policy Acknowledgment Log',
        subtitle: 'Electronic acknowledgments recorded at onboarding for the audited roster.',
        facts: facts([{ label: 'Acknowledgments', value: String(acks.length) }]),
        reference: refId,
        confidentialityNote,
      });
      pdf.table(
        [
          { label: 'Worker', width: 150 },
          { label: 'Policy' },
          { label: 'Acknowledged', width: 96 },
        ],
        acks.map((k) => [
          nameById.get(k.associateId) ?? k.associateId,
          k.policy.title,
          iso(k.acknowledgedAt).slice(0, 16).replace('T', ' '),
        ]),
      );
      archive.append(await pdf.render(), { name: '06-harassment-reporting/policy-acknowledgment-log.pdf' });
    }
    archive.append(
      csv([
        ['Worker', 'Policy', 'Acknowledged at'],
        ...acks.map((k) => [
          nameById.get(k.associateId) ?? k.associateId,
          k.policy.title,
          iso(k.acknowledgedAt),
        ]),
      ]),
      { name: '06-harassment-reporting/policy-acknowledgment-log.csv' },
    );

    /* 07 — Background checks ------------------------------------------------ */
    const bgRows = associates.flatMap((a) =>
      a.backgroundChecks.length
        ? a.backgroundChecks.map((b) => [
            `${a.lastName}, ${a.firstName}`,
            b.provider,
            b.status.replace(/_/g, ' '),
            ymd(b.initiatedAt),
            ymd(b.completedAt) || '—',
          ])
        : [[`${a.lastName}, ${a.firstName}`, 'NO CHECK ON FILE', '—', '—', '—']],
    );
    {
      const pdf = new ReportPdf({
        title: 'Background Check Register',
        subtitle: 'Background screening record for every worker in the roster, as required under the MSA. Provider result documents accompany this register in the results subfolder.',
        facts: facts([{ label: 'Workers', value: String(associates.length) }]),
        reference: refId,
        confidentialityNote,
      });
      pdf.table(
        [
          { label: 'Worker', width: 150 },
          { label: 'Provider' },
          { label: 'Status', width: 90 },
          { label: 'Initiated', width: 62 },
          { label: 'Completed', width: 62 },
        ],
        bgRows,
      );
      archive.append(await pdf.render(), { name: '07-background-checks/background-check-register.pdf' });
    }
    archive.append(
      csv([
        ['Worker', 'Provider', 'Status', 'Initiated', 'Completed'],
        ...associates.flatMap((a) =>
          a.backgroundChecks.length
            ? a.backgroundChecks.map((b) => [
                `${a.lastName}, ${a.firstName}`,
                b.provider,
                b.status,
                iso(b.initiatedAt),
                iso(b.completedAt),
              ])
            : [[`${a.lastName}, ${a.firstName}`, 'NO CHECK ON FILE', '', '', '']],
        ),
      ]),
      { name: '07-background-checks/background-check-register.csv' },
    );
    const bgDocs = await prisma.documentRecord.findMany({
      where: {
        associateId: { in: rosterIds },
        deletedAt: null,
        kind: 'BACKGROUND_CHECK_RESULT',
        status: { notIn: ['REJECTED', 'EXPIRED'] },
      },
      select: { associateId: true, filename: true, s3Key: true },
    });
    for (const d of bgDocs) {
      if (!d.s3Key) continue;
      const blob = await blobStore.get(d.s3Key);
      if (!blob) {
        missingBlobs += 1;
        continue;
      }
      archive.append(blob, {
        name: `07-background-checks/results/${safeName(`${nameById.get(d.associateId) ?? d.associateId}`)}-${safeName(d.filename)}`,
      });
    }

    /* 08 — Subcontractors (client-scoped packets only) ----------------------- */
    const includeSubcontractor = input.scope === 'CLIENT_PERIOD';
    if (includeSubcontractor) {
      const pdf = new ReportPdf({
        title: 'Subcontractor Statement',
        facts: facts(),
        reference: refId,
        confidentialityNote,
      });
      pdf.para(attestationIntro);
      pdf.para(
        `The workers listed in this packet are direct associates of the Company. The Company does not engage subcontractors to provide services on ${client!.name} properties. Should any subcontractor be engaged in the future, the Company will obtain and provide the subcontractor's worker roster, Form I-9 records with supporting eligibility and identity documentation, and E-Verify confirmations, as required by the audit scope.`,
      );
      pdf.callout(
        'REVIEW BEFORE SIGNING — if subcontractors ARE currently engaged, replace this statement with the subcontractor documentation described above.',
      );
      pdf.para(attestationClose);
      pdf.signatureBlock();
      archive.append(await pdf.render(), { name: '08-subcontractors/subcontractor-statement.pdf' });
    }

    /* 00 — Cover manifest (added last so the counts are real) ---------------- */
    {
      const packetTitle =
        input.scope === 'CLIENT_PERIOD'
          ? 'Audit Response Packet'
          : input.scope === 'ALL_WORKFORCE'
            ? 'Workforce Compliance File'
            : `Individual Personnel Audit File`;
      const pdf = new ReportPdf({
        title: packetTitle,
        subtitle: `Complete response to the ${audience}, assembled from the Alto People compliance platform. Folders are numbered to match the audit scope; each register is provided as a presentation PDF with a machine-readable CSV twin.`,
        facts: facts([
          { label: 'Workers in scope', value: String(associates.length) },
          { label: 'Prepared by', value: req.user!.email },
          { label: 'Reference', value: refId },
        ]),
        reference: refId,
        confidentialityNote,
      });
      pdf.heading('Contents');
      pdf.table(
        [
          { label: 'Folder', width: 118 },
          { label: 'Audit scope item' },
          { label: 'Contents', width: 168 },
        ],
        [
          [
            '01-worker-roster',
            input.scope === 'CLIENT_PERIOD'
              ? `Workers providing services on ${client!.name} properties`
              : input.scope === 'ALL_WORKFORCE'
                ? 'Every worker ever employed by the Company'
                : 'Subject worker',
            `${associates.length} worker${associates.length === 1 ? '' : 's'}${separatedCount > 0 ? ` (${separatedCount} since separated)` : ''} (PDF + CSV)`,
          ],
          ['02-form-i9', 'Form I-9s and identity / eligibility documentation', `${associates.length} record sheets · ${i9Docs.length} documents`],
          ['03-e-verify', 'Confirmation of E-Verify', `${associates.length} worker${associates.length === 1 ? '' : 's'} (PDF + CSV)`],
          ...(includeAttestations
            ? [['04-attestations', 'Immigration-enforcement, wage & hour, and back-wages history', '3 letters — officer signature REQUIRED']]
            : []),
          [
            '05-pay-records',
            'Pay compliance: time punches, pay registers, paystubs',
            `${workedEntries.length} punches · ${payItems.length} register lines · ${stubCount} paystubs${disbursed.length > PAYSTUB_CAP ? ` of ${disbursed.length} (capped)` : ''}${externalPayments.length ? ` · ${externalPayments.length} external-payment record sheets with evidence` : ''}`,
          ],
          ['06-harassment-reporting', 'Harassment / discrimination reporting process', `Process + policy + ${acks.length} acknowledgments`],
          ['07-background-checks', 'Background checks per the MSA', `Register + ${bgDocs.length} result documents`],
          ...(includeSubcontractor
            ? [['08-subcontractors', 'Subcontractor workers, I-9s, and E-Verify', 'Statement — officer signature REQUIRED']]
            : []),
        ],
      );
      if (includeAttestations || includeSubcontractor) {
        pdf.heading('Signature requirements');
        pdf.callout(
          `${[includeAttestations ? 'Folder 04' : null, includeSubcontractor ? 'folder 08' : null]
            .filter(Boolean)
            .join(' and ')} contain${includeAttestations && includeSubcontractor ? '' : 's'} generated clean-history templates. An authorized officer must verify each statement is factually accurate, then sign and date them BEFORE this packet is transmitted.`,
        );
      }
      pdf.heading('Data integrity');
      pdf.para(
        'Roster inclusion is evidence-based: the union of site assignment records, approved worked time, and schedule-completed shifts for the period, with the basis stated per worker. Workers who separated after providing services in the period remain listed with their status; a worker whose record was privacy-erased appears with an anonymized identity, as noted on the roster.',
      );
      pdf.para(
        missingBlobs > 0
          ? `${missingBlobs} document file(s) referenced by records could not be retrieved from storage and are absent from this packet; their records still appear in the registers.`
          : 'All referenced document files were retrieved from storage successfully.',
      );
      pdf.para(
        `Generated ${generatedAt.toISOString()} by ${req.user!.email}. This generation event, including the stated business reason, is permanently recorded in the compliance audit log under reference ${refId}.`,
        { muted: true, size: 8.5 },
      );
      archive.append(await pdf.render(), { name: '00-cover/manifest.pdf' });
    }

    await archive.finalize();
  },
);
