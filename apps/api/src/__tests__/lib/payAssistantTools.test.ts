import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The assistant's pay tools: each reads only the asking worker's own
 * records (the id comes from the session, never from the model), and the
 * model gets them through the same tool runner as every other tool. The
 * SDK is stubbed; the real model is never called.
 */

const toolRunner = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = { messages: { toolRunner } };
  }
  return { default: Anthropic };
});
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, env: { ...actual.env, Hugo: 'test-key', ASSISTANT_MODEL: 'deepseek-v4-pro' } };
});

const { answerWithModel } = await import('../../lib/assistantModel.js');
const { payTools } = await import('../../lib/payAssistantTools.js');
const { recordManualCheck } = await import('../../lib/manualChecks.js');
const { createAssociate, createUser, prisma, truncateAll } = await import('../../../test/db.js');

beforeEach(async () => {
  toolRunner.mockReset();
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function paidWorker(first: string, gross: number, checkNumber: string) {
  const a = await createAssociate({ firstName: first, lastName: 'Test' });
  await prisma.associate.update({ where: { id: a.id }, data: { state: 'FL' } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const fed = Math.round(gross * 0.08 * 100) / 100;
  const ss = Math.round(gross * 0.062 * 100) / 100;
  const med = Math.round(gross * 0.0145 * 100) / 100;
  await recordManualCheck(prisma, {
    associateId: a.id,
    checkNumber,
    payDate: new Date('2026-09-30T00:00:00Z'),
    gross,
    federal: fed,
    socialSecurity: ss,
    medicare: med,
    state: 0,
    net: Math.round((gross - fed - ss - med) * 100) / 100,
    actorUserId: hr.id,
  });
  return a;
}

const identity = {
  name: 'Hugo',
  product: 'Alto People',
  audience: 'associate' as const,
  roleLabel: 'Associate',
  lang: 'es',
  terms: { worker: 'asociado', workers: 'asociados', site: 'tienda', sites: 'tiendas', manager: 'supervisor', managers: 'supervisores' },
  escalation: null,
};

describe('pay tools', () => {
  it('explain_my_latest_paystub reads the asking worker’s paystub and nobody else’s', async () => {
    const ana = await paidWorker('Ana', 500, '2001');
    await paidWorker('Ben', 777, '2002');
    const tools = payTools(prisma, { associateId: ana.id });
    expect(tools.map((t) => t.name)).toEqual(['explain_my_latest_paystub', 'check_my_withholding']);
    // The tool takes no input — there is no way to ask for someone else.
    expect(tools[0]!.input).toBeUndefined();
    const out = await tools[0]!.run({ associateId: 'someone-else' });
    expect(out.reply).toContain('$500.00');
    expect(out.reply).toContain('Social Security: $31.00');
    expect(out.reply).not.toContain('$777.00');
    expect(out.reply).toContain('manual (paper) check');
  });

  it('only a worker gets them', () => {
    expect(payTools(prisma, { associateId: null })).toEqual([]);
  });

  it('the model calls the tool through the runner and answers from its facts', async () => {
    const ana = await paidWorker('Ana', 500, '2003');
    toolRunner.mockImplementation(async (params: { tools: Array<{ name: string; run: (a: unknown) => Promise<string> }> }) => {
      const stub = params.tools.find((t) => t.name === 'explain_my_latest_paystub')!;
      const facts = await stub.run({});
      return { content: [{ type: 'text', text: `Tu pago bruto fue ${facts.match(/Gross pay[^$]*(\$[\d,]+\.\d{2})/)?.[1]}.` }], stop_reason: 'end_turn' };
    });
    const out = await answerWithModel({
      text: '¿Por qué me quitaron tanto?',
      history: [],
      page: { path: '/payroll' },
      tools: payTools(prisma, { associateId: ana.id }),
      identity,
      now: new Date('2026-10-18T12:00:00Z'),
      // Nobody is charged: the stub reports no tokens.
      meter: { userId: '00000000-0000-4000-8000-0000000000aa', purpose: 'chat' },
    });
    expect(out.reply).toBe('Tu pago bruto fue $500.00.');
    expect(out.toolsUsed).toEqual(['PAYSTUB']);
    // The link opens that paystub, not the payroll page in general.
    expect(out.linkUrl).toMatch(/^\/payroll\?item=[0-9a-f-]{36}$/);
  });

  it('check_my_withholding points to the estimator when there is no W-4', async () => {
    const ana = await paidWorker('Ana', 500, '2004');
    const out = await payTools(prisma, { associateId: ana.id })[1]!.run();
    expect(out.linkUrl).toBe('/payroll/w4-estimator');
    expect(out.reply).toContain('No W-4 on file');
  });
});
