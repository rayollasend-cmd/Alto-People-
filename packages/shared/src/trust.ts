import { z } from 'zod';
import type { TrustAreaPublic } from './trustPublic.js';
import type { ControlStatus } from './complianceEvidence.js';
/**
 * The Trust Center (UX upgrade step 4; docs/ux-upgrade-investigation.md
 * §5.5): what a buyer, an auditor or an IT admin can see about how the
 * platform is run, drawn from the controls that collect their own evidence
 * (Brief 2-5), the audit chain (2-3 step 4), the agent registry (1D-2/3)
 * and the decision record (2-6). Two shapes: the PUBLIC summary carries
 * statuses and dates only; the in-app view adds the tenant's own numbers.
 */

export type TrustStatus = 'PASS' | 'WARN' | 'FAIL' | 'PENDING';

export interface TrustControlPublic {
  id: string;
  title: string;
  /** SOC 2 criteria the control serves (CC6.1, A1.2…). */
  criteria: string[];
  /** The older four words, derived from controlStatus (PASSING→PASS, NEEDS_SIGNOFF→WARN, FAILING→FAIL, NO_EVIDENCE→PENDING). */
  status: TrustStatus;
  /** The one status vocabulary every page shows (complianceEvidence.ts controlStatusOf). Always sent by the API; optional for older payloads. */
  controlStatus?: ControlStatus;
  /** When the last evidence was collected; null when none yet. */
  checkedAt: string | null;
  /** One sentence about what the control checks; never a value from it. The anonymous page never receives it (F500 G5). */
  how?: string;
  /** What the control means, in one plain line — said first; `how` sits behind "How it's checked" (F500 G4). Optional for older payloads. */
  plain?: string;
}

export interface SubProcessor {
  name: string;
  purpose: string;
  region: string;
  /** The vendor's own trust or privacy page. */
  url: string;
}

export interface TrustCommitment {
  title: string;
  body: string;
}

export interface TrustSummaryPublic {
  generatedAt: string;
  product: string;
  /** Controls passing / total, the number the badge shows. */
  /** `passing` is CONTROL status PASSING — the number Compliance evidence shows. */
  controls: { passing: number; total: number; items: TrustControlPublic[]; statusCounts?: Record<ControlStatus, number> };
  /** The five areas a security review reads by, one status each (trustPublic.ts). Sent by the public route. */
  areas?: TrustAreaPublic[];
  /** The audit trail's tamper evidence, platform-wide. */
  auditChain: { verifiedAt: string | null; ok: boolean | null };
  retention: { auditYearsMinimum: number };
  agents: { registered: number; certified: number; governed: true };
  subProcessors: SubProcessor[];
  commitments: TrustCommitment[];
  /** Whether a security contact is set (the address itself is never public). */
  securityContactSet: boolean;
  /** Where the SOC 2 effort stands, from the controls' evidence (never a claim they do not back). */
  soc2: Soc2Progress;
}

export interface TrustSummary extends TrustSummaryPublic {
  tenant: {
    auditChain: { verifiedAt: string | null; ok: boolean | null; rows: number; headSeq: string | null };
    retentionYears: number;
    archives: number;
    siem: 'OFF' | 'ON' | 'FAILING';
    sso: { connections: number; ssoRequiredForStaff: boolean; scim: boolean };
    agents: { registered: number; active: number; certified: number; suspended: number; gates: number; decisionRecords: number; lastBiasAuditAt: string | null };
    accessReview: { lastAt: string | null; signedOff: boolean | null };
  };
}

/** The vendors that process customer data for the platform, with what for. Kept here so the public page and the DPA list never drift. */
export const SUB_PROCESSORS: readonly SubProcessor[] = [
  { name: 'Railway', purpose: 'Application hosting (the API and the web app)', region: 'United States', url: 'https://railway.com/legal/privacy' },
  { name: 'Neon', purpose: 'PostgreSQL database with point-in-time recovery', region: 'United States', url: 'https://neon.tech/privacy-policy' },
  { name: 'Amazon Web Services (S3-compatible storage)', purpose: 'Encrypted document, photo and backup storage', region: 'United States', url: 'https://aws.amazon.com/compliance/' },
  { name: 'Resend', purpose: 'Transactional email', region: 'United States', url: 'https://resend.com/legal/privacy-policy' },
  { name: 'Meta (WhatsApp Business Platform)', purpose: 'WhatsApp messages to workers who opted in', region: 'United States', url: 'https://www.whatsapp.com/legal/business-data-transfer-addendum' },
  { name: 'Stripe', purpose: 'Invoicing and payment collection', region: 'United States', url: 'https://stripe.com/privacy' },
  { name: 'Intuit (QuickBooks Online)', purpose: 'Accounting sync when a customer connects it', region: 'United States', url: 'https://www.intuit.com/privacy/statement/' },
  { name: 'Sentry', purpose: 'Error monitoring (no personal data in events by policy)', region: 'United States', url: 'https://sentry.io/privacy/' },
  { name: 'GitHub', purpose: 'Source control, CI, and the encrypted database backup job', region: 'United States', url: 'https://docs.github.com/en/site-policy/privacy-policies' },
];

export const TRUST_COMMITMENTS: readonly TrustCommitment[] = [
  { title: 'A person is accountable for every agent', body: 'Every AI agent is registered with a named owner, scopes, a spend cap and a kill switch. An agent proposes; a person decides. Actions that touch pay, separations, client messages or exports wait for an approval.' },
  { title: 'Decisions about people are recorded', body: 'Each automated decision about a person is written to an append-only record with what was decided, by which agent and model version, and who approved it. Bias audits are kept with it for the jurisdictions that require them.' },
  { title: 'The audit trail cannot be edited', body: 'Audit rows are append-only at the database, chained by hash per customer, and verified every night. Any change, removal or reordering is detected and alerted.' },
  { title: 'Field-level encryption with rotation', body: 'Tax ids, bank details, identity documents and face templates are encrypted at the field with a keyring that can be rotated without downtime; the inventory is checked daily.' },
  { title: 'Retention you control', body: 'Audit rows are kept for at least seven years and archived encrypted past that; nothing is deleted without a separate, approved procedure.' },
  { title: 'Your own sign-in', body: 'Single sign-on (OIDC and SAML) and SCIM provisioning per customer, with accounts bound to the identity provider’s subject after the first sign-in.' },
];

/* ------------------------------------------------------- SOC 2 progress -- */

/**
 * Where the SOC 2 effort stands, said from the evidence: "preparing" while any
 * control still lacks current evidence, "observation" once every control has
 * collected its own evidence inside its freshness window, and "audited" only
 * when the operator has recorded the date an auditor issued the report.
 */
export type Soc2Stage = 'preparing' | 'observation' | 'audited';

export const SOC2_STAGE_LABELS: Record<Soc2Stage, string> = {
  preparing: 'Preparing: controls are still being brought current',
  observation: 'Observation period: every control is collecting evidence',
  audited: 'Audited: a SOC 2 report has been issued',
};

export interface Soc2Progress {
  stage: Soc2Stage;
  controlsPassing: number;
  /** Controls whose latest evidence is inside its freshness window (passing or not). */
  controlsCurrent: number;
  controlsTotal: number;
  /** The newest evidence row across every control; null before the first sweep. */
  lastEvidenceAt: string | null;
  /** The first day every control had evidence — the start of the observation period; null until then. */
  observationSince: string | null;
  /** The auditor's report date the operator recorded; null until there is one. */
  reportIssuedOn: string | null;
}

/* ------------------------------------------------------ gated downloads -- */

export const TRUST_DOCUMENT_KINDS = ['SOC2_REPORT', 'PEN_TEST_SUMMARY', 'SUB_PROCESSOR_LIST', 'DPA'] as const;
export type TrustDocumentKind = (typeof TRUST_DOCUMENT_KINDS)[number];

export const TRUST_DOCUMENT_LABELS: Record<TrustDocumentKind, string> = {
  SOC2_REPORT: 'SOC 2 report',
  PEN_TEST_SUMMARY: 'Penetration test summary',
  SUB_PROCESSOR_LIST: 'Sub-processor list',
  DPA: 'Data processing addendum',
};

export type TrustRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED';

/** The public form: who is asking, for which document. */
export const TrustDownloadRequestInputSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().toLowerCase().email().max(254),
    company: z.string().trim().min(2).max(200),
    kind: z.enum(TRUST_DOCUMENT_KINDS),
    note: z.string().trim().max(1000).optional(),
  }))();
export type TrustDownloadRequestInput = z.infer<typeof TrustDownloadRequestInputSchema>;

export const TrustRequestDecisionSchema = /* @__PURE__ */ (() =>
  z.object({
    decision: z.enum(['APPROVED', 'DECLINED']),
  }))();

export const TrustDocumentMetaSchema = /* @__PURE__ */ (() =>
  z.object({
    kind: z.enum(TRUST_DOCUMENT_KINDS),
    title: z.string().trim().min(2).max(200),
  }))();

export const Soc2ReportInputSchema = /* @__PURE__ */ (() =>
  z.object({
    /** YYYY-MM-DD, or null to withdraw the claim. */
    reportIssuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }))();

export interface TrustDocumentSummary {
  id: string;
  kind: TrustDocumentKind;
  title: string;
  contentType: string;
  bytes: number;
  updatedAt: string;
}

export interface TrustDownloadRequestSummary {
  id: string;
  kind: TrustDocumentKind;
  name: string;
  email: string;
  company: string;
  note: string | null;
  status: TrustRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  linkExpiresAt: string | null;
  downloadCount: number;
  lastDownloadedAt: string | null;
  /** True when a document of this kind is on file, so approving will actually send something. */
  documentOnFile: boolean;
}
