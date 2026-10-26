import type { EvidenceStatus } from '@alto-people/shared';

/**
 * What a piece of SOC 2 evidence SAYS (F500 audit 2026-10-26, finding 4).
 *
 *   The collectors used to write their own one-liners, and the page printed
 *   them verbatim: env-var names ("MFA_SECRET_ENCRYPTION_KEY…"), rule keys
 *   ("failed_signins_ip"), the dev server's address ("http://localhost:5173")
 *   and plurals like "All 1 encrypted values" or "across 1 chains". Now each
 *   control's words come from here, in two parts:
 *
 *     summary   one plain sentence, correct plurals, no codes, no addresses
 *     detail    the technical line an engineer or auditor wants (variable
 *               names, rule keys, versions), shown behind a disclosure
 *
 *   The collectors write `summary` with these functions, and the read path
 *   re-says every row from its stored `details` the same way, so rows
 *   collected before this change read correctly too. A row whose details
 *   do not have the expected shape keeps its stored summary (scrubbed of
 *   any local address).
 */

export interface EvidenceText {
  summary: string;
  detail: string | null;
}

type Details = Record<string, unknown>;

const num = (n: number) => n.toLocaleString('en-US');

/** "1 account", "2 accounts", "1,204 entries". */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const isRecord = (v: unknown): v is Details => typeof v === 'object' && v !== null && !Array.isArray(v);
const numberAt = (d: Details, k: string): number | null => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : null);
const stringAt = (d: Details, k: string): string | null => (typeof d[k] === 'string' && (d[k] as string).length > 0 ? (d[k] as string) : null);

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/i;

/** True for a host a customer must never be shown (the dev server's own address). */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOST.test(hostname) || hostname.endsWith('.local');
}

/** Removes local addresses from text written before this change ("(http://localhost:5173)"). */
export function scrubLocalAddresses(text: string): string {
  return text
    .replace(/\s*\(\s*https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?[^)]*\)/gi, '')
    .replace(/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\S*/gi, 'this server')
    .trim();
}

/** The day the field-encryption key changed (the 2026-06-11 incident), said as a date. */
const KEY_CHANGE_DAY = 'Jun 11, 2026';

/* ---------------------------------------------------------------- *
 *  Per-control wording.
 * ---------------------------------------------------------------- */

/** What each per-job secret protects, in plain words. */
const SECRET_JOB_LABEL: Record<string, string> = {
  mfa: 'two-step sign-in',
  kioskPin: 'kiosk clock-in numbers',
  pulseHash: 'anonymous survey answers',
  accountFingerprint: 'sign-in device checks',
  apiToken: 'API tokens',
  webhookSecret: 'webhook signatures',
};

export function jobSecretsText(details: unknown): EvidenceText | null {
  if (!isRecord(details) || !Array.isArray(details.secrets)) return null;
  const secrets = details.secrets.filter(isRecord).map((s) => ({ job: String(s.job ?? ''), variable: String(s.variable ?? ''), set: s.set === true }));
  if (secrets.length === 0) return null;
  const unset = secrets.filter((s) => !s.set);
  const total = secrets.length;
  if (unset.length === 0) {
    return { summary: `Each of the ${countOf(total, 'protected service')} has its own key.`, detail: `All set: ${secrets.map((s) => s.variable).join(', ')}.` };
  }
  const what = listOf(unset.map((s) => SECRET_JOB_LABEL[s.job] ?? s.job));
  const lead = unset.length === total ? `All ${num(total)} protected services` : `${num(unset.length)} of ${countOf(total, 'protected service')}`;
  const verb = unset.length === 1 ? 'still shares' : 'still share';
  return {
    summary: `${lead} ${verb} the main encryption key: ${what}.`,
    detail: `Not yet set on the server: ${unset.map((s) => s.variable).join(', ')}.`,
  };
}

export function fieldEncryptionText(status: EvidenceStatus, details: unknown): EvidenceText | null {
  if (!isRecord(details) || !Array.isArray(details.columns)) return null;
  const cols = details.columns.filter(isRecord).map((c) => ({
    label: stringAt(c, 'label') ?? stringAt(c, 'what') ?? stringAt(c, 'column') ?? 'a field',
    rows: numberAt(c, 'rows') ?? 0,
    unreadable: numberAt(c, 'unreadable') ?? 0,
    after: numberAt(c, 'unreadableAfterIncident'),
  }));
  const rows = cols.reduce((a, c) => a + c.rows, 0);
  const unreadable = cols.reduce((a, c) => a + c.unreadable, 0);
  // The script's rows carry no per-row incident split; its status says which case it was.
  const unexplained = cols.some((c) => c.after !== null) ? cols.reduce((a, c) => a + (c.after ?? 0), 0) : status === 'FAIL' ? unreadable : 0;
  const keyring = isRecord(details.keyring) ? details.keyring : null;
  const active = keyring ? numberAt(keyring, 'active') : null;
  const keyLine = active !== null ? `Active key: ${active}.` : '';
  if (unreadable === 0) {
    const stored = cols.filter((c) => c.rows > 0).map((c) => `${c.label} (${num(c.rows)})`);
    return {
      summary:
        rows === 0
          ? 'No encrypted values are stored yet.'
          : rows === 1
            ? 'The one encrypted value can be read with the current key.'
            : `All ${num(rows)} encrypted values can be read with the current key.`,
      detail: [keyLine, stored.length ? `Stored: ${stored.join(', ')}.` : ''].filter(Boolean).join(' ') || null,
    };
  }
  const where = cols.filter((c) => c.unreadable > 0).map((c) => `${c.label} (${num(c.unreadable)})`);
  const detail = [keyLine, `Unreadable: ${where.join(', ')}.`].filter(Boolean).join(' ');
  if (unexplained > 0) {
    return {
      summary: `${countOf(unexplained, 'encrypted value')} written after the key change on ${KEY_CHANGE_DAY} can’t be read: investigate now.`,
      detail,
    };
  }
  return {
    summary: `${num(unreadable)} of ${countOf(rows, 'encrypted value')} can’t be read; all were written before the key change on ${KEY_CHANGE_DAY}. The rest can be read.`,
    detail,
  };
}

const tlsName = (p: string | null) => (p ? p.replace(/^TLSv/, 'TLS ') : null);

export function tlsWebText(status: EvidenceStatus, details: unknown): EvidenceText | null {
  if (!isRecord(details)) return null;
  const host = stringAt(details, 'host');
  if (!host) {
    // Not served over https: a development server. Its address is never shown.
    if (status !== 'WARN') return null;
    const origin = stringAt(details, 'origin');
    let shown: string | null = null;
    if (origin) {
      try {
        shown = isLocalHost(new URL(origin).hostname) ? null : origin;
      } catch {
        shown = null;
      }
    }
    return {
      summary: 'This server’s public address doesn’t use https, so there is no certificate to check (a development setup).',
      detail: shown ? `Public address: ${shown}` : null,
    };
  }
  const protocol = stringAt(details, 'protocol');
  const days = numberAt(details, 'daysLeft');
  const hsts = stringAt(details, 'hsts');
  const validTo = stringAt(details, 'validTo');
  const detail = [`Host: ${host}`, `protocol ${protocol ?? 'none'}`, `HSTS ${hsts ? 'on' : 'missing'}`, validTo ? `certificate valid to ${validTo}` : null].filter(Boolean).join(' · ');
  if (status === 'PASS') {
    return {
      summary: `Connections to ${host} are encrypted (${tlsName(protocol)}), the certificate is good for ${countOf(days ?? 0, 'more day')}, and browsers are told to always use https.`,
      detail,
    };
  }
  const problems: string[] = [];
  if (protocol !== 'TLSv1.2' && protocol !== 'TLSv1.3') problems.push(protocol ? `it uses an outdated protocol (${tlsName(protocol)})` : 'it isn’t encrypted');
  if (days === null) problems.push('the certificate couldn’t be read');
  else if (days <= 0) problems.push('the certificate has expired');
  else if (days <= 14) problems.push(`the certificate expires in ${countOf(days, 'day')}`);
  if (!hsts) problems.push('browsers aren’t told to always use https');
  return { summary: `Connections to ${host} need attention: ${listOf(problems)}.`, detail };
}

export function tlsDatabaseText(details: unknown): EvidenceText | null {
  if (!isRecord(details) || typeof details.ssl !== 'boolean') return null;
  return details.ssl
    ? { summary: 'The connection to the database is encrypted.', detail: stringAt(details, 'version') ? `Protocol: ${stringAt(details, 'version')}` : null }
    : { summary: 'The connection to the database is not encrypted.', detail: null };
}

export function blobEncryptionText(status: EvidenceStatus, details: unknown): EvidenceText | null {
  if (!isRecord(details)) return null;
  const driver = stringAt(details, 'driver');
  const bucket = stringAt(details, 'bucket');
  const algorithm = stringAt(details, 'algorithm');
  const error = stringAt(details, 'error');
  if (driver && !bucket) {
    return {
      summary: 'Uploaded files are kept on the server’s own disk: encryption there is the hosting provider’s setting, which the owner confirms each quarter.',
      detail: `Storage: ${driver === 'local' ? 'server disk' : driver}`,
    };
  }
  if (!bucket) return null;
  if (status === 'PASS') return { summary: 'Uploaded files are encrypted where they’re stored.', detail: `Bucket: ${bucket}${algorithm ? ` · ${algorithm}` : ''}` };
  if (status === 'FAIL') return { summary: 'The storage bucket for uploaded files reports no default encryption.', detail: `Bucket: ${bucket}` };
  return { summary: 'The storage provider doesn’t report its encryption setting; the owner’s attestation covers it.', detail: `Bucket: ${bucket}${error ? ` · ${error}` : ''}` };
}

export function auditImmutabilityText(status: EvidenceStatus, details: unknown): EvidenceText | null {
  if (!isRecord(details)) return null;
  const probed = stringAt(details, 'probedRow');
  if (status === 'WARN' && !probed) return { summary: 'There is no audit entry yet to test.', detail: null };
  if (!probed) return null;
  return status === 'PASS'
    ? { summary: 'A test edit of the audit log was refused, as it should be.', detail: `Probed entry: ${probed}` }
    : { summary: 'A test edit of the audit log was accepted (then undone): the audit log can be changed.', detail: `The append-only trigger is missing. Probed entry: ${probed}` };
}

export function auditChainText(status: EvidenceStatus, details: unknown): EvidenceText | null {
  if (!isRecord(details)) return null;
  if (Array.isArray(details.broken)) {
    const broken = details.broken.filter(isRecord);
    return {
      summary: `The audit log of ${countOf(broken.length, 'organization')} has been changed: investigate now.`,
      detail: `Broken chains: ${broken.map((b) => String(b.tenantId ?? 'platform')).join(', ')}`,
    };
  }
  const chains = numberAt(details, 'chains');
  const rows = numberAt(details, 'rows');
  if (chains === null || rows === null || status !== 'PASS') return null;
  return {
    summary: `Every organization’s audit log is intact: ${countOf(rows, 'entry', 'entries')} checked across ${countOf(chains, 'organization')}.`,
    detail: `${countOf(chains, 'hash chain')} recomputed, ${countOf(rows, 'chained row')}.`,
  };
}

/** What each security alert rule watches for, in plain words. */
export const ALERT_RULE_LABEL: Record<string, string> = {
  FAILED_SIGNINS_IP: 'repeated failed sign-ins',
  LOCKED_ACCOUNT: 'tries on a locked account',
  MFA_OFF_ADMIN: 'two-step sign-in turned off for an administrator',
  PRIVILEGE_CHANGE: 'changes to who can do what',
  EXPORTS: 'large or sensitive data exports',
  AUDIT_CHAIN: 'changes to the audit log',
};

export function alertingText(details: unknown): EvidenceText | null {
  if (!isRecord(details) || !Array.isArray(details.rules) || typeof details.armed !== 'boolean') return null;
  const rules = details.rules.map(String);
  const alerts = numberAt(details, 'alerts') ?? 0;
  const undelivered = numberAt(details, 'undelivered') ?? 0;
  const contact = details.securityContactSet === true;
  const detail = `Rules: ${rules.join(', ')}`;
  if (!details.armed) return { summary: 'The alerts aren’t running on this server.', detail };
  if (undelivered > 0) return { summary: `${num(undelivered)} of ${countOf(alerts, 'alert')} in the last day reached no one.`, detail };
  const watching = `Watching for ${listOf(rules.map((r) => ALERT_RULE_LABEL[r] ?? r.toLowerCase().replace(/_/g, ' ')))}.`;
  const lastDay = alerts === 0 ? 'No alerts in the last day.' : alerts === 1 ? '1 alert in the last day, delivered.' : `${num(alerts)} alerts in the last day, all delivered.`;
  return { summary: `${watching} ${lastDay}${contact ? '' : ' No security contact email is set yet.'}`, detail };
}

export function accessReviewText(
  details: unknown,
  signedOff: boolean,
  labels: { account?: Record<string, string>; agent?: Record<string, string> } = {},
): EvidenceText | null {
  if (!isRecord(details)) return null;
  const elevated = numberAt(details, 'elevatedAccounts');
  const flagged = numberAt(details, 'flaggedAccounts');
  if (elevated === null || flagged === null || !Array.isArray(details.agents)) return null;
  const agents = details.agents.filter(isRecord);
  const agentFlagged = agents.filter((a) => Array.isArray(a.flags) && a.flags.length > 0).length;
  const flaggedLine =
    flagged === 0 && agentFlagged === 0
      ? 'nothing flagged'
      : `${[flagged ? countOf(flagged, 'account') : null, agentFlagged ? countOf(agentFlagged, 'agent') : null].filter(Boolean).join(' and ')} flagged`;
  const flagCounts = (raw: unknown, map: Record<string, string> | undefined) =>
    isRecord(raw)
      ? Object.entries(raw)
          .filter(([, n]) => typeof n === 'number' && n > 0)
          .map(([k, n]) => `${map?.[k] ?? k} (${num(n as number)})`)
      : [];
  const accountFlags = flagCounts(details.accountFlags, labels.account);
  const agentFlags = flagCounts(details.agentFlags, labels.agent);
  const detail = [accountFlags.length ? `Account flags: ${accountFlags.join(', ')}.` : '', agentFlags.length ? `Agent flags: ${agentFlags.join(', ')}.` : ''].filter(Boolean).join(' ') || null;
  return {
    summary: `${sentence(countOf(elevated, 'elevated account'))} and ${agents.length === 0 ? 'no AI agents' : countOf(agents.length, 'AI agent')} reviewed, ${flaggedLine}${signedOff ? '.' : '; waiting for sign-off.'}`,
    detail,
  };
}

export function uploadsBackupText(status: EvidenceStatus, summary: string, details: unknown): EvidenceText | null {
  const d = isRecord(details) ? details : {};
  if (status === 'PASS' && stringAt(d, 'key')) return { summary: 'Uploaded files were backed up.', detail: `Archive: ${stringAt(d, 'key')}` };
  if (status === 'FAIL') {
    const error = stringAt(d, 'error') ?? summary.match(/^The uploads backup failed: (.+)$/)?.[1] ?? null;
    if (error || /^The uploads backup failed/.test(summary)) return { summary: 'The uploads backup failed.', detail: error };
  }
  return null;
}

/** A collector that could not run: the plain line, with the error kept for the detail. */
export function collectionFailedText(summary: string, details: unknown): EvidenceText | null {
  const error = isRecord(details) ? stringAt(details, 'error') : null;
  const m = summary.match(/^(.+?) could not be (?:collected|run)(?:: (.+))?\.?$/s);
  if (!m) return null;
  return { summary: `${m[1]} could not be run.`, detail: error ?? m[2] ?? null };
}

/**
 * Every row, said plainly. `signedOff` matters only to the access review
 * (it stops "waiting for sign-off" once it is signed).
 */
export function describeEvidence(
  row: { control: string; status: EvidenceStatus; summary: string; details: unknown },
  opts: { signedOff?: boolean; accountFlagLabels?: Record<string, string>; agentFlagLabels?: Record<string, string> } = {},
): EvidenceText {
  const { control, status, summary, details } = row;
  const failedRun = collectionFailedText(summary, details);
  if (failedRun) return failedRun;
  let out: EvidenceText | null = null;
  switch (control) {
    case 'job-secrets-separated':
      out = jobSecretsText(details);
      break;
    case 'field-encryption-inventory':
      out = fieldEncryptionText(status, details);
      break;
    case 'tls-web':
      out = tlsWebText(status, details);
      break;
    case 'tls-database':
      out = tlsDatabaseText(details);
      break;
    case 'blob-encryption':
      out = blobEncryptionText(status, details);
      break;
    case 'audit-log-immutability':
      out = auditImmutabilityText(status, details);
      break;
    case 'audit-chain':
      out = auditChainText(status, details);
      break;
    case 'auth-anomaly-alerting':
    case 'privilege-change-alerting':
    case 'export-alerting':
      out = alertingText(details);
      break;
    case 'access-review':
      out = accessReviewText(details, opts.signedOff ?? false, { account: opts.accountFlagLabels, agent: opts.agentFlagLabels });
      break;
    case 'uploads-backup':
      out = uploadsBackupText(status, summary, details);
      break;
  }
  if (out) return out;
  // A local address written by an older collector is never shown.
  if (control === 'tls-web' && /not https/i.test(summary)) {
    return { summary: 'This server’s public address doesn’t use https, so there is no certificate to check (a development setup).', detail: null };
  }
  return { summary: scrubLocalAddresses(summary), detail: null };
}
