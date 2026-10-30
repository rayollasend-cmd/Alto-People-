import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What Hugo knows, as the model reads it: answerWithModel's `memory` goes in
 * the volatile half of the prompt (never the cached half — it is one
 * person's), under a header that says to use it when it helps and never to
 * recite it; no memory, no header. The SDK is stubbed (the model is never
 * called in tests), as in assistantModel.test.ts.
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
vi.mock('../../lib/hugoAllowance.js', () => ({
  assertAllowance: vi.fn(async () => ({ exhausted: false })),
  chargeModelCall: vi.fn(async () => 0),
}));

const { answerWithModel } = await import('../../lib/assistantModel.js');
const { MEMORY_PROMPT_HEADER, memoryPromptLines } = await import('../../lib/hugoMemoryPrompt.js');

const identity = {
  name: 'Hugo',
  product: 'Alto People',
  audience: 'associate' as const,
  roleLabel: 'Associate',
  lang: 'en',
  terms: { worker: 'associate', workers: 'associates', site: 'store', sites: 'stores', manager: 'supervisor', managers: 'supervisors' },
  escalation: null,
};
const ask = (memory?: string[]) => answerWithModel({ text: 'any shifts this week?', history: [], page: null, tools: [], identity, now: new Date(), tier: 'fast', meter: { userId: 'u-1', purpose: 'chat' }, memory });
type Params = { system: Array<{ text: string; cache_control?: unknown }> };

beforeEach(() => {
  toolRunner.mockReset();
  toolRunner.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
});

describe('memoryPromptLines', () => {
  it('a header, then one line per fact — one line each, never longer than the guard allows', () => {
    expect(memoryPromptLines(['I prefer mornings', { text: 'I take the 6:10\nvan' }, '  '])).toEqual([MEMORY_PROMPT_HEADER, '- I prefer mornings', '- I take the 6:10 van']);
    expect(memoryPromptLines([`x${'y'.repeat(300)}`])[1]!.length).toBe(202);
    expect(memoryPromptLines([])).toEqual([]);
    expect(MEMORY_PROMPT_HEADER).toContain('never recite it back unasked');
  });
});

describe('answerWithModel memory', () => {
  it('puts the facts in the prompt, after the cached half', async () => {
    await ask(['I prefer morning shifts', 'I take the van from Main St']);
    const params = toolRunner.mock.calls[0]![0] as Params;
    const last = params.system.at(-1)!;
    expect(last.text).toBe([MEMORY_PROMPT_HEADER, '- I prefer morning shifts', '- I take the van from Main St'].join('\n'));
    expect(last.cache_control).toBeUndefined();
    expect(params.system[0]!.text).not.toContain('morning shifts');
  });

  it('no memory (off, or nothing kept): nothing about it in the prompt', async () => {
    await ask(undefined);
    await ask([]);
    for (const call of toolRunner.mock.calls) {
      const params = call[0] as Params;
      expect(params.system.map((s) => s.text).join('\n')).not.toContain(MEMORY_PROMPT_HEADER);
    }
  });
});
