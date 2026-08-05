import { describe, expect, it } from 'vitest';
import { STATUS_TONES, statusLabel, statusTone } from '@/lib/status';

describe('statusTone — canonical vocabulary', () => {
  it('reads healthy / terminal-good states as success', () => {
    for (const s of [
      'ACTIVE',
      'APPROVED',
      'MANAGER_APPROVED',
      'VERIFIED',
      'COMPLETED',
      'COMPLETE',
      'PAID',
      'DISBURSED',
      'PASSED',
      'RESOLVED',
      'PUBLISHED',
      'HIRED',
      'ASSIGNED',
      'SENT',
      'DELIVERED',
    ]) {
      expect(statusTone(s), s).toBe('success');
    }
  });

  it('reads waiting / churning states as pending (amber)', () => {
    for (const s of [
      'PENDING',
      'PENDING_REVIEW',
      'UPLOADED',
      'IN_PROGRESS',
      'PROCESSING',
      'RETRYING',
      'SUBMITTED',
      'IN_REVIEW',
      'HELD',
      'SUSPENDED',
    ]) {
      expect(statusTone(s), s).toBe('pending');
    }
  });

  it('reads not-started states as neutral default', () => {
    for (const s of ['DRAFT', 'INVITED', 'PROSPECT']) {
      expect(statusTone(s), s).toBe('default');
    }
  });

  it('reads terminal-bad states as destructive', () => {
    for (const s of ['REJECTED', 'DENIED', 'DECLINED', 'FAILED', 'EXPIRED', 'BOUNCED']) {
      expect(statusTone(s), s).toBe('destructive');
    }
  });

  it('reads deliberately-ended states as muted outline, never red', () => {
    for (const s of [
      'CANCELLED',
      'VOID',
      'VOIDED',
      'DISABLED',
      'TERMINATED',
      'SEPARATED',
      'INACTIVE',
      'ARCHIVED',
      'CLOSED',
      'WITHDRAWN',
    ]) {
      expect(statusTone(s), s).toBe('outline');
    }
  });

  it('reads actionable spotlight states as accent and scheduled/on-leave as info', () => {
    expect(statusTone('OPEN')).toBe('accent');
    expect(statusTone('INVESTIGATING')).toBe('accent');
    expect(statusTone('SCHEDULED')).toBe('info');
    expect(statusTone('ON_LEAVE')).toBe('info');
  });

  it('is case-insensitive (integrations uses lowercase codes)', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('expired')).toBe('destructive');
  });

  it('falls back to default for unknown codes', () => {
    expect(statusTone('SOME_NEW_CODE')).toBe('default');
    expect(statusTone('')).toBe('default');
  });

  it('every mapped tone is a real Badge variant', () => {
    const variants = new Set(['default', 'success', 'pending', 'destructive', 'accent', 'info', 'outline']);
    for (const [code, tone] of Object.entries(STATUS_TONES)) {
      expect(variants.has(tone), `${code} -> ${tone}`).toBe(true);
    }
  });
});

describe('statusTone — per-call overrides', () => {
  it('lets a domain override a shared code (discipline: ACTIVE case is a warning)', () => {
    expect(statusTone('ACTIVE', { overrides: { ACTIVE: 'pending' } })).toBe('pending');
    // Other codes are untouched by the override map.
    expect(statusTone('ACKNOWLEDGED', { overrides: { ACTIVE: 'pending' } })).toBe('success');
  });

  it('lets a domain define codes the vocabulary does not carry', () => {
    expect(statusTone('SETTLED', { overrides: { SETTLED: 'accent' } })).toBe('accent');
    // Without the override the unknown code falls back to default.
    expect(statusTone('SETTLED')).toBe('default');
  });

  it('matches overrides case-insensitively too', () => {
    expect(statusTone('revoked', { overrides: { REVOKED: 'destructive' } })).toBe('destructive');
  });
});

describe('statusLabel', () => {
  it('humanizes known and unknown codes to sentence case', () => {
    expect(statusLabel('ACTIVE')).toBe('Active');
    expect(statusLabel('PENDING_REVIEW')).toBe('Pending review');
    expect(statusLabel('MANAGER_APPROVED')).toBe('Manager approved');
    expect(statusLabel('IN_PROGRESS')).toBe('In progress');
    // Unknown code — still a readable fallback, never raw SCREAMING_CASE.
    expect(statusLabel('SOME_NEW_CODE')).toBe('Some new code');
  });

  it('honors per-call label overrides (documents: UPLOADED reads "Awaiting review")', () => {
    expect(statusLabel('UPLOADED', { overrides: { UPLOADED: 'Awaiting review' } })).toBe(
      'Awaiting review',
    );
    expect(statusLabel('VERIFIED', { overrides: { UPLOADED: 'Awaiting review' } })).toBe('Verified');
  });

  it('returns the input unchanged when there is nothing to humanize', () => {
    expect(statusLabel('')).toBe('');
  });
});
