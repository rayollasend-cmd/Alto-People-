import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One step of a goal on the shared model loop (lib/hugoGoalModel): what the
 * model is told, that it is charged to the goal's owner as a goal, and that a
 * step is bounded — a budget of tool calls and a deadline.
 */

const loop = vi.fn();
vi.mock('../../lib/assistantModel.js', () => ({ runModelLoop: (input: unknown) => loop(input) }));

const { goalStableSystem, runGoalStep } = await import('../../lib/hugoGoalModel.js');

const identity = {
  name: 'Hugo',
  product: 'Alto People',
  audience: 'associate' as const,
  roleLabel: 'Associate',
  lang: 'es',
  terms: { worker: 'asociado', workers: 'asociados', site: 'tienda', sites: 'tiendas', manager: 'supervisor', managers: 'supervisores' },
};
const base = {
  userId: '11111111-1111-4111-8111-111111111111',
  identity,
  goal: 'Consígueme 40 horas la próxima semana',
  plan: [
    { text: 'Buscar turnos', state: 'done' as const },
    { text: 'Pedir el mejor', state: 'doing' as const },
  ],
  trail: ['2026-10-28 16:00 UTC — You proposed: Ask for the open Stocker shift'],
  children: ['WATCH_OPEN_SHIFTS [WAITING] (task x)'],
  why: 'Your scheduled check-in.',
  startedAt: new Date('2026-10-26T16:00:00Z'),
  expiresAt: new Date('2026-11-09T16:00:00Z'),
  steps: { used: 3, max: 12 },
  now: new Date('2026-10-28T16:00:00Z'),
};

beforeEach(() => {
  loop.mockReset();
});

describe('a goal step', () => {
  it('tells the model who, in which language, the goal, the plan, the trail, what it started and what they told Hugo before', async () => {
    loop.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
    await runGoalStep({ ...base, memory: ['Prefiere turnos de mañana'], tools: [], tier: 'fast' });
    const input = loop.mock.calls[0]![0] as { tier: string; system: string[]; meter: unknown; messages: unknown[]; live: { signal: AbortSignal }; maxTokens: number };
    expect(input.tier).toBe('fast');
    expect(input.meter).toEqual({ userId: base.userId, purpose: 'goal' });
    // The stable half is the organization's, cacheable: no goal, no person in it.
    expect(input.system[0]).toBe(goalStableSystem(identity));
    expect(input.system[0]).not.toContain('40 horas');
    expect(input.system[0]).toContain('never a person');
    expect(input.system[0]).toContain('propose');
    const live = input.system[1]!;
    expect(live).toContain('"es"');
    expect(live).toContain('Consígueme 40 horas la próxima semana');
    expect(live).toContain('1. [done] Buscar turnos');
    expect(live).toContain('2. [doing] Pedir el mejor');
    expect(live).toContain('You proposed: Ask for the open Stocker shift');
    expect(live).toContain('WATCH_OPEN_SHIFTS [WAITING]');
    expect(live).toContain('Steps used: 3 of 12');
    expect(live).toContain('Prefiere turnos de mañana');
    expect(live).toContain('Today is 2026-10-28');
    expect(input.live.signal).toBeInstanceOf(AbortSignal);
  });

  it('no memory, no memory line; planning thinks longer', async () => {
    loop.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
    await runGoalStep({ ...base, plan: [], tools: [], tier: 'deep' });
    const input = loop.mock.calls[0]![0] as { system: string[]; maxTokens: number; tier: string };
    expect(input.system[1]).not.toContain('told you before');
    expect(input.system[1]).toContain('There is no plan yet');
    expect(input.tier).toBe('deep');
    expect(input.maxTokens).toBeGreaterThan(1000);
  });

  it('a step has a budget of tool calls: past it, every tool says stop', async () => {
    const run = vi.fn(async () => ({ reply: 'ok', linkUrl: null }));
    loop.mockImplementation(async (input: { tools: Array<{ name: string; run: (a: unknown) => Promise<string> }> }) => {
      const t = input.tools[0]!;
      const replies: string[] = [];
      for (let i = 0; i < 4; i++) replies.push(await t.run({}));
      return { content: [{ type: 'text', text: replies.join('|') }], stop_reason: 'end_turn' };
    });
    const out = await runGoalStep({ ...base, tools: [{ key: 'SCHEDULE', name: 'my_next_shifts', description: 'shifts', run }], tier: 'fast', maxToolCalls: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(out.toolsUsed).toEqual(['SCHEDULE', 'SCHEDULE']);
    const replies = (loop.mock.results[0]!.value as Promise<{ content: Array<{ text: string }> }>).then((m) => m.content[0]!.text.split('|'));
    expect((await replies).slice(2)).toEqual([expect.stringContaining('used all its tool calls'), expect.stringContaining('used all its tool calls')]);
  });

  it('a step past its deadline is stopped', async () => {
    loop.mockImplementation(
      (input: { live: { signal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          input.live.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(runGoalStep({ ...base, tools: [], tier: 'fast', deadlineMs: 20 })).rejects.toThrow('aborted');
  });
});
