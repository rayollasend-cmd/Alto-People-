import { describe, expect, it } from 'vitest';
import { errorsLabel } from '@/components/agents/AgentCards';

/** F500 G2 — one rule for an agent card's Errors: "—" when it did no tasks this week. */
describe('errorsLabel', () => {
  const card = (tasksCompleted: number, errorRatePct: number | null) =>
    ({ tasksCompleted, errorRatePct }) as unknown as Parameters<typeof errorsLabel>[0];
  it('reads "—" with no scorecard, no tasks or no rate, and the rate otherwise', () => {
    expect(errorsLabel(null as never)).toBe('—');
    expect(errorsLabel(card(0, 0))).toBe('—');
    expect(errorsLabel(card(12, null))).toBe('—');
    expect(errorsLabel(card(12, 0))).toBe('0%');
    expect(errorsLabel(card(40, 7.5))).toMatch(/^8%$/);
  });
});
