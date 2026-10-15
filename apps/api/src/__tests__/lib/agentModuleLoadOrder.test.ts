import { describe, expect, it, vi } from 'vitest';

/**
 * Agent families: every capability module registers itself when it loads
 * (registerApprovedHandler / registerCapabilityRunner), and they import one
 * another. An import cycle among them is invisible to tsc, lint and the
 * server's own boot order, and crashed shiftAutofill.test.ts in CI
 * ("No capability undefined in the catalog", 2026-10-15) because that file
 * loaded them in another order.
 *
 * Here each one loads FIRST, in a fresh module graph, as some test file or
 * future import might load it. A cycle that reaches a constant before it is
 * initialized fails this test by name instead of failing a whole file.
 */

const ENTRIES: Record<string, () => Promise<unknown>> = {
  workforceAgent: () => import('../../lib/workforceAgent.js'),
  scheduleRepair: () => import('../../lib/scheduleRepair.js'),
  attendanceConfirm: () => import('../../lib/attendanceConfirm.js'),
  coverageForecast: () => import('../../lib/coverageForecast.js'),
  complianceAgent: () => import('../../lib/complianceAgent.js'),
  incidentLoop: () => import('../../lib/incidentLoop.js'),
  credentialCoverage: () => import('../../lib/credentialCoverage.js'),
  agentCapabilities: () => import('../../lib/agentCapabilities.js'),
  agentControls: () => import('../../lib/agentControls.js'),
  agents: () => import('../../lib/agents.js'),
  whatsappAssistant: () => import('../../lib/whatsappAssistant.js'),
  roleDecisions: () => import('../../lib/roleDecisions.js'),
  shiftAutofill: () => import('../../lib/shiftAutofill.js'),
  relayBoard: () => import('../../lib/relayBoard.js'),
  expirationDigest: () => import('../../lib/expirationDigest.js'),
  hugoRoute: () => import('../../routes/hugo.js'),
  // Brief 2-4: the public API and the webhook events reach into the same domain modules.
  webhookEvents: () => import('../../lib/webhookEvents.js'),
  webhookSecrets: () => import('../../lib/webhookSecrets.js'),
  shiftCreate: () => import('../../lib/shiftCreate.js'),
  shiftAssign: () => import('../../lib/shiftAssign.js'),
  apiClients: () => import('../../lib/apiClients.js'),
  v1Route: () => import('../../routes/v1.js'),
  apiClientsRoute: () => import('../../routes/apiClients.js'),
};

describe('agent modules load in any order', () => {
  for (const [name, load] of Object.entries(ENTRIES)) {
    it(`${name} loads first, in a fresh module graph`, async () => {
      vi.resetModules();
      await expect(load()).resolves.toBeTruthy();
    });
  }
});
