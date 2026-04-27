import PDFDocument from 'pdfkit';

/**
 * Phase 59 — per-application compliance packet PDF.
 *
 * Bundles every artifact an HR auditor or insurance carrier might need
 * to prove the associate's onboarding was completed: profile snapshot,
 * W-4 summary (with SSN masked to last-4), direct-deposit (with account
 * masked), I-9 sections 1 + 2, policy acknowledgments, e-signature
 * audit, document register, and the chronological audit trail.
 *
 * All sensitive fields are masked at *render* time. The encrypted
 * blobs in the DB stay encrypted; the route handler decrypts with the
 * payload key, derives the last-4, and passes only the safe slice to
 * this renderer. We never put a full SSN or full bank account number
 * in the packet.
 */

export interface PacketTaskRow {
  kind: string;
  title: string;
  status: string;
  completedAt: string | null; // ISO
}

export interface PacketDocumentRow {
  kind: string;
  filename: string;
  status: string;
  verifiedAt: string | null;
  verifiedByEmail: string | null;
  rejectionReason: string | null;
}

export interface PacketPolicyAck {
  title: string;
  version: string;
  acknowledgedAt: string | null; // ISO
}

export interface PacketEsign {
  title: string;
  signedAt: string | null;
  typedName: string | null;
  pdfHashHex: string | null;
}

export interface PacketAuditEvent {
  action: string;
  actorEmail: string | null;
  createdAt: string;
}

export interface PacketData {
  meta: {
    generatedAt: string; // ISO
    generatedBy: string; // email
  };
  application: {
    id: string;
    status: string;
    track: string;
    position: string | null;
    startDate: string | null; // ISO date
    invitedAt: string;
    submittedAt: string | null;
  };
  client: { name: string };
  associate: {
    firstName: string;
    lastName: string;
    email: string;
    employmentType: string;
    phone: string | null;
    dob: string | null; // ISO date
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  /** null when the associate is a 1099 contractor — they don't fill W-4. */
  w4: {
    filingStatus: string;
    multipleJobs: boolean;
    dependentsAmount: string;
    otherIncome: string;
    deductions: string;
    extraWithholding: string;
    /** Last 4 of SSN only. Decrypted server-side, last-4 derived, full
     *  value never leaves the API process. */
    ssnLast4: string | null;
    signedAt: string | null;
  } | null;
  payout: {
    type: 'BANK_ACCOUNT' | 'BRANCH_CARD' | 'OTHER';
    accountType: string | null;
    /** Routing + last-4 of account, never the whole account number. */
    routingMasked: string | null;
    accountLast4: string | null;
    branchCardId: string | null;
    verifiedAt: string | null;
  } | null;
  i9: {
    citizenshipStatus: string | null;
    section1CompletedAt: string | null;
    section1TypedName: string | null;
    section2CompletedAt: string | null;
    section2VerifierEmail: string | null;
    documentList: string | null;
    workAuthExpiresAt: string | null;
    /** True iff there's an A-Number on file (we never print the value). */
    hasAlienRegistrationNumber: boolean;
  } | null;
  tasks: PacketTaskRow[];
  policyAcks: PacketPolicyAck[];
  esignAgreements: PacketEsign[];
  documents: PacketDocumentRow[];
  audit: PacketAuditEvent[];
}

export async function renderCompliancePacket(data: PacketData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `Onboarding compliance packet — ${data.associate.firstName} ${data.associate.lastName}`,
        Author: 'Alto People',
        Subject: `Application ${data.application.id}`,
        CreationDate: new Date(data.meta.generatedAt),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderCover(doc, data);
    renderProfile(doc, data);
    if (data.w4) renderW4(doc, data.w4);
    if (data.payout) renderPayout(doc, data.payout);
    if (data.i9) renderI9(doc, data.i9);
    renderChecklist(doc, data.tasks);
    renderPolicyAcks(doc, data.policyAcks);
    renderEsign(doc, data.esignAgreements);
    renderDocuments(doc, data.documents);
    renderAudit(doc, data.audit);

    doc.end();
  });
}

/* ---------------------------------------------------------------- helpers */

const C = {
  ink: '#0b1220',
  rule: '#d8dde6',
  muted: '#6b7280',
  accent: '#8a6d3b',
};

function header(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 80);
  doc
    .moveDown(1)
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(C.accent)
    .text(title.toUpperCase(), { characterSpacing: 1 });
  rule(doc);
  doc.moveDown(0.4).fillColor(C.ink).font('Helvetica').fontSize(10);
}

function rule(doc: PDFKit.PDFDocument) {
  const y = doc.y + 2;
  doc
    .strokeColor(C.rule)
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .strokeColor(C.ink);
  doc.y = y + 4;
}

/** Simple two-column key/value row. Wraps the value if it's long. */
function kv(doc: PDFKit.PDFDocument, key: string, value: string | null | undefined) {
  ensureSpace(doc, 16);
  const labelW = 140;
  const startX = doc.page.margins.left;
  const startY = doc.y;
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(C.muted)
    .text(key, startX, startY, { width: labelW, continued: false });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(C.ink)
    .text(value && value.length > 0 ? value : '—', startX + labelW, startY, {
      width: doc.page.width - doc.page.margins.right - startX - labelW,
    });
  doc.moveDown(0.2);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  // Display in UTC to match the API's storage convention. HR can convert
  // to local time mentally — packet is auditor-facing, not employee-facing.
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function fmtDateOnly(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- sections */

function renderCover(doc: PDFKit.PDFDocument, d: PacketData) {
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(C.ink)
    .text('Onboarding Compliance Packet', { align: 'left' });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(C.muted)
    .text(d.client.name);
  doc.moveDown(0.5);

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(C.ink)
    .text(`${d.associate.firstName} ${d.associate.lastName}`);
  doc.font('Helvetica').fontSize(10).fillColor(C.muted).text(d.associate.email);
  if (d.application.position) doc.text(d.application.position);
  doc.moveDown(0.5);

  rule(doc);

  kv(doc, 'Application ID', d.application.id);
  kv(doc, 'Status', d.application.status);
  kv(doc, 'Track', d.application.track);
  kv(doc, 'Employment type', d.associate.employmentType);
  kv(doc, 'Invited at', fmtDate(d.application.invitedAt));
  kv(doc, 'Submitted at', fmtDate(d.application.submittedAt));
  kv(doc, 'Start date', fmtDateOnly(d.application.startDate));

  doc.moveDown(1);
  rule(doc);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(C.muted)
    .text(
      `Generated ${fmtDate(d.meta.generatedAt)} by ${d.meta.generatedBy}. ` +
        'SSN and bank-account numbers are masked to last-4. Full values remain encrypted at rest in the source system.',
      { align: 'left' }
    );
}

function renderProfile(doc: PDFKit.PDFDocument, d: PacketData) {
  header(doc, 'Profile');
  kv(doc, 'Email', d.associate.email);
  kv(doc, 'Phone', d.associate.phone);
  kv(doc, 'Date of birth', fmtDateOnly(d.associate.dob));
  const street = [d.associate.addressLine1, d.associate.addressLine2]
    .filter((x) => x && x.length > 0)
    .join(', ');
  const csz = [d.associate.city, d.associate.state, d.associate.zip]
    .filter((x) => x && x.length > 0)
    .join(', ');
  kv(doc, 'Address', street ? `${street}\n${csz}` : csz || null);
}

function renderW4(doc: PDFKit.PDFDocument, w: NonNullable<PacketData['w4']>) {
  header(doc, 'W-4 Tax Withholding');
  kv(doc, 'Filing status', w.filingStatus);
  kv(doc, 'Multiple jobs', w.multipleJobs ? 'Yes' : 'No');
  kv(doc, 'Dependents amount', `$${w.dependentsAmount}`);
  kv(doc, 'Other income', `$${w.otherIncome}`);
  kv(doc, 'Deductions', `$${w.deductions}`);
  kv(doc, 'Extra withholding', `$${w.extraWithholding}`);
  kv(doc, 'SSN', w.ssnLast4 ? `XXX-XX-${w.ssnLast4}` : null);
  kv(doc, 'Signed at', fmtDate(w.signedAt));
}

function renderPayout(doc: PDFKit.PDFDocument, p: NonNullable<PacketData['payout']>) {
  header(doc, 'Direct Deposit');
  kv(doc, 'Type', p.type);
  if (p.type === 'BANK_ACCOUNT') {
    kv(doc, 'Account type', p.accountType);
    kv(doc, 'Routing number', p.routingMasked);
    kv(doc, 'Account number', p.accountLast4 ? `••••${p.accountLast4}` : null);
  } else if (p.type === 'BRANCH_CARD') {
    kv(doc, 'Branch card ID', p.branchCardId);
  }
  kv(doc, 'Verified at', fmtDate(p.verifiedAt));
}

function renderI9(doc: PDFKit.PDFDocument, i: NonNullable<PacketData['i9']>) {
  header(doc, 'I-9 Employment Verification');
  kv(doc, 'Citizenship status', i.citizenshipStatus);
  kv(doc, 'Section 1 completed', fmtDate(i.section1CompletedAt));
  kv(doc, 'Section 1 typed name', i.section1TypedName);
  kv(doc, 'Section 2 completed', fmtDate(i.section2CompletedAt));
  kv(doc, 'Section 2 verifier', i.section2VerifierEmail);
  kv(doc, 'Document list', i.documentList);
  kv(doc, 'Work auth expires', fmtDateOnly(i.workAuthExpiresAt));
  kv(doc, 'A-Number on file', i.hasAlienRegistrationNumber ? 'Yes (encrypted)' : 'No');
}

function renderChecklist(doc: PDFKit.PDFDocument, tasks: PacketTaskRow[]) {
  header(doc, 'Onboarding Checklist');
  if (tasks.length === 0) {
    doc.font('Helvetica-Oblique').fillColor(C.muted).text('(no tasks on this application)');
    return;
  }
  for (const t of tasks) {
    ensureSpace(doc, 18);
    const startY = doc.y;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(C.ink)
      .text(t.title, doc.page.margins.left, startY, { width: 280, continued: false });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(C.muted)
      .text(`(${t.kind})`, doc.page.margins.left + 285, startY, { width: 90 });
    doc.fillColor(t.status === 'DONE' ? '#1d6f42' : C.muted).text(
      t.status,
      doc.page.margins.left + 380,
      startY,
      { width: 60 }
    );
    doc.fillColor(C.muted).text(
      fmtDate(t.completedAt),
      doc.page.margins.left + 440,
      startY,
      { width: 130 }
    );
    doc.moveDown(0.4);
  }
}

function renderPolicyAcks(doc: PDFKit.PDFDocument, acks: PacketPolicyAck[]) {
  header(doc, 'Policy Acknowledgments');
  if (acks.length === 0) {
    doc.font('Helvetica-Oblique').fillColor(C.muted).text('(no policy acknowledgments)');
    return;
  }
  for (const a of acks) {
    ensureSpace(doc, 16);
    const startY = doc.y;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(C.ink)
      .text(a.title, doc.page.margins.left, startY, { width: 320 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(C.muted)
      .text(`v${a.version}`, doc.page.margins.left + 325, startY, { width: 60 });
    doc.text(fmtDate(a.acknowledgedAt), doc.page.margins.left + 390, startY, {
      width: 180,
    });
    doc.moveDown(0.4);
  }
}

function renderEsign(doc: PDFKit.PDFDocument, items: PacketEsign[]) {
  header(doc, 'E-Signature Audit');
  if (items.length === 0) {
    doc.font('Helvetica-Oblique').fillColor(C.muted).text('(no e-signed agreements)');
    return;
  }
  for (const e of items) {
    ensureSpace(doc, 30);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(C.ink)
      .text(e.title);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(C.muted)
      .text(`Signed: ${fmtDate(e.signedAt)}`);
    if (e.typedName) doc.text(`Typed name: ${e.typedName}`);
    if (e.pdfHashHex) doc.text(`PDF SHA-256: ${e.pdfHashHex}`);
    doc.moveDown(0.5);
  }
}

function renderDocuments(doc: PDFKit.PDFDocument, items: PacketDocumentRow[]) {
  header(doc, 'Document Register');
  if (items.length === 0) {
    doc.font('Helvetica-Oblique').fillColor(C.muted).text('(no documents on file)');
    return;
  }
  for (const r of items) {
    ensureSpace(doc, 22);
    const startY = doc.y;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(C.ink)
      .text(r.filename, doc.page.margins.left, startY, { width: 220 });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(C.muted)
      .text(r.kind, doc.page.margins.left + 225, startY, { width: 100 });
    doc.text(r.status, doc.page.margins.left + 330, startY, { width: 60 });
    doc.text(
      r.verifiedAt
        ? `Verified ${fmtDate(r.verifiedAt)}` +
            (r.verifiedByEmail ? ` by ${r.verifiedByEmail}` : '')
        : '—',
      doc.page.margins.left + 395,
      startY,
      { width: 175 }
    );
    if (r.rejectionReason) {
      doc.moveDown(0.2).fillColor('#a14040').fontSize(8).text(`Rejected: ${r.rejectionReason}`);
    }
    doc.moveDown(0.3);
  }
}

function renderAudit(doc: PDFKit.PDFDocument, events: PacketAuditEvent[]) {
  header(doc, 'Audit Trail');
  if (events.length === 0) {
    doc.font('Helvetica-Oblique').fillColor(C.muted).text('(no audit events)');
    return;
  }
  for (const e of events) {
    ensureSpace(doc, 14);
    const startY = doc.y;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(C.muted)
      .text(fmtDate(e.createdAt), doc.page.margins.left, startY, { width: 145 });
    doc
      .fillColor(C.ink)
      .text(e.action, doc.page.margins.left + 150, startY, { width: 220 });
    doc
      .fillColor(C.muted)
      .text(e.actorEmail ?? 'system', doc.page.margins.left + 375, startY, {
        width: 195,
      });
    doc.moveDown(0.2);
  }
}
