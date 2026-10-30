import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The model engine on WhatsApp (answerWithModel `channel: 'whatsapp'`), with
 * the SDK stubbed: plain text, at most 900 characters, app links in full,
 * and a hand-off that goes at once — never "want me to pass it on?". The app
 * keeps its own words.
 */

const toolRunner = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = { messages: { toolRunner } };
  }
  return { default: Anthropic };
});
vi.mock('../../config/env.js', () => ({
  env: { Hugo: 'test-key', ASSISTANT_MODEL: 'strong', ASSISTANT_FAST_MODEL: 'quick', APP_BASE_URL: 'https://people.example.com', NODE_ENV: 'test' },
}));
vi.mock('../../lib/hugoAllowance.js', () => ({
  assertAllowance: vi.fn(async () => ({ exhausted: false })),
  chargeModelCall: vi.fn(async () => 0),
}));

const { answerWithModel, whatsappInstruction } = await import('../../lib/assistantModel.js');

const identity = {
  name: 'Hugo',
  product: 'Alto People',
  audience: 'associate' as const,
  roleLabel: 'Associate',
  lang: 'en',
  terms: { worker: 'associate', workers: 'associates', site: 'store', sites: 'stores', manager: 'supervisor', managers: 'supervisors' },
  escalation: { who: 'Pat Lee' },
  canPropose: false,
};

type Params = { system: Array<{ text: string }>; tools: Array<{ name: string; description: string; run: (a: unknown) => Promise<string> }> };

beforeEach(() => {
  toolRunner.mockReset();
});

describe('answerWithModel on WhatsApp', () => {
  it('is told the WhatsApp rules, and that a hand-off goes at once', async () => {
    let escalated = '';
    toolRunner.mockImplementation(async (params: Params) => {
      escalated = await params.tools.find((t) => t.name === 'escalate_to_person')!.run({ summary: 'Wants an address change' });
      return { content: [{ type: 'text', text: "I can't change that here." }], stop_reason: 'end_turn' };
    });
    const out = await answerWithModel({ text: 'change my address', history: [], page: null, tools: [], identity, now: new Date('2026-10-29T18:00:00Z'), tier: 'fast', meter: { userId: 'u-1', purpose: 'whatsapp' }, channel: 'whatsapp' });
    expect(out.handoff).toEqual({ summary: 'Wants an address change', who: 'Pat Lee' });

    const params = toolRunner.mock.calls[0]![0] as Params;
    const system = params.system.map((s) => s.text).join('\n');
    expect(system).toContain('This conversation is on WhatsApp');
    expect(system).toContain('no markdown');
    expect(system).toContain('At most 900 characters');
    expect(system).toContain('https://people.example.com/payroll');
    expect(system).toContain('goes to Pat Lee at once');
    expect(system).not.toContain('if they confirm');
    expect(params.tools.find((t) => t.name === 'escalate_to_person')!.description).toContain('as soon as your reply is sent');
    expect(escalated).toContain('do not ask them to confirm');
  });

  it('the app keeps its words: an offer the person confirms, no WhatsApp rules', async () => {
    toolRunner.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    await answerWithModel({ text: 'change my address', history: [], page: null, tools: [], identity, now: new Date('2026-10-29T18:00:00Z'), tier: 'fast', meter: { userId: 'u-1', purpose: 'chat' } });
    const params = toolRunner.mock.calls[0]![0] as Params;
    const system = params.system.map((s) => s.text).join('\n');
    expect(system).not.toContain('WhatsApp');
    expect(system).toContain('if they confirm');
    expect(params.tools.find((t) => t.name === 'escalate_to_person')!.description).toContain('Records the offer only');
  });

  it('writes app links on the given base', () => {
    expect(whatsappInstruction('https://hr.example.org')).toContain('https://hr.example.org/payroll');
  });
});
