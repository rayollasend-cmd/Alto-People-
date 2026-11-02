import { describe, expect, it } from 'vitest';
import { sampleTrace } from '../../lib/sentry.js';

/**
 * Which traces leave the process (Nov 2026: background database calls and
 * the relay/health/beacon traffic used up the span quota; Oct 22–25 kept
 * no API traces at all).
 */
const RATE = 0.1;
const root = (name: string, path?: string) =>
  sampleTrace({ name, attributes: path ? { 'url.path': path } : {}, inheritOrSampleWith: () => RATE });

describe('sampleTrace', () => {
  it('drops a background job’s own database trace', () => {
    expect(root('prisma:client:operation')).toBe(0);
    expect(root('prisma:client:transaction')).toBe(0);
  });

  it('drops the relay, probes, the live stream, beacons and the web app’s files', () => {
    for (const path of ['/api/ux/i/v0/e/', '/api/health/version', '/api/events/stream', '/api/telemetry/web-vitals', '/assets/main-abc.js', '/sw.js', '/manifest.webmanifest', '/favicon.ico']) {
      expect(root('GET', path), path).toBe(0);
    }
  });

  it('keeps every API request at the configured rate, with or without the /api prefix', () => {
    for (const path of ['/api/me/inbox', '/api/kiosk/punch', '/me/inbox', '/api/associates/x/photo', '/scheduling', '/api/uxperiments']) {
      expect(root('GET', path), path).toBe(RATE);
    }
  });

  it('a span inside a sampled request follows the request', () => {
    expect(sampleTrace({ name: 'prisma:client:operation', parentSampled: true, inheritOrSampleWith: () => 1 })).toBe(1);
  });
});
