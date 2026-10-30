import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { env } from '../config/env.js';
import { assertAllowance, chargeModelCall, type ModelMeter } from './hugoAllowance.js';
import { publicBaseUrl } from './emailLayout.js';
import { companyWorkweek, orgDateKey } from './timeAnomalies.js';
import { memoryPromptLines } from './hugoMemoryPrompt.js';

/**
 * The assistant's model — DeepSeek since 2026-10-29 (the owner's choice),
 * through its Anthropic-compatible API, so the same SDK and tool loop serve
 * it — behind the same front door as the intent registry in lib/hugo.
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
 *   Every call is charged to the person it is for (lib/hugoAllowance): it is
 *   refused before it starts once their allowance is used up
 *   (HugoAllowanceError), and its tokens are recorded after.
 *
 *   No key (`Hugo` / DEEPSEEK_API_KEY): nothing here runs and the registry
 *   answers alone (dev, tests, an organization that has not switched it on).
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
  audience: 'associate' | 'driver' | 'manager' | 'admin';
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

/** Which model answers (lib/hugoRouting pickTier): the quick one, or the strongest. */
export type ModelTier = 'fast' | 'deep';

/**
 * Where the answer is read. 'whatsapp' (lib/hugoWhatsapp): plain text in a
 * chat bubble — no markdown, at most 900 characters, app links written in
 * full — and a hand-off goes as soon as the answer is sent (the person
 * asked on WhatsApp), so the model never asks them to confirm one.
 */
export type AssistantChannel = 'app' | 'whatsapp';

/** The longest answer the model may write on WhatsApp (the reply's AI disclosure line comes after). */
export const WHATSAPP_MAX_CHARS = 900;

/** The WhatsApp rules, in the stable (cached) half of the prompt. */
export function whatsappInstruction(base: string = publicBaseUrl()): string {
  return [
    `This conversation is on WhatsApp. Write plain text only: no markdown (no asterisks, underscores, backticks or # headings), no tables, no [text](link) links. At most ${WHATSAPP_MAX_CHARS} characters.`,
    `A list is at most four lines, each starting with "• ". When you point to a page in the app, write its full address starting with ${base}/ (for example ${base}/payroll), never a bare path like /payroll.`,
  ].join('\n');
}

/** Hooks for an answer shown as it is made (POST /hugo/ask/stream). */
export interface AssistantLive {
  /** A tool is about to run: its key (the registry's intent, a pay tool, an ACT_*, or ESCALATE). */
  onTool?: (key: string) => void;
  /** Words of the reply, as they are written. */
  onText?: (delta: string) => void;
  /** What was written so far led in to a tool call ("let me check"): drop it. */
  onClear?: () => void;
  /** The person went away: stop. */
  signal?: AbortSignal;
}

const apiKey = (): string | undefined => env.Hugo || env.DEEPSEEK_API_KEY;

export function modelAvailable(): boolean {
  return Boolean(apiKey());
}

/**
 * DeepSeek's Anthropic-compatible API takes a tool as { name, description,
 * input_schema }: the SDK's `type: 'custom'` is refused (422), so it is
 * dropped on the way out. Anthropic's own API accepts either.
 */
const compatFetch: typeof fetch = async (url, init) => {
  if (init && typeof init.body === 'string' && init.body.includes('"tools"')) {
    const body = JSON.parse(init.body) as { tools?: Array<Record<string, unknown>> };
    if (Array.isArray(body.tools)) {
      body.tools = body.tools.map(({ type, ...tool }) => (type === 'custom' ? tool : { type, ...tool }));
      init = { ...init, body: JSON.stringify(body) };
    }
  }
  return fetch(url, init);
};

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // A chat answer should land in seconds; one retry, then the registry's
  // fallback copy. The SDK's ten-minute default is for other work.
  client ??= new Anthropic({ apiKey: apiKey(), baseURL: env.ASSISTANT_BASE_URL, timeout: 45_000, maxRetries: 1, fetch: compatFetch });
  return client;
}

/** The tools a loop may call, as the SDK's runner takes them (betaTool). */
export type RunnerTools = NonNullable<Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools']>;

/**
 * One run of the model with tools until it answers — charged to the person
 * it is for. Refused before it starts when their allowance is used up
 * (HugoAllowanceError); every turn's tokens are added up and charged after,
 * even when a later turn fails. `system[0]` is the stable, cacheable part.
 * With `live`, each turn streams: its words go out as they come, and a turn
 * that ends in a tool call was a lead-in, so the screen drops it.
 */
export async function runModelLoop(input: {
  tier: ModelTier;
  system: string[];
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: RunnerTools;
  meter: ModelMeter;
  live?: AssistantLive;
  maxTokens?: number;
}): Promise<Anthropic.Beta.BetaMessage> {
  await assertAllowance(input.meter.userId);
  // The strongest model thinks first; the quick one answers straight off —
  // a shift or a payday needs a tool call, not deliberation.
  const deep = input.tier === 'deep';
  const model = deep ? env.ASSISTANT_MODEL : env.ASSISTANT_FAST_MODEL;
  const params = {
    model,
    max_tokens: input.maxTokens ?? (deep ? 1200 : 800),
    ...(deep ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'medium' as const } } : {}),
    system: input.system.map((text, i) => (i === 0 ? { type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } } : { type: 'text' as const, text })),
    tools: input.tools,
    messages: input.messages,
  };
  const used = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  const count = (m: Anthropic.Beta.BetaMessage) => {
    const u = m.usage;
    used.inputTokens += (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
    used.cachedTokens += u?.cache_read_input_tokens ?? 0;
    used.outputTokens += u?.output_tokens ?? 0;
  };
  let final: Anthropic.Beta.BetaMessage | null = null;
  const live = input.live;
  try {
    if (live) {
      const runner = anthropic().beta.messages.toolRunner({ ...params, stream: true }, { signal: live.signal });
      for await (const stream of runner) {
        stream.on('text', (delta: string) => live.onText?.(delta));
        const message = await stream.finalMessage();
        count(message);
        if (message.stop_reason === 'tool_use') live.onClear?.();
        final = message;
      }
    } else {
      // Each turn of the loop, so every turn's tokens are counted (awaiting the
      // runner gives only the last). A stub that is only a promise is awaited.
      const runner = anthropic().beta.messages.toolRunner(params) as unknown as AsyncIterable<Anthropic.Beta.BetaMessage> | Promise<Anthropic.Beta.BetaMessage>;
      if (Symbol.asyncIterator in runner) {
        for await (const message of runner) {
          count(message);
          final = message;
        }
      } else {
        final = await runner;
        count(final);
      }
    }
  } finally {
    if (used.inputTokens || used.outputTokens) {
      await chargeModelCall(input.meter, { tier: input.tier, model, ...used }).catch((err: unknown) =>
        console.warn('[assistant] could not record a model call’s cost:', err instanceof Error ? err.message : err),
      );
    }
  }
  if (!final) throw new Error('The model sent no answer.');
  return final;
}

const MAX_HISTORY = 10;

/** The stable half of the prompt — cached across the organization's asks. */
function stableSystem(id: AssistantIdentity, channel: AssistantChannel = 'app'): string {
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
      ? channel === 'whatsapp'
        ? `If a ${id.terms.worker} needs something no tool covers, call escalate_to_person with a one-line summary. On WhatsApp their question then goes to ${id.escalation.who ?? `their ${id.terms.manager}`} at once, and a line saying who has it is added after your answer: say briefly what you could not answer, do not ask them to confirm, and do not say yourself that it was sent.`
        : `If a ${id.terms.worker} needs something no tool covers, call escalate_to_person with a one-line summary, then tell them you can pass it to ${id.escalation.who ?? `their ${id.terms.manager}`} if they confirm. Do not claim to have sent anything.`
      : `Do not offer to contact anyone on the person's behalf; point them to the right page instead.`,
    ...(channel === 'whatsapp' ? [whatsappInstruction()] : []),
  ].join('\n');
}

/** The volatile half: who is asking, where they are, what day it is. */
function liveSystem(id: AssistantIdentity, page: AssistantPage | null, now: Date): string {
  const lines = [
    `The person asking is a ${id.roleLabel} (audience: ${id.audience}). Reply in the language with code "${id.lang}".`,
    // The company's calendar day (its zone named): from 5 PM Pacific the UTC date is already tomorrow.
    `Today is ${orgDateKey(now)} (${companyWorkweek().timezone}).`,
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
  /** The strongest model (the default) or the quick one. */
  tier?: ModelTier;
  /** Given: the answer streams, step by step. */
  live?: AssistantLive;
  /** Whose allowance it is charged to (lib/hugoAllowance). */
  meter: ModelMeter;
  /** Where the answer is read (the app, unless said): WhatsApp is plain text and hands off at once. */
  channel?: AssistantChannel;
  /** What this person told Hugo before (lib/hugoMemory: hugoMemoryTurn / memoryForChannel), in the volatile half of the prompt; none or empty = nothing. */
  memory?: string[];
}): Promise<ModelAnswer> {
  const used: string[] = [];
  let linkUrl: string | null = null;
  let handoff: ModelAnswer['handoff'] = null;

  // One array for every tool; the escalation tool's input differs, so the
  // array is typed by the runner's own parameter rather than the first tool.
  const tools: RunnerTools = input.tools.map(
    (t) =>
      betaTool({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: (t.input?.properties ?? {}) as never, ...(t.input?.required ? { required: t.input.required } : {}), additionalProperties: false },
        run: async (args) => {
          input.live?.onTool?.(t.key);
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
        description:
          input.channel === 'whatsapp'
            ? 'Pass the question to a person. On WhatsApp it goes, in their own words, as soon as your reply is sent; a line saying who has it is added for you.'
            : 'Offer to pass the question to a person. Records the offer only; the person asking confirms before anything is sent.',
        inputSchema: {
          type: 'object',
          properties: { summary: { type: 'string', description: 'One line: what the person needs, in their words.' } },
          required: ['summary'],
          additionalProperties: false,
        },
        run: async (args) => {
          input.live?.onTool?.('ESCALATE');
          const summary = String((args as { summary?: unknown }).summary ?? '').slice(0, 300);
          handoff = { summary, who };
          if (input.channel === 'whatsapp') return `Noted: it goes to ${who ?? 'a person'} once you reply. Say briefly what you could not answer; do not ask them to confirm and do not say it was sent.`;
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

  const final = await runModelLoop({
    tier: input.tier ?? 'deep',
    system: [stableSystem(input.identity, input.channel), liveSystem(input.identity, input.page, input.now), ...(input.memory?.length ? [memoryPromptLines(input.memory).join('\n')] : [])],
    messages: [...history, { role: 'user', content: input.text }],
    tools,
    meter: input.meter,
    live: input.live,
  });

  const reply = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { reply, linkUrl, toolsUsed: used, handoff };
}
