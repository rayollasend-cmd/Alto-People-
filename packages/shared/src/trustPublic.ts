import type { ControlStatus } from './complianceEvidence.js';

/**
 * The public Trust Center's own words (F500 G5). The evidence catalog
 * (complianceEvidence.ts) is written for the people who run the controls —
 * script names, brief steps, SQL — and the public page printed it verbatim
 * to a prospect's security reviewer. Here: a customer-language title per
 * control (its `plain` line is the summary) and the five areas a security
 * review reads by, each with one status. The anonymous API sends these,
 * never `how`.
 */

export type TrustAreaKey = 'data-protection' | 'access' | 'availability' | 'change' | 'monitoring';

export interface TrustAreaDef {
  key: TrustAreaKey;
  label: string;
  controls: readonly string[];
}

export const TRUST_AREAS: readonly TrustAreaDef[] = [
  { key: 'data-protection', label: 'Data protection', controls: ['field-encryption-inventory', 'keyring-rotation', 'tls-web', 'tls-database', 'blob-encryption', 'job-secrets-separated'] },
  { key: 'access', label: 'Access', controls: ['access-review', 'privilege-change-alerting'] },
  { key: 'availability', label: 'Availability', controls: ['database-backup', 'restore-test', 'uploads-backup'] },
  { key: 'change', label: 'Change management', controls: ['dependency-scanning'] },
  { key: 'monitoring', label: 'Monitoring and audit', controls: ['auth-anomaly-alerting', 'export-alerting', 'audit-log-immutability', 'audit-chain'] },
];

/** Each control's title in a customer's words. */
export const PUBLIC_CONTROL_TITLES: Readonly<Record<string, string>> = {
  'job-secrets-separated': 'Separate keys for each background service',
  'field-encryption-inventory': 'Sensitive fields encrypted and readable',
  'keyring-rotation': 'Encryption keys rotated',
  'tls-web': 'Encrypted connections to the website',
  'tls-database': 'Encrypted connections to the database',
  'blob-encryption': 'Documents encrypted at rest',
  'database-backup': 'Nightly encrypted backups',
  'restore-test': 'Backups restored and checked monthly',
  'uploads-backup': 'Uploaded files backed up nightly',
  'access-review': 'Quarterly access review',
  'dependency-scanning': 'Software dependencies checked for known flaws',
  'auth-anomaly-alerting': 'Alerts on unusual sign-in activity',
  'privilege-change-alerting': 'Alerts on permission changes',
  'export-alerting': 'Data exports recorded and alerted',
  'audit-log-immutability': 'Tamper-proof audit log',
  'audit-chain': 'Audit log verified nightly',
};

/**
 * One status per area, for an anonymous reader: every control passing is
 * "passing"; any control failing is "attention" (being worked on, not a red
 * "Failed" with the detail); otherwise evidence is still being gathered.
 */
export type TrustAreaStatus = 'passing' | 'attention' | 'in-progress';

export function trustAreaStatusOf(statuses: readonly ControlStatus[]): TrustAreaStatus {
  if (statuses.length > 0 && statuses.every((s) => s === 'PASSING')) return 'passing';
  if (statuses.some((s) => s === 'FAILING')) return 'attention';
  return 'in-progress';
}

export const TRUST_AREA_STATUS_LABELS: Record<TrustAreaStatus, string> = {
  passing: 'All checks passing',
  attention: 'Being addressed',
  'in-progress': 'Evidence being gathered',
};

/** A public area, as GET /trust/public sends it. */
export interface TrustAreaPublic {
  key: TrustAreaKey;
  label: string;
  status: TrustAreaStatus;
  /** Controls in the area, by public title and plain summary — no per-control status (an owner decision). */
  controls: Array<{ id: string; title: string; summary: string; criteria: string[] }>;
  lastCheckedAt: string | null;
}
