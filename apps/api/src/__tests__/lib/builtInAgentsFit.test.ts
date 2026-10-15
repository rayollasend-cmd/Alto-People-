import { describe, expect, it } from 'vitest';
import { BUILT_IN_AGENTS } from '../../lib/agents.js';

/**
 * The built-in agents are written at boot into columns with limits
 * (Worker.name 160, AgentProfile.capability 120, purpose 500, builtInKey 60).
 * A text one character too long failed every test that boots them, and
 * would fail the boot sweep in production (2026-10-15, the Compliance
 * agent's capability at 132). Checked here without a database.
 */
describe('built-in agents fit their columns', () => {
  for (const b of BUILT_IN_AGENTS) {
    it(b.key, () => {
      expect(b.key.length).toBeLessThanOrEqual(60);
      expect(b.name.length).toBeLessThanOrEqual(160);
      expect(b.capability.length).toBeLessThanOrEqual(120);
      expect(b.purpose.length).toBeLessThanOrEqual(500);
    });
  }
});
