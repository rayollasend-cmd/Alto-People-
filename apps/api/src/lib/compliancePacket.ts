import { createHash } from 'node:crypto';
import { COLOR, createDoc, fmt } from './docKit/index.js';
import { coverPage, loadCurrentBrand, currentPage, drawContents, pinDocument, reserveContents } from './docKit/biz.js';

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

/** "PENDING_REVIEW" → "Pending review". */
const human = (s: string | null | undefined): string => {
  if (!s) return '—';
  const t = s.replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const when = (iso: string | null | undefined): string => (iso ? (iso.length === 10 ? fmt.date(iso) : fmt.dateTime(iso)) : '—');

/** A short fingerprint of everything the packet states, printed on the cover and every page. */
export function packetFingerprint(data: PacketData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/** The packet's sections, in order, as the contents page lists them (exported for tests). */
export function packetSections(data: PacketData): string[] {
  return [
    'Associate profile',
    ...(data.w4 ? ['Federal withholding (W-4)'] : []),
    ...(data.payout ? ['Pay account'] : []),
    ...(data.i9 ? ['Employment eligibility (I-9)'] : []),
    'Onboarding checklist',
    'Policy acknowledgments',
    'Electronic signatures',
    'Document register',
    'Audit trail',
  ];
}

export async function renderCompliancePacket(data: PacketData): Promise<Buffer> {
  const name = `${data.associate.firstName} ${data.associate.lastName}`.trim();
  const brand = await loadCurrentBrand();
  const fingerprint = packetFingerprint(data);
  const { k, doc } = createDoc({ title: `Onboarding compliance packet — ${name}`, author: brand.name, subject: `Application ${data.application.id}` });
  pinDocument(doc, new Date(data.meta.generatedAt));

  coverPage(k, {
    brand,
    kicker: 'Onboarding compliance packet',
    title: name,
    subtitle: [data.application.position, data.client.name].filter(Boolean).join(' · '),
    preparedFor: 'HR audit and insurance carrier review',
    facts: [
      { label: 'Application status', value: human(data.application.status) },
      { label: 'Track', value: human(data.application.track) },
      { label: 'Start date', value: when(data.application.startDate) },
      { label: 'Invited', value: when(data.application.invitedAt) },
      { label: 'Submitted', value: when(data.application.submittedAt) },
      { label: 'Generated', value: when(data.meta.generatedAt) },
      { label: 'Generated by', value: data.meta.generatedBy },
    ],
    note: `Sensitive values are masked: SSN and bank account show the last four digits only. Content fingerprint SHA-256 ${fingerprint.slice(0, 16)}…`,
  });
  const contentsPage = reserveContents(k);
  const entries: Array<{ title: string; page: number }> = [];
  let y = k.top;
  const start = (title: string, needs = 120) => {
    y = k.ensure(y, needs);
    entries.push({ title, page: currentPage(k) });
    y = k.section(`${entries.length}. ${title}`, y);
  };

  // ---- Profile ------------------------------------------------------------
  const a = data.associate;
  start('Associate profile');
  y = k.facts(
    [
      { label: 'Legal name', value: name, strong: true },
      { label: 'Employment type', value: human(a.employmentType) },
      { label: 'Email', value: a.email },
      { label: 'Phone', value: a.phone ?? '—' },
      { label: 'Date of birth', value: when(a.dob) },
      { label: 'Address', value: [a.addressLine1, a.addressLine2, [a.city, a.state].filter(Boolean).join(', ') + (a.zip ? ` ${a.zip}` : '')].filter((l) => l && l.trim()).join(', ') || '—' },
      { label: 'Client', value: data.client.name },
      { label: 'Position', value: data.application.position ?? '—' },
    ],
    y,
  );

  if (data.w4) {
    const w = data.w4;
    start('Federal withholding (W-4)');
    y = k.facts(
      [
        { label: 'Filing status', value: human(w.filingStatus), strong: true },
        { label: 'Multiple jobs (step 2)', value: w.multipleJobs ? 'Yes' : 'No' },
        { label: 'Dependents (step 3)', value: w.dependentsAmount },
        { label: 'Other income (step 4a)', value: w.otherIncome },
        { label: 'Deductions (step 4b)', value: w.deductions },
        { label: 'Extra withholding (step 4c)', value: w.extraWithholding },
        { label: 'SSN', value: fmt.ssnMasked(w.ssnLast4) },
        { label: 'Signed', value: when(w.signedAt) },
      ],
      y,
    );
  }

  if (data.payout) {
    const p = data.payout;
    start('Pay account');
    y = k.facts(
      [
        { label: 'Method', value: p.type === 'BANK_ACCOUNT' ? 'Direct deposit' : p.type === 'BRANCH_CARD' ? 'Pay card' : 'Other', strong: true },
        { label: 'Account type', value: human(p.accountType) },
        { label: 'Routing', value: p.routingMasked ?? '—' },
        { label: 'Account', value: p.accountLast4 ? `••••${p.accountLast4}` : '—' },
        { label: 'Card', value: p.branchCardId ? `Card on file` : '—' },
        { label: 'Verified', value: when(p.verifiedAt) },
      ],
      y,
    );
  }

  if (data.i9) {
    const i = data.i9;
    start('Employment eligibility (I-9)');
    y = k.facts(
      [
        { label: 'Citizenship status', value: human(i.citizenshipStatus), strong: true },
        { label: 'Section 1 completed', value: when(i.section1CompletedAt) },
        { label: 'Section 1 signature', value: i.section1TypedName ?? '—' },
        { label: 'Section 2 completed', value: when(i.section2CompletedAt) },
        { label: 'Section 2 verifier', value: i.section2VerifierEmail ?? '—' },
        { label: 'Documents examined', value: i.documentList ?? '—' },
        { label: 'Work authorization expires', value: when(i.workAuthExpiresAt) },
        { label: 'A-Number on file', value: i.hasAlienRegistrationNumber ? 'Yes (not printed)' : 'No' },
      ],
      y,
    );
    if (i.section1CompletedAt && !i.section2CompletedAt) y = k.callout({ tone: 'warn', title: 'Section 2 is open', body: 'Section 2 must be completed within three business days of the first day of work.' }, y);
  }

  const tableStart = (title: string) => start(title, 90);
  const statusColor = (st: string) => (/COMPLETE|DONE|VERIFIED|APPROVED|SIGNED/.test(st) ? COLOR.good : /REJECT|FAIL|EXPIRED/.test(st) ? COLOR.bad : /PENDING|IN_PROGRESS|REVIEW/.test(st) ? COLOR.warn : undefined);

  tableStart('Onboarding checklist');
  y = k.table({
    y,
    rows: data.tasks,
    empty: 'No checklist tasks.',
    columns: [
      { key: 'title', header: 'Task', width: 4, value: (t) => t.title },
      { key: 'kind', header: 'Kind', width: 2, value: (t) => human(t.kind) },
      { key: 'status', header: 'Status', width: 1.6, value: (t) => human(t.status), color: (t) => statusColor(t.status) },
      { key: 'done', header: 'Completed', width: 2.2, value: (t) => when(t.completedAt) },
    ],
  });

  tableStart('Policy acknowledgments');
  y = k.table({
    y,
    rows: data.policyAcks,
    empty: 'No policies to acknowledge.',
    columns: [
      { key: 'title', header: 'Policy', width: 5, value: (p) => p.title },
      { key: 'version', header: 'Version', width: 1.2, value: (p) => p.version },
      { key: 'ack', header: 'Acknowledged', width: 2.4, value: (p) => when(p.acknowledgedAt), color: (p) => (p.acknowledgedAt ? undefined : COLOR.warn) },
    ],
  });

  tableStart('Electronic signatures');
  y = k.table({
    y,
    rows: data.esignAgreements,
    empty: 'No agreements signed.',
    columns: [
      { key: 'title', header: 'Agreement', width: 3.4, value: (e) => e.title },
      { key: 'typed', header: 'Typed signature', width: 2.2, value: (e) => e.typedName ?? '—' },
      { key: 'signed', header: 'Signed', width: 2.2, value: (e) => when(e.signedAt) },
      { key: 'hash', header: 'Document SHA-256', width: 2.2, value: (e) => (e.pdfHashHex ? `${e.pdfHashHex.slice(0, 16)}…` : '—') },
    ],
  });

  tableStart('Document register');
  y = k.table({
    y,
    rows: data.documents,
    empty: 'No documents uploaded.',
    columns: [
      { key: 'kind', header: 'Document', width: 2.2, value: (d) => human(d.kind) },
      { key: 'file', header: 'File', width: 2.8, value: (d) => d.filename },
      { key: 'status', header: 'Status', width: 1.5, value: (d) => (d.rejectionReason ? `${human(d.status)}: ${d.rejectionReason}` : human(d.status)), color: (d) => statusColor(d.status) },
      { key: 'verified', header: 'Verified', width: 2.4, value: (d) => (d.verifiedAt ? `${when(d.verifiedAt)}${d.verifiedByEmail ? ` · ${d.verifiedByEmail}` : ''}` : '—') },
    ],
  });

  tableStart('Audit trail');
  y = k.table({
    y,
    rows: [...data.audit].sort((x, z) => x.createdAt.localeCompare(z.createdAt)),
    empty: 'No events recorded.',
    columns: [
      { key: 'when', header: 'When', width: 2.2, value: (e) => when(e.createdAt) },
      { key: 'action', header: 'Event', width: 3.6, value: (e) => human(e.action.replace(/^onboarding\./, '').replace(/\./g, ' ')) },
      { key: 'actor', header: 'By', width: 2.6, value: (e) => e.actorEmail ?? 'System' },
    ],
  });
  void y;

  drawContents(k, contentsPage, entries);
  return k.finish({ reference: `Application ${data.application.id.slice(0, 8)} · SHA-256 ${fingerprint.slice(0, 16)}`, note: brand.name });
}

