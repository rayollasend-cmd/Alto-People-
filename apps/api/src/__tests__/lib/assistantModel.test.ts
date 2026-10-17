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
  env: { ANTHROPIC_API_KEY: 'test-key', ASSISTANT_MODEL: 'claude-opus-5' },
}));

const { answerWithModel, modelAvailable } = await import('../../lib/assistantModel.js');

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
    });
    expect(out.reply).toBe('Tienes esto: 2 propuestas');
    expect(out.linkUrl).toBe('/approvals');
    expect(out.toolsUsed).toEqual(['DESK']);
    expect(out.handoff).toBeNull();

    const params = toolRunner.mock.calls[0]![0] as { model: string; system: Array<{ text: string; cache_control?: unknown }>; messages: Array<{ role: string; content: string }>; tools: Array<{ name: string }> };
    expect(params.model).toBe('claude-opus-5');
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
    });
    expect(out.handoff).toEqual({ summary: 'Needs a new badge', who: 'Dana Reyes' });
    expect(out.reply).toContain('Dana');
  });

  it('has no escalation tool for staff', async () => {
    toolRunner.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    await answerWithModel({ text: 'hi', history: [], page: null, tools: [], identity, now: new Date() });
    const params = toolRunner.mock.calls[0]![0] as { tools: Array<{ name: string }> };
    expect(params.tools.map((t) => t.name)).not.toContain('escalate_to_person');
  });
});
