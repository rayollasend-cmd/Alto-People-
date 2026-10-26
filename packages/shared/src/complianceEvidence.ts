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
  /** The control's name in plain English (F500 audit 2026-10-26: no "HMAC", "TLS" or "HSTS"); the criteria codes are its secondary label. */
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
  /** How the evidence is collected — the technical line, behind "How it's checked". */
  how: string;
  /** What the control means, in one plain line (F500 G4): the first thing the Trust Center and Compliance evidence say. */
  plain: string;
  /** What to do when it is not passing — the next step, in plain words. */
  remedy: string;
  /** Where that step is taken, when it is a page in the app. */
  remedyHref?: string;
}

export const COMPLIANCE_CONTROLS: readonly ComplianceControl[] = [
  {
    id: 'job-secrets-separated',
    title: 'Each protected service has its own key',
    criteria: ['CC6.1'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 2,
    how: 'Daily job: which of the per-job secrets are set apart from the field-encryption key (values are never read into the record).',
    plain: 'Each background job and two-step sign-in uses its own secret key.',
    remedy: 'Give each service its own secret in the server’s settings (the latest result’s technical detail names the ones still sharing the main encryption key), then redeploy.',
  },
  {
    id: 'field-encryption-inventory',
    title: 'Encrypted fields readable with the current key',
    criteria: ['CC6.1'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'script',
    needsSignoff: false,
    step: 4,
    how: 'The key audit counts the rows the running key cannot read, by column: counts only, never a value.',
    plain: 'Every encrypted field can still be read with the current key.',
    remedy: 'Re-encrypt the unreadable columns with the rotation runbook before any old key is retired.',
  },
  {
    id: 'keyring-rotation',
    title: 'Encryption key changed yearly without data loss',
    criteria: ['CC6.1'],
    freshnessDays: 366,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'runbook',
    needsSignoff: true,
    step: 3,
    how: 'The rotation runbook (dry run, then live): re-encrypted count equals row count, zero failures, old key retired.',
    plain: 'The encryption key is changed every year without losing data.',
    remedy: 'Run the rotation runbook (a dry run, then live) and sign off its record here.',
  },
  {
    id: 'tls-web',
    title: 'Encrypted connections to the website',
    criteria: ['CC6.7'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Daily job: TLS version, certificate expiry and the HSTS header on the public health URL.',
    plain: 'The website only accepts encrypted connections.',
    remedy: 'Serve the site over https with a valid certificate and the HSTS header.',
  },
  {
    id: 'tls-database',
    title: 'Encrypted connection to the database',
    criteria: ['CC6.7'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Daily job: the API’s own database connection reports whether it is encrypted.',
    plain: 'The app talks to its database over an encrypted connection.',
    remedy: 'Require SSL on the database connection (sslmode=require in its connection string), then redeploy.',
  },
  {
    id: 'blob-encryption',
    title: 'Uploaded documents encrypted where stored',
    criteria: ['CC6.1'],
    freshnessDays: 92,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'attestation',
    needsSignoff: true,
    step: 4,
    how: 'The provider’s setting, attested in its console, plus a daily storage check where the provider reports it.',
    plain: 'Uploaded documents are encrypted where they are stored.',
    remedy: 'Confirm encryption at rest in the storage provider’s console, then sign off the attestation here.',
  },
  {
    id: 'database-backup',
    title: 'Nightly encrypted database backup',
    criteria: ['A1.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 5,
    how: 'Nightly encrypted logical dump with a row-count manifest; Neon point-in-time retention attested.',
    plain: 'The database is backed up, encrypted, every night.',
    remedy: 'Check the nightly backup job; a missed night shows as no evidence until it runs again.',
  },
  {
    id: 'restore-test',
    title: 'Backups restored and checked monthly',
    criteria: ['A1.2', 'A1.3'],
    freshnessDays: 35,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 5,
    how: 'Monthly job restores the newest dump into a scratch database and compares row counts with the manifest.',
    plain: 'A backup is restored once a month to prove it works.',
    remedy: 'Run the restore test. A row-count mismatch means the backup is incomplete: find out why before the next one.',
  },
  {
    id: 'uploads-backup',
    title: 'Uploaded files backed up nightly',
    criteria: ['A1.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 5,
    how: 'The uploads backup job records each run.',
    plain: 'Uploaded files are backed up every night.',
    remedy: 'Check the uploads backup job and its storage credentials.',
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
    how: 'Every elevated account and every agent with its scopes, gates and owner; flags resolved or accepted; signed off by a named approver.',
    plain: 'Every quarter a person reviews who has elevated access, and signs it off.',
    remedy: 'Open Access certifications, resolve or accept the flags, and sign the review off.',
    remedyHref: '/admin/access-certifications',
  },
  {
    id: 'dependency-scanning',
    title: 'Software dependencies checked for serious flaws',
    criteria: ['CC7.1'],
    freshnessDays: 8,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'ci',
    needsSignoff: false,
    step: 7,
    how: 'On every push and once a week, CI checks production dependencies for high-severity advisories against the accepted-risk list.',
    plain: 'No known serious flaw in the software the app is built on goes unaddressed.',
    remedy: 'Upgrade the affected package, or record an accepted risk with its reason.',
  },
  {
    id: 'auth-anomaly-alerting',
    title: 'Unusual sign-ins alert the security contact',
    criteria: ['CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 7,
    how: 'Rules over audit rows (lockouts, failed-sign-in bursts, MFA disabled on an admin); a daily row of the alerts sent.',
    plain: 'Unusual sign-in activity alerts the security contact.',
    remedy: 'Set a security contact email on this page so the alerts reach a person.',
    remedyHref: '/admin/compliance-evidence#security-contact',
  },
  {
    id: 'privilege-change-alerting',
    title: 'Permission changes alert the security contact',
    criteria: ['CC6.3', 'CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 7,
    how: 'Rules over audit rows: admin-capable role changes, region scope granted, agent scope widened, gated actions approved.',
    plain: 'Changes to who can do what alert the security contact.',
    remedy: 'Set a security contact email on this page so the alerts reach a person.',
    remedyHref: '/admin/compliance-evidence#security-contact',
  },
  {
    id: 'export-alerting',
    title: 'Every data export recorded, large ones alerted',
    criteria: ['CC7.2'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 7,
    how: 'Every export route writes an audit row (proved by a test); exports above a threshold or of sensitive kinds alert.',
    plain: 'Every data export is recorded, and large ones raise an alert.',
    remedy: 'Set a security contact email on this page so the alerts reach a person.',
    remedyHref: '/admin/compliance-evidence#security-contact',
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
    plain: 'No one can edit or delete the audit log.',
    remedy: 'The database stopped refusing edits: restore the audit triggers from the migrations and contact support.',
  },
  {
    id: 'audit-chain',
    title: 'Audit log checked nightly for changes',
    criteria: ['CC7.2', 'CC7.3'],
    freshnessDays: 2,
    ownerRole: 'HR_ADMINISTRATOR',
    collection: 'job',
    needsSignoff: false,
    step: 4,
    how: 'Nightly: every organization’s chain is recomputed in the database with the insert trigger’s own function; a changed, removed or reordered row, or a cut tail, fails and raises an alert.',
    plain: 'The audit log is checked every night for any change.',
    remedy: 'Check the chain again on the Audit log. If it still breaks, contact support: the break shows which rows changed.',
    remedyHref: '/audit',
  },
];

export const COMPLIANCE_CONTROL_IDS = /* @__PURE__ */ (() => COMPLIANCE_CONTROLS.map((c) => c.id))();

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
  /** One plain sentence: no variable names, rule keys or addresses (F500 audit 2026-10-26). */
  summary: z.string(),
  /** The technical line behind it (variable names, rule keys, versions), for a "Technical detail" disclosure; null when there is none. Optional for older payloads. */
  detail: z.string().nullable().optional(),
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
