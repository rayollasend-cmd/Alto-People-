import { z } from 'zod';

/**
 * Brief 2-5 — the SOC 2 control catalog and the evidence it produces.
 *
 *   One list, read by the evidence page, the jobs that collect evidence and
 *   the docs (docs/soc2-controls-investigation.md §4.2). Evidence is
 *   platform-level: SOC 2 evidence belongs to Alto People as the service
 *   organization, not to a tenant (owner's decision 1, 2026-10-13).
 *
 *   A control without a collector yet still appears on the page, marked
 *   "no evidence": the page is the to-do list until every row is green.
 */

export const EVIDENCE_STATUSES = ['PASS', 'FAIL', 'WARN'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** How a control's evidence is produced. */
export type EvidenceCollection = 'job' | 'script' | 'ci' | 'runbook' | 'attestation' | 'review';

export interface ComplianceControl {
  id: string;
  title: string;
  /** The SOC 2 trust services criteria it answers. */
  criteria: string[];
  /** Evidence older than this many days is stale. */
  freshnessDays: number;
  /** The role that owns the control and signs off where a sign-off is needed. */
  ownerRole: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' | 'FINANCE_ACCOUNTANT';
  collection: EvidenceCollection;
  /** A person must sign the evidence off (access review, rotation, attestations). */
  needsSignoff: boolean;
  /** The Brief 2-5 rollout step that builds its collector. */
  step: number;
  how: string;
}

export const COMPLIANCE_CONTROLS: readonly ComplianceControl[] = [
  {
    id: 'job-secrets-separated',
    title: 'Each HMAC job and MFA has its own secret',
    criteria: ['CC6.1'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 2,
    how: 'Daily job: which of the per-job secrets are set apart from the field-encryption key (values are never read into the record).',
  },
  {
    id: 'field-encryption-inventory',
    title: 'Every encrypted column decrypts under the running key',
    criteria: ['CC6.1'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'script',
    needsSignoff: false,
    step: 4,
    how: 'The key audit (scripts/audit-encryption-key.ts --persist): unreadable rows by column, counts only.',
  },
  {
    id: 'keyring-rotation',
    title: 'Field-encryption key rotated with no data loss',
    criteria: ['CC6.1'],
    freshnessDays: 366,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'runbook',
    needsSignoff: true,
    step: 3,
    how: 'The rotation runbook (dry run, then live): re-encrypted count equals row count, zero failures, old key retired.',
  },
  {
    id: 'tls-web',
    title: 'TLS and HSTS on the public site',
    criteria: ['CC6.7'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Daily job: TLS version, certificate expiry and the HSTS header on the public health URL.',
  },
  {
    id: 'tls-database',
    title: 'TLS to the database',
    criteria: ['CC6.7'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Daily job: pg_stat_ssl for the API connection reports ssl = true.',
  },
  {
    id: 'blob-encryption',
    title: 'Uploaded documents encrypted at rest',
    criteria: ['CC6.1'],
    freshnessDays: 92,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'attestation',
    needsSignoff: true,
    step: 4,
    how: 'Provider setting attested in the console, plus a daily HeadObject check where the provider reports it.',
  },
  {
    id: 'database-backup',
    title: 'Daily encrypted database backup',
    criteria: ['A1.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 5,
    how: 'Nightly encrypted logical dump with a row-count manifest; Neon point-in-time retention attested.',
  },
  {
    id: 'restore-test',
    title: 'Monthly restore test',
    criteria: ['A1.2', 'A1.3'],
    freshnessDays: 35,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 5,
    how: 'Monthly job restores the newest dump into a scratch database and compares row counts with the manifest.',
  },
  {
    id: 'uploads-backup',
    title: 'Nightly uploads backup',
    criteria: ['A1.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 5,
    how: 'The uploads backup job records each run.',
  },
  {
    id: 'access-review',
    title: 'Quarterly access review',
    criteria: ['CC6.2', 'CC6.3'],
    freshnessDays: 92,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'review',
    needsSignoff: true,
    step: 6,
    how: 'Every elevated account and every agent with its scopes, gates and owner; flags resolved or accepted; signed off by a named approver. Until step 6, the 1A-4 access report run (scripts/access-report.ts --persist).',
  },
  {
    id: 'dependency-scanning',
    title: 'No unaccepted high-severity dependency in production',
    criteria: ['CC7.1'],
    freshnessDays: 8,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'ci',
    needsSignoff: false,
    step: 7,
    how: 'CI step npm audit --omit=dev --audit-level=high against the accepted-risk list, on every push and weekly.',
  },
  {
    id: 'auth-anomaly-alerting',
    title: 'Sign-in anomalies alert the security contact',
    criteria: ['CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 7,
    how: 'Rules over audit rows (lockouts, failed-sign-in bursts, MFA disabled on an admin); a daily row of the alerts sent.',
  },
  {
    id: 'privilege-change-alerting',
    title: 'Privilege changes alert the security contact',
    criteria: ['CC6.3', 'CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 7,
    how: 'Rules over audit rows: admin-capable role changes, region scope granted, agent scope widened, gated actions approved.',
  },
  {
    id: 'export-alerting',
    title: 'Data exports are audited and large ones alert',
    criteria: ['CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 7,
    how: 'Every export route writes an audit row (proved by a test); exports above a threshold or of sensitive kinds alert.',
  },
  {
    id: 'audit-log-immutability',
    title: 'The audit log cannot be edited',
    criteria: ['CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Daily probe: an UPDATE on a sentinel row inside a rolled-back transaction is refused by the trigger.',
  },
  {
    id: 'audit-chain',
    title: 'The audit log’s hash chain verifies',
    criteria: ['CC7.2', 'CC7.3'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Nightly: every tenant’s chain is recomputed in the database with the insert trigger’s own function; a changed, removed or reordered row, or a cut tail, is a FAIL and raises an AUDIT_CHAIN alert (Brief 2-3 step 4).',
  },
];

export const COMPLIANCE_CONTROL_IDS = COMPLIANCE_CONTROLS.map((c) => c.id);

export function complianceControl(id: string): ComplianceControl | undefined {
  return COMPLIANCE_CONTROLS.find((c) => c.id === id);
}

/* ---------------------------------------------------------------- *
 *  The evidence page's wire shapes.
 * ---------------------------------------------------------------- */

export const EvidenceSignoffSchema = /* @__PURE__ */ (() => z.object({
  id: z.string(),
  signedOffById: z.string(),
  signedOffByEmail: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
}))();
export type EvidenceSignoff = z.infer<typeof EvidenceSignoffSchema>;

export const EvidenceRowSchema = /* @__PURE__ */ (() => z.object({
  id: z.string(),
  control: z.string(),
  status: z.enum(EVIDENCE_STATUSES),
  summary: z.string(),
  details: z.unknown(),
  collectedAt: z.string(),
  collectedBy: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  signoffs: z.array(EvidenceSignoffSchema),
}))();
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

export type ControlState = 'current' | 'stale' | 'failing' | 'missing' | 'awaiting-signoff';

/**
 * ONE STATUS VOCABULARY FOR A CONTROL (F500 SH-4). The Trust Center, its
 * SOC 2 block, the public trust page and Compliance evidence all say a
 * control is one of four things, from this one rule:
 *
 *   NO_EVIDENCE    nothing collected, or the latest is past its window
 *   FAILING        the latest evidence failed, or warned on a control no
 *                  person signs off (the requirement isn't met)
 *   NEEDS_SIGNOFF  the evidence is in, and a named person must sign it off
 *   PASSING        current, passed (or attested by its sign-off), signed
 *                  off where that is required
 *
 * Before, the Trust Center counted "3 / 16 passing" (the latest row's PASS)
 * while Compliance evidence counted "8 of 16 current" (a WARN read as
 * current), and the same row was "Attention" on one and "Current" on the other.
 */
export const CONTROL_STATUSES = ['PASSING', 'NEEDS_SIGNOFF', 'FAILING', 'NO_EVIDENCE'] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];

export const CONTROL_STATUS_LABELS: Record<ControlStatus, string> = {
  PASSING: 'Passing',
  NEEDS_SIGNOFF: 'Needs sign-off',
  FAILING: 'Failing',
  NO_EVIDENCE: 'No evidence',
};

export function controlStatusOf(c: {
  state: ControlState;
  needsSignoff: boolean;
  latest: { status: EvidenceStatus; signoffs: readonly unknown[] } | null;
}): ControlStatus {
  if (!c.latest || c.state === 'missing' || c.state === 'stale') return 'NO_EVIDENCE';
  if (c.latest.status === 'FAIL') return 'FAILING';
  const signed = c.latest.signoffs.length > 0;
  if (c.needsSignoff) return signed ? 'PASSING' : 'NEEDS_SIGNOFF';
  return c.latest.status === 'PASS' ? 'PASSING' : 'FAILING';
}

export interface ComplianceControlView extends ComplianceControl {
  latest: EvidenceRow | null;
  /** Days since the latest evidence was collected, or null when there is none. */
  ageDays: number | null;
  state: ControlState;
  /** The one status every page shows (controlStatusOf). */
  status: ControlStatus;
}

export interface ComplianceEvidenceResponse {
  generatedAt: string;
  controls: ComplianceControlView[];
  counts: Record<ControlState, number>;
  /** Controls by the one status — the numbers the Trust Center shows too. */
  statusCounts: Record<ControlStatus, number>;
}

export const EvidenceSignoffInputSchema = /* @__PURE__ */ (() => z.object({
  note: z.string().trim().max(1000).optional(),
}))();
export type EvidenceSignoffInput = z.infer<typeof EvidenceSignoffInputSchema>;

/**
 * The tenant that operates the platform (Alto HR, tenant 1). Platform
 * evidence is answered only to it until Brief 2-3 brings a
 * platform-operator role.
 */
export const PLATFORM_OPERATOR_TENANT_ID = '00000000-0000-4000-8000-000000000001';
