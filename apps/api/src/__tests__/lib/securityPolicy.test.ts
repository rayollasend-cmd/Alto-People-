import { describe, expect, it } from 'vitest';
import { NO_POLICY, allowedCidrsFor, ipAllowed, ipInCidr, isValidCidr, roleClassOf, sessionExpiry } from '../../lib/securityPolicy.js';
import { deferralFor, inQuietHours, localMinutes, mustGoNow } from '../../lib/notificationDelivery.js';

/**
 * Access pack — the pure parts: CIDR matching, the session-life rule from
 * token claims, and when a notification waits (quiet hours, digest) and
 * when it never does.
 */

describe('CIDR allowlists', () => {
  it('matches v4 ranges, exact addresses, and v4-mapped v6 addresses', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('203.0.113.7', '203.0.113.7')).toBe(true);
    expect(ipInCidr('203.0.113.8', '203.0.113.7')).toBe(false);
    expect(ipInCidr('::ffff:127.0.0.1', '127.0.0.1/32')).toBe(true);
    expect(ipInCidr('192.168.1.77', '192.168.0.0/16')).toBe(true);
  });

  it('matches v6 ranges', () => {
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('::1', '::1/128')).toBe(true);
  });

  it('validates what the editor accepts', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('2001:db8::/64')).toBe(true);
    expect(isValidCidr('office')).toBe(false);
    expect(isValidCidr('999.1.1.1')).toBe(false);
  });

  it('an empty list is anywhere; a list without the address is a refusal; no address is a refusal', () => {
    expect(ipAllowed('1.2.3.4', [])).toBe(true);
    expect(ipAllowed('1.2.3.4', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed(undefined, ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('10.9.9.9', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true);
  });

  it('each role answers to its class', () => {
    expect(roleClassOf('ASSOCIATE')).toBe('associate');
    expect(roleClassOf('CLIENT_PORTAL')).toBe('client');
    expect(roleClassOf('HR_ADMINISTRATOR')).toBe('internal');
    const p = { ...NO_POLICY, allowedCidrsClient: ['10.0.0.0/8'] };
    expect(allowedCidrsFor(p, 'CLIENT_PORTAL')).toEqual(['10.0.0.0/8']);
    expect(allowedCidrsFor(p, 'MANAGER')).toEqual([]);
  });
});

describe('session life', () => {
  const now = 1_000_000;
  it('no policy: the token lives its own life', () => {
    expect(sessionExpiry(NO_POLICY, { iat: now - 10 * 86400 }, now)).toBeNull();
  });
  it('idle: measured from the last re-issue, not the start', () => {
    const p = { ...NO_POLICY, sessionIdleMinutes: 15 };
    expect(sessionExpiry(p, { iat: now - 3600, lat: now - 60 }, now)).toBeNull();
    expect(sessionExpiry(p, { iat: now - 3600, lat: now - 16 * 60 }, now)).toBe('idle');
    expect(sessionExpiry(p, { iat: now - 16 * 60 }, now)).toBe('idle');
  });
  it('absolute: measured from the start, whatever the activity', () => {
    const p = { ...NO_POLICY, sessionAbsoluteHours: 8 };
    expect(sessionExpiry(p, { iat: now - 7 * 3600, lat: now }, now)).toBeNull();
    expect(sessionExpiry(p, { iat: now - 9 * 3600, lat: now }, now)).toBe('absolute');
  });
});

describe('when a notification waits', () => {
  const base = { quietHoursStart: null, quietHoursEnd: null, deliveryEmail: 'REALTIME' as const, deliveryPush: 'REALTIME' as const, deliverySms: 'REALTIME' as const, timezone: 'UTC' };
  const at = new Date('2026-10-17T23:30:00Z');

  it('reads local minutes and wraps quiet hours across midnight', () => {
    expect(localMinutes(at, 'UTC')).toBe(23 * 60 + 30);
    expect(inQuietHours(23 * 60 + 30, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(inQuietHours(9 * 60, 8 * 60, 17 * 60)).toBe(true);
    expect(inQuietHours(9 * 60, null, null)).toBe(false);
  });

  it('quiet hours hold a routine message until they end', () => {
    const d = deferralFor({ ...base, quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60 }, 'EMAIL', { category: 'schedule_published' }, at);
    expect(d?.reason).toBe('QUIET_HOURS');
    expect(d?.dueAt.toISOString()).toBe('2026-10-18T07:00:00.000Z');
  });

  it('a digest channel waits for the top of the hour; a real-time channel does not', () => {
    const d = deferralFor({ ...base, deliveryEmail: 'DIGEST' }, 'EMAIL', { category: 'schedule_published' }, at);
    expect(d).toEqual({ reason: 'DIGEST', dueAt: new Date('2026-10-18T00:00:00Z') });
    expect(deferralFor({ ...base, deliveryEmail: 'DIGEST' }, 'PUSH', { category: 'schedule_published' }, at)).toBeNull();
  });

  it('what cannot wait goes now: security, mandatory notices, safety, pay, or urgent', () => {
    const quiet = { ...base, quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60, deliveryEmail: 'DIGEST' as const };
    expect(mustGoNow({ category: 'security_alert' })).toBe(true);
    expect(mustGoNow({ category: 'payroll_failed' })).toBe(true);
    expect(mustGoNow({ category: 'safety_incident' })).toBe(true);
    expect(mustGoNow({ category: 'schedule_published', urgent: true })).toBe(true);
    expect(mustGoNow({ category: 'schedule_published' })).toBe(false);
    expect(deferralFor(quiet, 'EMAIL', { category: 'security_alert' }, at)).toBeNull();
    expect(deferralFor(quiet, 'EMAIL', { category: 'schedule_published', urgent: true }, at)).toBeNull();
  });
});
