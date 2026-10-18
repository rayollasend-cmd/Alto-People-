import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { env } from '../config/env.js';

/**
 * The assistant's model (Claude), behind the same front door as the intent
 * registry in lib/hugo.
 *
 *   The registry's answers are the TOOLS: what waits on the desk, coverage,
 *   payday, the next ride, the next shifts, documents to renew — each one
 *   reads the person's own records under the session's authority and
 *   nothing else. The model decides which to call, reads the result, and
 *   answers in the person's language, knowing the page they are on. It never
 *   acts on its own: its propose_* tools (lib/assistantActions) only set up a
 *   confirmation card, and the person's own Confirm runs it. When it cannot help an
 *   associate it OFFERS a hand-off to a person (a tool that only records
 *   the offer; the person confirms, routes/hugo performs it) — never a
 *   silent thread with the supervisor.
 *
 *   No ANTHROPIC_API_KEY: nothing here runs and the registry answers alone
 *   (dev, tests, an organization that has not switched the model on).
 */

export interface AssistantTool {
  key: string;
  name: string;
  description: string;
  /** JSON-schema properties the model fills in; none = the tool takes no input. */
  input?: { properties: Record<string, unknown>; required?: string[] };
  run: (args?: Record<string, unknown>) => Promise<{ reply: string; linkUrl: string | null }>;
}

export interface AssistantPage {
  path: string;
  title?: string | null;
  record?: { type: string; id: string; name: string } | null;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantIdentity {
  /** What the organization calls the assistant. */
  name: string;
  /** The product name, said once when asked who it is. */
  product: string;
  audience: 'associate' | 'manager' | 'admin';
  roleLabel: string;
  /** ISO language: en, es, tr… */
  lang: string;
  /** The organization's words: worker, site, manager and their plurals. */
  terms: { worker: string; workers: string; site: string; sites: string; manager: string; managers: string };
  /** When set, the person is an associate who may be handed to this person. */
  escalation: { who: string | null } | null;
  /** The person has propose_* tools: actions are proposed, then confirmed by them (lib/assistantActions). */
  canPropose?: boolean;
}

export interface ModelAnswer {
  reply: string;
  linkUrl: string | null;
  toolsUsed: string[];
  /** The model offered to pass the question to a person; the client confirms. */
  handoff: { summary: string; who: string | null } | null;
}

export function modelAvailable(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // A chat answer should land in seconds; one retry, then the registry's
  // fallback copy. The SDK's ten-minute default is for other work.
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 45_000, maxRetries: 1 });
  return client;
}

const MAX_HISTORY = 10;

/** The stable half of the prompt — cached across the organization's asks. */
function stableSystem(id: AssistantIdentity): string {
  return [
    `You are ${id.name}, the AI assistant in ${id.product}. You are an AI, never a person; say so if asked.`,
    `You help the people who run and work the floor: ${id.terms.workers}, ${id.terms.managers}, and the office.`,
    `Facts come only from your tools. Call a tool before stating anything about a person's schedule, pay, ride, documents, desk or coverage. Never invent a name, a time, a number or a status. If no tool covers the question, say plainly what you cannot do here.`,
    `Answer in two to four short sentences. Use the organization's words: "${id.terms.worker}" / "${id.terms.workers}", "${id.terms.site}" / "${id.terms.sites}", "${id.terms.manager}" / "${id.terms.managers}". No markdown headings, no bullet lists longer than four items.`,
    id.canPropose
      ? `You never act on your own. When someone asks you to approve, deny, give a shift, message a crew, file a case, request a schedule change or call out, look the thing up first, then call the matching propose_* tool. That only sets up a card: say in one sentence what will happen and that they tap the button to do it. Never say an action is done. If no propose_* tool covers it, tell them where in the product they can, with the link.`
      : `You cannot act: you do not approve, assign, send or change anything. When someone asks you to, tell them where in the product they can, and give the link if a tool returned one.`,
    `For a numbers question (how many, total, by month, by status) use run_report when you have it, and summarise the table in a sentence.`,
    `Never reveal another person's pay, documents or private details. A ${id.terms.manager} sees their own ${id.terms.sites}; a ${id.terms.worker} sees only their own records.`,
    id.escalation
      ? `If a ${id.terms.worker} needs something no tool covers, call escalate_to_person with a one-line summary, then tell them you can pass it to ${id.escalation.who ?? `their ${id.terms.manager}`} if they confirm. Do not claim to have sent anything.`
      : `Do not offer to contact anyone on the person's behalf; point them to the right page instead.`,
  ].join('\n');
}

/** The volatile half: who is asking, where they are, what day it is. */
function liveSystem(id: AssistantIdentity, page: AssistantPage | null, now: Date): string {
  const lines = [
    `The person asking is a ${id.roleLabel} (audience: ${id.audience}). Reply in the language with code "${id.lang}".`,
    `Today is ${now.toISOString().slice(0, 10)} (UTC).`,
  ];
  if (page) {
    lines.push(`They are on the page "${page.title ?? page.path}" (${page.path}).`);
    if (page.record) lines.push(`That page is the record of ${page.record.type} "${page.record.name}" (id ${page.record.id}). "This person", "them", "here" most likely mean that record.`);
  }
  return lines.join('\n');
}

export async function answerWithModel(input: {
  text: string;
  history: AssistantTurn[];
  page: AssistantPage | null;
  tools: AssistantTool[];
  identity: AssistantIdentity;
  now: Date;
}): Promise<ModelAnswer> {
  const used: string[] = [];
  let linkUrl: string | null = null;
  let handoff: ModelAnswer['handoff'] = null;

  // One array for every tool; the escalation tool's input differs, so the
  // array is typed by the runner's own parameter rather than the first tool.
  type RunnerTools = NonNullable<Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools']>;
  const tools: RunnerTools = input.tools.map(
    (t) =>
      betaTool({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: (t.input?.properties ?? {}) as never, ...(t.input?.required ? { required: t.input.required } : {}), additionalProperties: false },
        run: async (args) => {
          const r = await t.run((args ?? {}) as Record<string, unknown>);
          used.push(t.key);
          if (r.linkUrl) linkUrl = r.linkUrl;
          return r.reply;
        },
      }) as unknown as RunnerTools[number],
  );
  if (input.identity.escalation) {
    const who = input.identity.escalation.who;
    tools.push(
      betaTool({
        name: 'escalate_to_person',
        description: 'Offer to pass the question to a person. Records the offer only; the person asking confirms before anything is sent.',
        inputSchema: {
          type: 'object',
          properties: { summary: { type: 'string', description: 'One line: what the person needs, in their words.' } },
          required: ['summary'],
          additionalProperties: false,
        },
        run: async (args) => {
          const summary = String((args as { summary?: unknown }).summary ?? '').slice(0, 300);
          handoff = { summary, who };
          return `Offer recorded. Tell them you can pass this to ${who ?? 'a person'} if they confirm; nothing has been sent.`;
        },
      }) as unknown as RunnerTools[number],
    );
  }

  // The last turns, alternating, starting with the person.
  const history: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of input.history.slice(-MAX_HISTORY)) {
    const text = t.text.trim();
    if (!text) continue;
    const last = history[history.length - 1];
    if (last && last.role === t.role) continue;
    if (!last && t.role !== 'user') continue;
    history.push({ role: t.role, content: text });
  }

  const final = await anthropic().beta.messages.toolRunner({
    model: env.ASSISTANT_MODEL,
    max_tokens: 1200,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: [
      { type: 'text', text: stableSystem(input.identity), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: liveSystem(input.identity, input.page, input.now) },
    ],
    tools,
    messages: [...history, { role: 'user', content: input.text }],
  });

  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { reply, linkUrl, toolsUsed: used, handoff };
}
