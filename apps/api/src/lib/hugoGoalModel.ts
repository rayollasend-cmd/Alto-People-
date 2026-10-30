import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { HugoGoalStep } from '@alto-people/shared';
import { runModelLoop, type AssistantTool, type ModelTier, type RunnerTools } from './assistantModel.js';
import { companyWorkweek, orgDateKey } from './timeAnomalies.js';

/**
 * One step of Hugo's thinking on a goal (lib/hugoGoals), on the model loop
 * every Hugo answer uses (lib/assistantModel runModelLoop): charged to the
 * goal's owner (purpose 'goal' — their monthly allowance is the limit, and a
 * used-up allowance throws HugoAllowanceError before anything is spent), the
 * cheapest tier that does the job (the caller picks: planning thinks, a
 * check-in doesn't), and bounded — a step has a deadline and a budget of
 * tool calls, so a goal can never loop or hold its claim for long.
 *
 * The prompt says who is asking, in which language, what day it is, the goal
 * in their words, the plan, the trail so far, what its watches are doing and
 * what they told Hugo before (`memory`, from "What Hugo knows").
 */

export interface GoalIdentity {
  /** What the organization calls the assistant. */
  name: string;
  product: string;
  audience: 'associate' | 'driver' | 'manager' | 'admin';
  roleLabel: string;
  /** The person's language code (en es tr ht pt uk). */
  lang: string;
  terms: { worker: string; workers: string; site: string; sites: string; manager: string; managers: string };
}

export interface GoalStepInput {
  userId: string;
  identity: GoalIdentity;
  goal: string;
  plan: HugoGoalStep[];
  /** What happened so far, oldest first, one plain line each. */
  trail: string[];
  /** What the watches and asks it started are doing. */
  children: string[];
  /** Why Hugo is looking now. */
  why: string;
  startedAt: Date;
  expiresAt: Date;
  steps: { used: number; max: number };
  /** Facts the person told Hugo before ("What Hugo knows"); the memory builder wires them in. */
  memory?: string[];
  tools: AssistantTool[];
  tier: ModelTier;
  now: Date;
  /** A step that runs longer is stopped (ms). */
  deadlineMs?: number;
  /** Tool calls one step may make; past it every tool answers "stop". */
  maxToolCalls?: number;
}

export interface GoalStepResult {
  toolsUsed: string[];
}

const DEADLINE_MS = 90_000;
const MAX_TOOL_CALLS = 12;

/** The stable half — the same for every goal in the organization, so it is cached. */
export function goalStableSystem(id: GoalIdentity): string {
  return [
    `You are ${id.name}, the AI assistant in ${id.product}. You are an AI, never a person. You are working in the background on a goal a person gave you; they are not watching this conversation.`,
    `Each time you are woken you take ONE step: read what you need with the read tools and find_options, then end the step with at most one of propose, finish or check_back (update_plan, start_watch and tell_person may come before it). Then stop and say nothing more — nobody reads your text reply.`,
    `Facts come only from your tools. Never invent a name, a time, a number, an id or a status. Propose only ids that find_options returned in this step.`,
    `You never change anything yourself. Anything that changes a record or reaches another person (a request, a message, a shift) is a proposal: call propose with an action the person may take; they approve it, and it runs as them through the product. Watching changes nothing: start_watch needs no approval. Propose one thing at a time, the one that helps the goal most now.`,
    `If the person declined a proposal, do not propose the same thing again; plan around it.`,
    `Keep the plan to at most six short steps the person can follow, each under 80 characters, in their language; mark what is done.`,
    `Use tell_person only for news that matters to the goal (at most once a day): one or two plain, warm sentences.`,
    `When the goal is reached, finish with DONE and a one-sentence summary. If it cannot be done here — no action or tool covers it, or it is outside what this person may do — finish with GAVE_UP and say plainly why and, if there is one, where in the app they can do it. Do not finish while something you started is still working.`,
    `Never reveal another person's pay, documents or private details. A ${id.terms.manager} sees their own ${id.terms.sites}; a ${id.terms.worker} sees only their own records. Never write an SSN or an account number.`,
    `Use the organization's words: "${id.terms.worker}" / "${id.terms.workers}", "${id.terms.site}" / "${id.terms.sites}", "${id.terms.manager}" / "${id.terms.managers}". No markdown.`,
  ].join('\n');
}

const day = (d: Date) => orgDateKey(d);

/** The volatile half: who, when, the goal and where it stands. */
export function goalLiveSystem(input: Omit<GoalStepInput, 'tools' | 'tier'>): string {
  const lines = [
    `The person is a ${input.identity.roleLabel} (audience: ${input.identity.audience}). Everything they read — the plan, proposals' reasons, updates, the summary — is in the language with code "${input.identity.lang}".`,
    // The company's calendar day (its zone named): from 5 PM Pacific the UTC date is already tomorrow.
    `Today is ${day(input.now)} (${companyWorkweek().timezone}); the time is ${input.now.toISOString()}.`,
    `The goal, in their words: "${input.goal}"`,
    `Started ${day(input.startedAt)}; it ends ${day(input.expiresAt)}. Steps used: ${input.steps.used} of ${input.steps.max}.`,
    `Why you are looking now: ${input.why}`,
    input.plan.length ? `The plan:\n${input.plan.map((s, i) => `${i + 1}. [${s.state}] ${s.text}`).join('\n')}` : 'There is no plan yet: make one with update_plan.',
    input.trail.length ? `What happened so far (oldest first):\n${input.trail.join('\n')}` : 'Nothing has happened yet.',
    input.children.length ? `What you started for it:\n${input.children.join('\n')}` : 'You have not started any watch or ask for it.',
  ];
  if (input.memory?.length) lines.push(`What this person told you before (use it when it helps; never recite it back unasked):\n${input.memory.map((m) => `- ${m}`).join('\n')}`);
  return lines.join('\n\n');
}

/**
 * Run one step. The tools' own `run` records what the step decided (lib/hugoGoals
 * collects it); this only drives the loop and keeps it bounded.
 */
export async function runGoalStep(input: GoalStepInput): Promise<GoalStepResult> {
  const used: string[] = [];
  const maxCalls = input.maxToolCalls ?? MAX_TOOL_CALLS;
  let calls = 0;
  const tools: RunnerTools = input.tools.map(
    (t) =>
      betaTool({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: (t.input?.properties ?? {}) as never, ...(t.input?.required ? { required: t.input.required } : {}), additionalProperties: false },
        run: async (args) => {
          calls += 1;
          if (calls > maxCalls) return 'This step has used all its tool calls. Stop now; nobody reads your reply.';
          const r = await t.run((args ?? {}) as Record<string, unknown>);
          used.push(t.key);
          return r.reply;
        },
      }) as unknown as RunnerTools[number],
  );
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), input.deadlineMs ?? DEADLINE_MS);
  try {
    await runModelLoop({
      tier: input.tier,
      system: [goalStableSystem(input.identity), goalLiveSystem(input)],
      messages: [{ role: 'user', content: 'Take your next step on this goal.' }],
      tools,
      meter: { userId: input.userId, purpose: 'goal' },
      // Streamed turn by turn only so a step past its deadline can be stopped; no words go anywhere.
      live: { signal: stop.signal },
      maxTokens: input.tier === 'deep' ? 2000 : 1000,
    });
  } finally {
    clearTimeout(timer);
  }
  return { toolsUsed: used };
}
