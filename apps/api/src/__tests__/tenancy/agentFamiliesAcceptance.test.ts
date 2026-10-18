import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '@alto-people/shared';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { chaseMessage } from '../../lib/complianceAgent.js';
import { credentialAsk } from '../../lib/credentialCoverage.js';
import { mcpCatalogFor } from '../../lib/mcpCatalog.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile, loadTenantProfile, setTenantProfile } from '../../lib/tenantProfile.js';
import { WA_REPLY } from '../../lib/whatsappContent.js';

/**
 * Agent families step 6 — the parts of acceptance that can be proven in
 * code (docs/agent-families-investigation.md §7): the MCP catalog (Brief
 * 2-7) generated from the capability catalog as a read-only preview, and
 * the hotel tenant clean of the staffing company's words in everything the
 * two agents write to people. The rest of acceptance is a week of both
 * agents live in production with their scorecards.
 */

const FORBIDDEN = /\b(clients?|bill rates?|housing|vans?|stores?|associates?|alto)\b/i;
const exempt = (s: string) => s.replace(/Alto People/g, '');

beforeEach(async () => {
  await truncateAll();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

describe('the MCP catalog, read-only preview', () => {
  it('one tool per offered capability: a gated one proposes and returns an approval id, a read is read-only', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const res = await (await loginAs(agent(), hr.email)).get('/agents/mcp-catalog');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.preview).toBe(true);
    const tools = res.body.tools as Array<{ name: string; effect: string; gate: string | null; annotations: { readOnlyHint: boolean }; inputSchema: { required?: string[] }; description: string }>;
    expect(tools.map((t) => t.name)).toEqual(AGENT_CAPABILITIES.map((c) => c.key.replace(/\./g, '_')));
    const fill = tools.find((t) => t.name === 'shift_fill')!;
    expect(fill).toMatchObject({ effect: 'propose', gate: 'SHIFT_ASSIGN', annotations: { readOnlyHint: false } });
    expect(fill.inputSchema.required).toEqual(['subjectType', 'subjectId', 'summary']);
    expect(fill.description).toMatch(/returns its id; nothing happens until a person approves\.$/);
    expect(tools.find((t) => t.name === 'coverage_forecast')).toMatchObject({ effect: 'read', annotations: { readOnlyHint: true } });
    expect(tools.find((t) => t.name === 'document_chase')).toMatchObject({ effect: 'notify', gate: null });
    // An associate has no Agents page.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), assoc.email)).get('/agents/mcp-catalog')).status).toBe(403);
  });

  it('a module off takes its capabilities out of the catalog, never a refusal', () => {
    const tools = mcpCatalogFor({ scheduling: true, time: true, hrCases: false, compliance: false } as Parameters<typeof mcpCatalogFor>[0]);
    // Payroll is core: payroll.prep stays whatever modules are off.
    expect(tools.map((t) => t.family)).toEqual(['workforce', 'workforce', 'workforce', 'workforce', 'payroll']);
    expect(mcpCatalogFor(null)).toEqual([]);
  });
});

describe('the hotel tenant: nothing the agents write to people names a client, store, van or Alto', () => {
  it('in English, Spanish and Turkish', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(agent(), hr.email);
    try {
      expect((await admin.patch('/admin/org/settings').send({ orgName: 'The Grand Hotel' })).status).toBe(200);
      await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true }, hr.id);
      invalidateTenantProfile();
      const profile = await loadTenantProfile(ALTO_TENANT_ID);
      const items = [
        { wordKey: 'ID', expiresAt: new Date('2026-11-02T00:00:00Z') },
        { wordKey: 'I9_WORK_AUTH', expiresAt: new Date('2026-11-03T00:00:00Z') },
        { wordKey: 'VACCINATION', expiresAt: new Date('2026-11-04T00:00:00Z') },
      ];
      for (const lang of ['en', 'es', 'tr'] as const) {
        const said = [
          ...Object.values(chaseMessage(lang, items)),
          ...Object.values(chaseMessage(lang, items.slice(0, 1))),
          ...['VACCINATION', 'TRAINING', 'QUALIFICATION'].flatMap((k) => Object.values(credentialAsk(lang, 'TB test', 'The Grand Hotel', k))),
          WA_REPLY.noRenewals(lang),
          WA_REPLY.confirmedYes(lang, 'Housekeeper, Thu 8:00 AM'),
          WA_REPLY.confirmedNo(lang, 'Housekeeper, Thu 8:00 AM'),
          WA_REPLY.coverageAllCovered(lang, 'properties'),
          WA_REPLY.coverageNoTargets(lang, 'properties'),
          WA_REPLY.coverageShort(lang, 2, 1, 'properties', [WA_REPLY.coverageLine(lang, 'The Grand Hotel', 'Thu, Oct 16', 2, 3)]),
          WA_REPLY.deskNothing(lang),
          WA_REPLY.deskWaiting(lang, 1, ['• Give the shift to Tess Free.']),
        ];
        for (const line of said) expect(exempt(line), `${lang}: ${line}`).not.toMatch(FORBIDDEN);
      }
      // The catalog the hotel would expose names none of them either.
      for (const t of mcpCatalogFor(profile.modules)) expect(exempt(`${t.title} ${t.description}`), t.name).not.toMatch(FORBIDDEN);
    } finally {
      await setTenantProfile(ALTO_TENANT_ID, { businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }, hr.id);
      await admin.patch('/admin/org/settings').send({ orgName: 'Alto HR' });
      invalidateTenantProfile();
    }
  });
});
