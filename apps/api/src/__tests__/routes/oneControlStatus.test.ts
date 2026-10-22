import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { COMPLIANCE_CONTROLS } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { recordEvidence, signOffEvidence } from '../../lib/evidence.js';
import { __resetTrustCacheForTests } from '../../lib/trustCenter.js';

/**
 * One status vocabulary for SOC 2 controls (F500 SH-4).
 *
 * The Trust Center said "3 / 16 controls passing", its SOC 2 block "11 / 16
 * current (3 passing)", and Compliance evidence "8 of 16 current" — with the
 * same WARN rows "Current" on one page and "Attention" on the other. Now
 * every surface reads controlStatusOf: Passing / Needs sign-off / Failing /
 * No evidence, from the one complianceEvidence reading.
 */

beforeEach(async () => {
  await truncateAll();
  __resetTrustCacheForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;

async function seed() {
  const now = new Date();
  await recordEvidence('tls-web', 'test', { status: 'PASS', summary: 'TLS 1.3, HSTS on' }); // Passing
  await recordEvidence('job-secrets-separated', 'test', { status: 'WARN', summary: '3 of 6 per-job secrets fall back' }); // Failing (warned, nobody signs it off)
  await recordEvidence('audit-chain', 'test', { status: 'FAIL', summary: 'chain broken' }); // Failing
  await prisma.complianceEvidence.create({ data: { control: 'tls-database', status: 'PASS', summary: 'old', collectedBy: 'test', collectedAt: new Date(now.getTime() - 10 * DAY) } }); // No evidence (stale)
  await recordEvidence('access-review', 'test', { status: 'WARN', summary: '2 flagged' }); // Needs sign-off
  const attestId = await recordEvidence('blob-encryption', 'test', { status: 'WARN', summary: 'volume storage: owner attests' }); // signed below → Passing
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await signOffEvidence(attestId!, hr.id, 'Attested in the console');
  return { hr };
}

describe('one status vocabulary for controls', () => {
  it('Compliance evidence, the Trust Center, its SOC 2 block and the public page give one count', async () => {
    const { hr } = await seed();
    const a = await loginAs(agent(), hr.email);

    const ev = await a.get('/admin/compliance-evidence');
    expect(ev.status).toBe(200);
    const status = (id: string) => (ev.body.controls as Array<{ id: string; status: string }>).find((c) => c.id === id)!.status;
    expect(status('tls-web')).toBe('PASSING');
    expect(status('job-secrets-separated')).toBe('FAILING');
    expect(status('audit-chain')).toBe('FAILING');
    expect(status('tls-database')).toBe('NO_EVIDENCE');
    expect(status('access-review')).toBe('NEEDS_SIGNOFF');
    expect(status('blob-encryption')).toBe('PASSING');
    const others = COMPLIANCE_CONTROLS.length - 6;
    expect(ev.body.statusCounts).toEqual({ PASSING: 2, NEEDS_SIGNOFF: 1, FAILING: 2, NO_EVIDENCE: 1 + others });

    const trust = await a.get('/trust');
    expect(trust.status).toBe(200);
    expect(trust.body.controls.passing).toBe(2);
    expect(trust.body.controls.total).toBe(COMPLIANCE_CONTROLS.length);
    expect(trust.body.controls.statusCounts).toEqual(ev.body.statusCounts);
    expect(trust.body.soc2).toMatchObject({ controlsPassing: 2, controlsCurrent: COMPLIANCE_CONTROLS.length - ev.body.statusCounts.NO_EVIDENCE });
    // Row by row, the same word — the older field derived from it.
    for (const c of trust.body.controls.items as Array<{ id: string; controlStatus: string; status: string }>) {
      expect(c.controlStatus).toBe(status(c.id));
      expect(c.status).toBe({ PASSING: 'PASS', NEEDS_SIGNOFF: 'WARN', FAILING: 'FAIL', NO_EVIDENCE: 'PENDING' }[c.controlStatus]);
    }

    __resetTrustCacheForTests();
    const pub = await request(createApp()).get('/trust/public');
    expect(pub.status).toBe(200);
    expect(pub.body.controls.passing).toBe(2);
  });
});
