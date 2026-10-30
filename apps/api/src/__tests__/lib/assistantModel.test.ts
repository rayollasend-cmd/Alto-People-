import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model engine, with the SDK stubbed: what it is told, what it may
 * call, and what comes back. The real model is never called in tests.
 */

const toolRunner = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = { messages: { toolRunner } };
  }
  return { default: Anthropic };
});
vi.mock('../../config/env.js', () => ({
  env: { Hugo: 'test-key', ASSISTANT_BASE_URL: 'https://api.deepseek.com/anthropic', ASSISTANT_MODEL: 'deepseek-v4-pro', ASSISTANT_FAST_MODEL: 'deepseek-flash' },
}));
// The allowance is tested on its own (hugoAllowance.test.ts): here it always has room, and charges are recorded.
const charged = vi.hoisted(() => [] as Array<{ meter: unknown; usage: unknown }>);
vi.mock('../../lib/hugoAllowance.js', () => ({
  assertAllowance: vi.fn(async () => ({ exhausted: false })),
  chargeModelCall: vi.fn(async (meter: unknown, usage: unknown) => {
    charged.push({ meter, usage });
    return 0;
  }),
}));

const { answerWithModel, modelAvailable } = await import('../../lib/assistantModel.js');
const meter = { userId: 'u-1', purpose: 'chat' as const };

const identity = {
  name: 'Hugo',
  product: 'Alto People',
  audience: 'manager' as const,
  roleLabel: 'Shift Supervisor',
  lang: 'es',
  terms: { worker: 'asociado', workers: 'asociados', site: 'tienda', sites: 'tiendas', manager: 'supervisor', managers: 'supervisores' },
  escalation: null,
};

beforeEach(() => {
  toolRunner.mockReset();
});

describe('answerWithModel', () => {
  it('is on only with a key', () => {
    expect(modelAvailable()).toBe(true);
  });

  it('tells the model who is asking, where they are, and which record the page shows; the tools are the registry answers', async () => {
    toolRunner.mockImplementation(async (params: { tools: Array<{ name: string; run: () => Promise<string> }> }) => {
      // The model "calls" the desk tool, then answers.
      const desk = params.tools.find((t) => t.name === 'whats_waiting_on_my_desk')!;
      const result = await desk.run();
      return { content: [{ type: 'text', text: `Tienes esto: ${result}` }], stop_reason: 'end_turn' };
    });
    const out = await answerWithModel({
      text: '¿Qué me espera?',
      history: [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'hola' }],
      page: { path: '/people/abc', title: 'Ana Lopez', record: { type: 'asociado', id: 'abc', name: 'Ana Lopez' } },
      tools: [{ key: 'DESK', name: 'whats_waiting_on_my_desk', description: 'desk', run: async () => ({ reply: '2 propuestas', linkUrl: '/approvals' }) }],
      identity,
      now: new Date('2026-10-17T12:00:00Z'),
      meter,
    });
    expect(out.reply).toBe('Tienes esto: 2 propuestas');
    expect(out.linkUrl).toBe('/approvals');
    expect(out.toolsUsed).toEqual(['DESK']);
    expect(out.handoff).toBeNull();

    const params = toolRunner.mock.calls[0]![0] as { model: string; system: Array<{ text: string; cache_control?: unknown }>; messages: Array<{ role: string; content: string }>; tools: Array<{ name: string }> };
    expect(params.model).toBe('deepseek-v4-pro');
    const system = params.system.map((s) => s.text).join('\n');
    expect(system).toContain('You are Hugo');
    expect(system).toContain('never a person');
    expect(system).toContain('Shift Supervisor');
    expect(system).toContain('"es"');
    expect(system).toContain('Ana Lopez');
    expect(system).toContain('/people/abc');
    expect(system).toContain('asociados');
    // The stable half is cached; the live half (page, date) is not.
    expect(params.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.system[1]!.cache_control).toBeUndefined();
    expect(params.tools.map((t) => t.name)).toEqual(['whats_waiting_on_my_desk']);
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(params.messages[2]!.content).toBe('¿Qué me espera?');
  });

  it('offers a hand-off for an associate and records it without sending', async () => {
    toolRunner.mockImplementation(async (params: { tools: Array<{ name: string; run: (a: unknown) => Promise<string> }> }) => {
      const esc = params.tools.find((t) => t.name === 'escalate_to_person')!;
      const note = await esc.run({ summary: 'Needs a new badge' });
      expect(note).toContain('nothing has been sent');
      return { content: [{ type: 'text', text: 'I can pass that to Dana if you like.' }], stop_reason: 'end_turn' };
    });
    const out = await answerWithModel({
      text: 'my badge broke',
      history: [],
      page: null,
      tools: [],
      identity: { ...identity, audience: 'associate', escalation: { who: 'Dana Reyes' } },
      now: new Date(),
      meter,
    });
    expect(out.handoff).toEqual({ summary: 'Needs a new badge', who: 'Dana Reyes' });
    expect(out.reply).toContain('Dana');
  });

  it('has no escalation tool for staff', async () => {
    toolRunner.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    await answerWithModel({ text: 'hi', history: [], page: null, tools: [], identity, now: new Date(), meter });
    const params = toolRunner.mock.calls[0]![0] as { tools: Array<{ name: string }> };
    expect(params.tools.map((t) => t.name)).not.toContain('escalate_to_person');
  });

  it('the quick model answers everyday questions straight off — no thinking, a shorter answer', async () => {
    toolRunner.mockResolvedValue({ content: [{ type: 'text', text: 'Tomorrow 6–2.' }], stop_reason: 'end_turn' });
    await answerWithModel({ text: 'when do I work?', history: [], page: null, tools: [], identity, now: new Date(), tier: 'fast', meter });
    const fast = toolRunner.mock.calls[0]![0] as { model: string; thinking?: unknown; output_config?: unknown; max_tokens: number };
    expect(fast.model).toBe('deepseek-flash');
    expect(fast.thinking).toBeUndefined();
    expect(fast.output_config).toBeUndefined();
    await answerWithModel({ text: 'approve it', history: [], page: null, tools: [], identity, now: new Date(), tier: 'deep', meter });
    const deep = toolRunner.mock.calls[1]![0] as { model: string; thinking?: unknown; max_tokens: number };
    expect(deep.model).toBe('deepseek-v4-pro');
    expect(deep.thinking).toEqual({ type: 'adaptive' });
    expect(deep.max_tokens).toBeGreaterThan(fast.max_tokens);
  });

  it('live: says each step, streams the words, drops a lead-in that ended in a tool call, and returns the last turn', async () => {
    // Two turns, as the SDK's streaming runner gives them: "let me check" + a tool call, then the answer.
    toolRunner.mockImplementation((params: { stream?: boolean; tools: Array<{ name: string; run: () => Promise<string> }> }) => {
      expect(params.stream).toBe(true);
      const turn = (words: string[], stop: string) => {
        const listeners: Array<(d: string) => void> = [];
        return {
          on: (event: string, cb: (d: string) => void) => event === 'text' && listeners.push(cb),
          finalMessage: async () => {
            for (const w of words) listeners.forEach((l) => l(w));
            return { content: [{ type: 'text', text: words.join('') }], stop_reason: stop };
          },
        };
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield turn(['Let me ', 'check.'], 'tool_use');
          await params.tools.find((t) => t.name === 'my_next_shifts')!.run();
          yield turn(['Tomorrow ', '6–2.'], 'end_turn');
        },
      };
    });
    const events: string[] = [];
    const out = await answerWithModel({
      text: 'when do I work?',
      history: [],
      page: null,
      tools: [{ key: 'SCHEDULE', name: 'my_next_shifts', description: 'shifts', run: async () => ({ reply: 'Fri 6–2', linkUrl: '/scheduling' }) }],
      identity,
      now: new Date(),
      tier: 'fast',
      meter,
      live: { onTool: (k) => events.push(`tool:${k}`), onText: (d) => events.push(`text:${d}`), onClear: () => events.push('clear') },
    });
    expect(events).toEqual(['text:Let me ', 'text:check.', 'clear', 'tool:SCHEDULE', 'text:Tomorrow ', 'text:6–2.']);
    expect(out.reply).toBe('Tomorrow 6–2.');
    expect(out.linkUrl).toBe('/scheduling');
    expect(out.toolsUsed).toEqual(['SCHEDULE']);
  });

  it('charges every turn of the loop to the person it was for — not only the last', async () => {
    charged.length = 0;
    toolRunner.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { content: [], stop_reason: 'tool_use', usage: { input_tokens: 300, cache_read_input_tokens: 1000, output_tokens: 40 } };
        yield { content: [{ type: 'text', text: 'Tomorrow 6–2.' }], stop_reason: 'end_turn', usage: { input_tokens: 120, cache_read_input_tokens: 1100, output_tokens: 30 } };
      },
    }));
    const out = await answerWithModel({ text: 'when do I work?', history: [], page: null, tools: [], identity, now: new Date(), tier: 'fast', meter: { userId: 'u-9', purpose: 'chat' } });
    expect(out.reply).toBe('Tomorrow 6–2.');
    expect(charged).toEqual([{ meter: { userId: 'u-9', purpose: 'chat' }, usage: { tier: 'fast', model: 'deepseek-flash', inputTokens: 420, cachedTokens: 2100, outputTokens: 70 } }]);
  });
});
