import { describe, expect, it } from 'vitest';
import { countOf, describeEvidence, listOf, scrubLocalAddresses } from '../../lib/evidenceText.js';

/**
 * F500 audit 2026-10-26, finding 4: compliance evidence said in plain words.
 * The summary carries no variable names, rule keys or local addresses and
 * gets its plurals right; the technical line is `detail`. Rows written
 * before the change (their stored summaries below are the real old ones)
 * are re-said from their details.
 */

const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

describe('the words', () => {
  it('counts and lists in English', () => {
    expect(countOf(1, 'account')).toBe('1 account');
    expect(countOf(2, 'account')).toBe('2 accounts');
    expect(countOf(1384, 'entry', 'entries')).toBe('1,384 entries');
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
    expect(scrubLocalAddresses('The public URL is not https (http://localhost:5173): nothing to check.')).toBe('The public URL is not https: nothing to check.');
  });
});

describe('each control, re-said from its details', () => {
  it('per-job secrets: services by name in the summary, variables only in the detail', () => {
    const t = describeEvidence({
      control: 'job-secrets-separated',
      status: 'WARN',
      summary: '6 of 6 per-job secrets fall back to the field-encryption key: MFA_SECRET_ENCRYPTION_KEY, KIOSK_PIN_SECRET.',
      details: { secrets: [{ job: 'mfa', variable: 'MFA_SECRET_ENCRYPTION_KEY', set: false }, { job: 'kioskPin', variable: 'KIOSK_PIN_SECRET', set: true }] },
    });
    expect(t.summary).toBe('1 of 2 protected services still shares the main encryption key: two-step sign-in.');
    expect(t.summary).not.toMatch(ENV_NAME);
    expect(t.detail).toContain('MFA_SECRET_ENCRYPTION_KEY');
  });

  it('encryption inventory: "the one encrypted value", never "All 1 encrypted values"', () => {
    const t = describeEvidence({
      control: 'field-encryption-inventory',
      status: 'PASS',
      summary: 'All 1 encrypted values decrypt under the keyring (active key 0).',
      details: { keyring: { ids: [0], active: 0 }, columns: [{ rows: 1, label: 'Kiosk clock-in numbers', unreadable: 0, unreadableAfterIncident: 0 }, { rows: 0, label: 'Contractor TINs', unreadable: 0, unreadableAfterIncident: 0 }] },
    });
    expect(t.summary).toBe('The one encrypted value can be read with the current key.');
    expect(t.detail).toBe('Active key: 0. Stored: Kiosk clock-in numbers (1).');
    const many = describeEvidence({ control: 'field-encryption-inventory', status: 'FAIL', summary: '', details: { columns: [{ rows: 40, label: 'Bank accounts', unreadable: 1, unreadableAfterIncident: 1 }] } });
    expect(many.summary).toBe('1 encrypted value written after the key change on Jun 11, 2026 can’t be read: investigate now.');
    expect(many.summary).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('the website check never shows a local address', () => {
    const old = describeEvidence({ control: 'tls-web', status: 'WARN', summary: 'The public URL is not https (http://localhost:5173): nothing to check here (development).', details: {} });
    expect(old.summary).not.toMatch(/localhost|http:/);
    expect(old.detail).toBeNull();
    const local = describeEvidence({ control: 'tls-web', status: 'WARN', summary: 'x', details: { origin: 'http://127.0.0.1:5173' } });
    expect(local.detail).toBeNull();
    const pass = describeEvidence({ control: 'tls-web', status: 'PASS', summary: 'x', details: { host: 'app.altohr.com', protocol: 'TLSv1.3', hsts: 'max-age=63072000', daysLeft: 1, validTo: 'Oct 27 00:00:00 2026 GMT' } });
    expect(pass.summary).toBe('Connections to app.altohr.com are encrypted (TLS 1.3), the certificate is good for 1 more day, and browsers are told to always use https.');
    const fail = describeEvidence({ control: 'tls-web', status: 'FAIL', summary: 'x', details: { host: 'app.altohr.com', protocol: 'TLSv1.3', hsts: null, daysLeft: 5 } });
    expect(fail.summary).toBe('Connections to app.altohr.com need attention: the certificate expires in 5 days and browsers aren’t told to always use https.');
  });

  it('alerting: rules by what they watch, never their keys; no "0 alerts…all delivered"', () => {
    const t = describeEvidence({
      control: 'auth-anomaly-alerting',
      status: 'WARN',
      summary: 'Rules armed (failed_signins_ip, locked_account, mfa_off_admin); 0 alerts in the last day, all delivered; no security contact email set yet.',
      details: { armed: true, rules: ['FAILED_SIGNINS_IP', 'LOCKED_ACCOUNT', 'MFA_OFF_ADMIN'], alerts: 0, undelivered: 0, securityContactSet: false },
    });
    expect(t.summary).toBe(
      'Watching for repeated failed sign-ins, tries on a locked account and two-step sign-in turned off for an administrator. No alerts in the last day. No security contact email is set yet.',
    );
    expect(t.summary).not.toMatch(/failed_signins_ip|mfa_off_admin|_/);
    expect(t.detail).toBe('Rules: FAILED_SIGNINS_IP, LOCKED_ACCOUNT, MFA_OFF_ADMIN');
    const one = describeEvidence({ control: 'export-alerting', status: 'PASS', summary: '', details: { armed: true, rules: ['EXPORTS'], alerts: 1, undelivered: 0, securityContactSet: true } });
    expect(one.summary).toBe('Watching for large or sensitive data exports. 1 alert in the last day, delivered.');
  });

  it('the access review and the audit chain get their plurals right', () => {
    const review = describeEvidence(
      {
        control: 'access-review',
        status: 'WARN',
        summary: '10 elevated accounts (1 flagged accounts in all) and 5 agents (4 flagged): waiting for sign-off.',
        details: { elevatedAccounts: 10, flaggedAccounts: 1, accountFlags: { NO_SIGN_IN_90D: 1 }, agents: [{ flags: ['IDLE_90D'] }, { flags: [] }], agentFlags: { IDLE_90D: 1 } },
      },
      { accountFlagLabels: { NO_SIGN_IN_90D: 'No sign-in in 90 days' } },
    );
    expect(review.summary).toBe('10 elevated accounts and 2 AI agents reviewed, 1 account and 1 agent flagged; waiting for sign-off.');
    expect(review.detail).toBe('Account flags: No sign-in in 90 days (1). Agent flags: IDLE_90D (1).');
    const signed = describeEvidence({ control: 'access-review', status: 'WARN', summary: '', details: { elevatedAccounts: 1, flaggedAccounts: 0, agents: [] } }, { signedOff: true });
    expect(signed.summary).toBe('1 elevated account and no AI agents reviewed, nothing flagged.');

    const chain = describeEvidence({ control: 'audit-chain', status: 'PASS', summary: "Every tenant's audit hash chain verifies (1384 chained rows across 1 chains).", details: { rows: 1384, chains: 1 } });
    expect(chain.summary).toBe('Every organization’s audit log is intact: 1,384 entries checked across 1 organization.');
  });

  it('a check that could not run keeps its error for the detail', () => {
    const t = describeEvidence({ control: 'tls-database', status: 'FAIL', summary: 'The database TLS check could not be collected: connect ECONNREFUSED 127.0.0.1:5432', details: {} });
    expect(t.summary).toBe('The database TLS check could not be run.');
    expect(t.detail).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    const backup = describeEvidence({ control: 'uploads-backup', status: 'FAIL', summary: 'The uploads backup failed: AccessDenied', details: {} });
    expect(backup).toEqual({ summary: 'The uploads backup failed.', detail: 'AccessDenied' });
  });

  it('a row without the expected details keeps its own words', () => {
    expect(describeEvidence({ control: 'restore-test', status: 'PASS', summary: 'Restored 42 tables; counts match.', details: {} })).toEqual({ summary: 'Restored 42 tables; counts match.', detail: null });
    expect(describeEvidence({ control: 'tls-web', status: 'PASS', summary: 'TLS 1.3, HSTS on', details: {} }).summary).toBe('TLS 1.3, HSTS on');
  });
});
