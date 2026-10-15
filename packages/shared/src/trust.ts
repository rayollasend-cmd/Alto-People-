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
  status: TrustStatus;
  /** When the last evidence was collected; null when none yet. */
  checkedAt: string | null;
  /** One sentence about what the control checks; never a value from it. */
  how: string;
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
  controls: { passing: number; total: number; items: TrustControlPublic[] };
  /** The audit trail's tamper evidence, platform-wide. */
  auditChain: { verifiedAt: string | null; ok: boolean | null };
  retention: { auditYearsMinimum: number };
  agents: { registered: number; certified: number; governed: true };
  subProcessors: SubProcessor[];
  commitments: TrustCommitment[];
  /** Whether a security contact is set (the address itself is never public). */
  securityContactSet: boolean;
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
