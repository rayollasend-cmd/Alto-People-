import type { Prisma, PrismaClient } from '@prisma/client';
import {
  HUGO_MEMORY_KINDS,
  HUGO_MEMORY_MAX,
  HUGO_MEMORY_TEXT_MAX,
  checkHugoMemoryText,
  hugoMemorySameText,
  type HugoMemoryKind,
  type HugoMemoryRefusal,
  type HugoMemorySource,
  type HugoMemoryView,
  type HugoRemembered,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { sessionUserById } from '../middleware/auth.js';
import { enqueueAudit } from './audit.js';
import { logBuiltInAgentAction } from './agents.js';
import type { AssistantTool } from './assistantModel.js';
import type { HugoLang } from './hugoWorkCopy.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * What Hugo knows (Muse phase 4, 2026-10-29) — memory the person can see
 * and edit (packages/shared/src/hugoMemory.ts has the codes and the guard).
 *
 *   A person tells Hugo something about themselves worth keeping ("I prefer
 *   mornings", "I take the 6:10 van"); the model keeps it with its
 *   `remember_fact` tool, the answer says so with an Undo, and next time the
 *   facts are in the model's prompt. "What Hugo knows" in the panel shows
 *   every one; each can be changed or removed, more added, the whole memory
 *   switched off or forgotten.
 *
 * The rules:
 *   - one person's own facts, read and written by their account only
 *     (userId + tenant on every query; someone else's id is a 404);
 *   - every save passes one guard (`saveHugoMemory`): memory on, the shared
 *     text check (no numbers, nothing sensitive, nothing about someone
 *     else, ≤ 200 characters), at most 50 per person, no duplicates;
 *   - the audit log and the assistant's trail record kinds, sources and
 *     counts — never the words;
 *   - the person's data export carries their facts (lib/dataExport) and
 *     erasing them deletes them (lib/erasure).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface MemoryOwner {
  id: string;
  clientId?: string | null;
}

const VIEW_SELECT = { id: true, kind: true, text: true, source: true, createdAt: true, updatedAt: true, lastUsedAt: true } as const;
type Row = Prisma.HugoMemoryGetPayload<{ select: typeof VIEW_SELECT }>;

const kindOf = (k: string): HugoMemoryKind => {
  const up = k.trim().toUpperCase();
  return (HUGO_MEMORY_KINDS as readonly string[]).includes(up) ? (up as HugoMemoryKind) : 'OTHER';
};

export function memoryView(r: Row): HugoMemoryView {
  return {
    id: r.id,
    kind: kindOf(r.kind),
    text: r.text,
    source: r.source === 'ADDED' ? 'ADDED' : 'TOLD',
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  };
}

const own = (userId: string) => ({ userId, tenantId: tenantIdForWrite() });

function audit(user: MemoryOwner, action: string, metadata: Prisma.InputJsonObject): void {
  // The person's own memory: the row names them, never the words they kept.
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action, entityType: 'User', entityId: user.id, metadata }, 'hugoMemory');
}

/** On unless the person switched it off. */
export async function memoryOnFor(userId: string): Promise<boolean> {
  const s = await prisma.hugoMemorySetting.findFirst({ where: own(userId), select: { memoryOn: true } });
  return s?.memoryOn ?? true;
}

/** The person's facts, most recent first (at most 50 — the guard keeps it there). */
export async function hugoMemoryFor(userId: string): Promise<HugoMemoryView[]> {
  const rows = await prisma.hugoMemory.findMany({ where: own(userId), select: VIEW_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: HUGO_MEMORY_MAX });
  return rows.map(memoryView);
}

export { MEMORY_PROMPT_HEADER, memoryPromptLines } from './hugoMemoryPrompt.js';

/** Facts in a prompt: their lastUsedAt, at most once an hour (no write per question). */
async function touchUsed(userId: string, ids: string[], now: Date): Promise<void> {
  if (!ids.length) return;
  await prisma.hugoMemory.updateMany({
    where: { ...own(userId), id: { in: ids }, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - 3_600_000) } }] },
    data: { lastUsedAt: now },
  });
}

/**
 * What the WhatsApp brain (and any other model call for this person) puts
 * in the prompt: the facts' words, most recent first — none when memory is
 * off or the account no longer signs in. Marks them used.
 */
export async function memoryForChannel(userId: string): Promise<string[]> {
  if (!(await sessionUserById(userId))) return [];
  if (!(await memoryOnFor(userId))) return [];
  const facts = await hugoMemoryFor(userId);
  await touchUsed(userId, facts.map((f) => f.id), new Date());
  return facts.map((f) => f.text);
}

/* ------------------------------------------------------------------ the guard */

export type SaveOutcome =
  | { ok: true; fact: HugoMemoryView; existing: boolean; first: boolean }
  | { ok: false; reason: HugoMemoryRefusal };

/**
 * The one door a fact comes in by — the chat's `remember_fact` (TOLD) and
 * "Add something" (ADDED) alike: memory on, the text check, the cap, no
 * duplicate. `first` is true the first time this person has anything kept
 * by Hugo (his answer then says where it lives, once).
 */
export async function saveHugoMemory(user: MemoryOwner, input: { text: string; kind?: string | null; source: HugoMemorySource }): Promise<SaveOutcome> {
  const kind = kindOf(input.kind ?? 'OTHER');
  const refuse = (reason: HugoMemoryRefusal): SaveOutcome => {
    audit(user, 'hugo.memory.refused', { reason, kind, source: input.source });
    return { ok: false, reason };
  };
  if (!(await memoryOnFor(user.id))) return refuse('OFF');
  const check = checkHugoMemoryText(input.text);
  if (!check.ok) return refuse(check.reason);
  const facts = await prisma.hugoMemory.findMany({ where: own(user.id), select: VIEW_SELECT, orderBy: { createdAt: 'desc' } });
  const same = facts.find((f) => hugoMemorySameText(f.text, check.text));
  if (same) return { ok: true, fact: memoryView(same), existing: true, first: false };
  if (facts.length >= HUGO_MEMORY_MAX) return refuse('FULL');
  const row = await prisma.hugoMemory.create({ data: { ...own(user.id), kind, text: check.text, source: input.source }, select: VIEW_SELECT });
  // Two saves at once can both pass the count: the one past the cap is taken back.
  if ((await prisma.hugoMemory.count({ where: own(user.id) })) > HUGO_MEMORY_MAX) {
    await prisma.hugoMemory.deleteMany({ where: { ...own(user.id), id: row.id } });
    return refuse('FULL');
  }
  let first = false;
  if (input.source === 'TOLD') {
    // Said once, the first time Hugo keeps something: the setting row remembers that he did.
    // The fact is already kept: two saves in one answer race to create this row, and a
    // lost race (or a busy database) must not turn "saved" into "not saved".
    try {
      const setting = await prisma.hugoMemorySetting.upsert({ where: { userId: user.id }, create: { ...own(user.id) }, update: {}, select: { id: true, introducedAt: true } });
      if (!setting.introducedAt) {
        const n = await prisma.hugoMemorySetting.updateMany({ where: { id: setting.id, introducedAt: null }, data: { introducedAt: new Date() } });
        first = n.count > 0;
      }
    } catch (err) {
      console.warn('[hugo memory] could not mark the first save:', err instanceof Error ? err.message : err);
    }
  }
  audit(user, 'hugo.memory.saved', { kind, source: input.source, total: facts.length + 1 });
  return { ok: true, fact: memoryView(row), existing: false, first };
}

async function ownFact(userId: string, id: string): Promise<Row> {
  const row = await prisma.hugoMemory.findFirst({ where: { ...own(userId), id }, select: VIEW_SELECT });
  // Someone else's fact (or one already gone) is not there for this person.
  if (!row) throw new HttpError(404, 'not_found', 'Not found.');
  return row;
}

export class MemoryRefused extends HttpError {
  constructor(public readonly reason: HugoMemoryRefusal) {
    super(reason === 'OFF' ? 409 : 422, reason === 'OFF' ? 'memory_off' : 'memory_refused', REFUSED_FOR_PERSON[reason], { reason });
  }
}

/** The person adds one ("Add something"). */
export async function addHugoMemory(user: MemoryOwner, text: string, kind: HugoMemoryKind): Promise<{ fact: HugoMemoryView; existing: boolean }> {
  const out = await saveHugoMemory(user, { text, kind, source: 'ADDED' });
  if (!out.ok) throw new MemoryRefused(out.reason);
  return { fact: out.fact, existing: out.existing };
}

/** The person changes one: the same guard for new words. */
export async function editHugoMemory(user: MemoryOwner, id: string, patch: { text?: string; kind?: HugoMemoryKind }): Promise<HugoMemoryView> {
  const row = await ownFact(user.id, id);
  const data: Prisma.HugoMemoryUpdateInput = {};
  const changed: string[] = [];
  if (patch.text !== undefined && patch.text !== row.text) {
    const check = checkHugoMemoryText(patch.text);
    if (!check.ok) {
      audit(user, 'hugo.memory.refused', { reason: check.reason, kind: kindOf(row.kind), source: 'EDIT' });
      throw new MemoryRefused(check.reason);
    }
    data.text = check.text;
    changed.push('text');
  }
  if (patch.kind !== undefined && patch.kind !== row.kind) {
    data.kind = patch.kind;
    changed.push('kind');
  }
  if (!changed.length) return memoryView(row);
  const updated = await prisma.hugoMemory.update({ where: { id: row.id }, data, select: VIEW_SELECT });
  audit(user, 'hugo.memory.edited', { kind: kindOf(updated.kind), changed });
  return memoryView(updated);
}

/** One removed: from the list, an answer's Undo, or the chat's "forget that". */
export async function removeHugoMemory(user: MemoryOwner, id: string, via: 'list' | 'undo' | 'chat'): Promise<void> {
  const row = await ownFact(user.id, id);
  await prisma.hugoMemory.deleteMany({ where: { ...own(user.id), id: row.id } });
  audit(user, 'hugo.memory.removed', { kind: kindOf(row.kind), source: row.source, via });
}

/** Forget everything (the person confirmed it in the app). */
export async function forgetAllHugoMemory(user: MemoryOwner): Promise<number> {
  const { count } = await prisma.hugoMemory.deleteMany({ where: own(user.id) });
  audit(user, 'hugo.memory.cleared', { count });
  return count;
}

/** The switch. Off: Hugo neither uses nor keeps anything; what is kept stays until removed. */
export async function setHugoMemoryOn(user: MemoryOwner, memoryOn: boolean): Promise<boolean> {
  const was = await memoryOnFor(user.id);
  await prisma.hugoMemorySetting.upsert({ where: { userId: user.id }, create: { ...own(user.id), memoryOn }, update: { memoryOn } });
  if (was !== memoryOn) audit(user, 'hugo.memory.switched', { on: memoryOn });
  return memoryOn;
}

/* ------------------------------------------------------------- privacy rights */

/** The person's data export (lib/dataExport): their switch and every fact, words included — it is theirs. */
export async function exportHugoMemory(userId: string): Promise<{ memoryOn: boolean; facts: HugoMemoryView[] } | null> {
  const [setting, rows] = await Promise.all([
    prisma.hugoMemorySetting.findFirst({ where: { userId }, select: { memoryOn: true } }),
    prisma.hugoMemory.findMany({ where: { userId }, select: VIEW_SELECT, orderBy: { createdAt: 'desc' } }),
  ]);
  if (!setting && !rows.length) return null;
  return { memoryOn: setting?.memoryOn ?? true, facts: rows.map(memoryView) };
}

/** Erasure (lib/erasure) and an account's deletion: the facts and the switch go with the person. */
export async function eraseHugoMemory(db: Db, userId: string): Promise<number> {
  const { count } = await db.hugoMemory.deleteMany({ where: { userId } });
  await db.hugoMemorySetting.deleteMany({ where: { userId } });
  return count;
}

/* -------------------------------------------------------------- in the chat */

/**
 * The API's message for each refusal (routes/hugoMemory's 409/422). The app
 * words each reason itself, in the person's language (hugoPane.memory.refused.*);
 * no assistant name here — a tenant may have renamed him.
 */
const REFUSED_FOR_PERSON: Record<HugoMemoryRefusal, string> = {
  EMPTY: 'Write something to keep.',
  TOO_LONG: `Keep it to ${HUGO_MEMORY_TEXT_MAX} characters.`,
  SECRET: 'ID, bank or card numbers, passwords and contact details are never kept.',
  HEALTH: 'Health details are never kept — they stay private.',
  RELIGION: 'Religious details are never kept — they stay private.',
  IMMIGRATION: 'Immigration and visa details are never kept — they stay private.',
  ORIENTATION: 'Orientation and gender identity are never kept — they stay private.',
  CRIMINAL: 'Criminal-record details are never kept — they stay private.',
  UNION: 'Union details are never kept — they stay private.',
  OTHER_PERSON: 'Only things about you are kept, not about other people.',
  FULL: `${HUGO_MEMORY_MAX} things can be kept — remove some first.`,
  OFF: 'Memory is off. Turn it on to add things.',
};

/** What the model is told when a save is refused (it says it in the person's language). */
function refusedForModel(reason: HugoMemoryRefusal, name: string): string {
  const sensitive = (what: string) =>
    `Not saved: you never keep ${what}. Tell them plainly that it stays private. If part of what they said is useful without that detail (say, a day they can't work), you may save just that part.`;
  switch (reason) {
    case 'SECRET':
      return 'Not saved: you never keep ID, Social Security, bank or card numbers, passwords or contact details. Tell them so plainly.';
    case 'HEALTH':
      return sensitive('health, medical, pregnancy or disability details');
    case 'RELIGION':
      return sensitive('religious details');
    case 'IMMIGRATION':
      return sensitive('immigration or visa details');
    case 'ORIENTATION':
      return sensitive('details about sexual orientation or gender identity');
    case 'CRIMINAL':
      return sensitive('criminal-record details');
    case 'UNION':
      return sensitive('union membership');
    case 'OTHER_PERSON':
      return 'Not saved: you keep only facts about the person themselves, never about someone else. If there is a fact about them in it, you may save that, in the first person.';
    case 'TOO_LONG':
      return `Not saved: too long. Save one short fact, ${HUGO_MEMORY_TEXT_MAX} characters at most.`;
    case 'FULL':
      return `Not saved: they already have ${HUGO_MEMORY_MAX} things kept, the most there can be. Tell them: "I can keep ${HUGO_MEMORY_MAX} things — remove some in What ${name} knows."`;
    case 'OFF':
      return `Not saved: their memory is switched off (What ${name} knows). Don't offer to remember things.`;
    default:
      return 'Not saved: there was nothing to keep.';
  }
}

/** The line Hugo adds the first time he keeps something for someone (once per person). */
const FIRST_LINE: Record<HugoLang, (name: string) => string> = {
  en: (n) => `I’ll keep that in “What ${n} knows”. You can change or remove it there anytime.`,
  es: (n) => `Lo guardo en «Lo que ${n} sabe». Puedes cambiarlo o borrarlo ahí cuando quieras.`,
  tr: (n) => `Bunu “${n} neler biliyor” bölümünde saklıyorum. İstediğin zaman oradan değiştirebilir ya da silebilirsin.`,
  ht: (n) => `M ap kenbe sa nan “Sa ${n} konnen”. Ou ka chanje l oswa efase l la nenpòt lè.`,
  pt: (n) => `Vou guardar isso em “O que ${n} sabe”. Você pode mudar ou apagar ali quando quiser.`,
  uk: (n) => `Я збережу це в розділі «Що знає ${n}». Змінити чи видалити можна там будь-коли.`,
};
export const memoryFirstLine = (lang: HugoLang, name: string): string => FIRST_LINE[lang](name);

/** At most this many saves in one answer (a long story is not 20 facts). */
const SAVES_PER_ANSWER = 3;

const significant = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);

/** The facts a "forget …" names: the same words, else the ones that hold every word of it. */
export function factsMatching<T extends { text: string }>(facts: T[], words: string): T[] {
  const exact = facts.filter((f) => hugoMemorySameText(f.text, words));
  if (exact.length) return exact;
  const want = significant(words);
  if (!want.length) return [];
  return facts.filter((f) => {
    const have = new Set(significant(f.text));
    return want.every((w) => have.has(w));
  });
}

export interface HugoMemoryTurnResult {
  reply: string;
  /** The answer payload's additions: what was kept (the chip, with Undo), how many forgotten, and whether this was the first time. */
  fields: { remembered?: HugoRemembered[]; forgot?: number; memoryFirst?: true };
}

export interface HugoMemoryTurn {
  /** answerWithModel's `memory`: the facts' words — undefined when memory is off. */
  memory: string[] | undefined;
  /** remember_fact and forget_fact — none when memory is off. */
  tools: AssistantTool[];
  /** After the answer: the facts marked used, and what this answer kept or forgot. */
  finish: (reply: string) => Promise<HugoMemoryTurnResult>;
}

/**
 * One question's memory (routes/hugo answerAsk, the model path only): the
 * person's facts for the prompt and the two tools — when their memory is on.
 */
export async function hugoMemoryTurn(user: MemoryOwner, opts: { name: string; lang: HugoLang; now?: Date }): Promise<HugoMemoryTurn> {
  const now = opts.now ?? new Date();
  if (!(await memoryOnFor(user.id))) return { memory: undefined, tools: [], finish: async (reply) => ({ reply, fields: {} }) };
  let facts = await hugoMemoryFor(user.id);
  const inPrompt = facts.map((f) => f.id);
  const remembered: HugoRemembered[] = [];
  let forgot = 0;
  let first = false;
  let attempts = 0;

  const remember: AssistantTool = {
    key: 'MEMORY_REMEMBER',
    name: 'remember_fact',
    description: [
      `Keep one short fact the person just told you about themselves, so you can help them better next time: a preference (shifts, sites, language, how they like answers), their availability, how they get to work, or something about their own work. They can see and remove it in What ${opts.name} knows.`,
      'Call it only when they tell you something about themselves that is worth keeping, or ask you to remember it — never for what you read in their records, and never for a one-off question.',
      `Write it in their words, in the first person ("I prefer morning shifts"), one fact, ${HUGO_MEMORY_TEXT_MAX} characters at most.`,
      'Never keep: ID, Social Security, bank or card numbers, passwords or contact details; health, medical, pregnancy or disability; religion; immigration or visa status; sexual orientation or gender identity; a criminal record; union membership; anything about another person. If a fact mixes a useful part with a sensitive reason, keep only the useful part ("I can\'t work Sundays", not why).',
      'If it says not saved, tell them plainly and do not try again with the same words.',
    ].join(' '),
    input: {
      properties: {
        text: { type: 'string', description: 'The fact, in the first person, in their words.' },
        kind: { type: 'string', enum: [...HUGO_MEMORY_KINDS], description: 'PREFERENCE, AVAILABILITY (when they can or cannot work), TRAVEL (how they get to work), WORK (their own job), or OTHER.' },
      },
      required: ['text', 'kind'],
    },
    run: async (args) => {
      // A few saves per answer, and a few tries: a refusal is not retried in a loop.
      if (remembered.length >= SAVES_PER_ANSWER || ++attempts > SAVES_PER_ANSWER * 2) return { reply: `Not saved: at most ${SAVES_PER_ANSWER} things per answer.`, linkUrl: null };
      const out = await saveHugoMemory(user, { text: String(args?.text ?? ''), kind: typeof args?.kind === 'string' ? args.kind : 'OTHER', source: 'TOLD' });
      if (!out.ok) return { reply: refusedForModel(out.reason, opts.name), linkUrl: null };
      if (out.existing) return { reply: 'Already kept — nothing new saved. No need to mention it.', linkUrl: null };
      remembered.push({ id: out.fact.id, text: out.fact.text });
      facts = [out.fact, ...facts];
      first ||= out.first;
      // Kept already: the trail line is best-effort, never a reason to say "not saved".
      await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.memory.saved', entityType: 'User', entityId: user.id, metadata: { kind: out.fact.kind, channel: 'app' } }).catch((err: unknown) =>
        console.warn('[hugo memory] trail line not written:', err instanceof Error ? err.message : err),
      );
      return { reply: 'Saved. Acknowledge it in a few words; don’t repeat the whole fact.', linkUrl: null };
    },
  };

  const forget: AssistantTool = {
    key: 'MEMORY_FORGET',
    name: 'forget_fact',
    description: `Forget something they told you before, when they ask you to (or say it is no longer true). "fact" is the fact as you were given it, or words that pick it out. Forgetting everything is done in What ${opts.name} knows, not here.`,
    input: {
      properties: { fact: { type: 'string', description: 'The fact as you were given it, or words that pick it out.' } },
      required: ['fact'],
    },
    run: async (args) => {
      const words = String(args?.fact ?? '').trim();
      const hits = factsMatching(facts, words);
      if (!hits.length) return { reply: `Nothing kept matches that. If they want to see what you keep, point them to What ${opts.name} knows.`, linkUrl: null };
      if (hits.length > 1) {
        return { reply: `That matches ${hits.length} things: ${hits.map((h, i) => `${i + 1}) "${h.text}"`).join(' ')}. Ask which one they mean.`, linkUrl: null };
      }
      const hit = hits[0]!;
      await removeHugoMemory(user, hit.id, 'chat');
      facts = facts.filter((f) => f.id !== hit.id);
      const undone = remembered.findIndex((r) => r.id === hit.id);
      if (undone >= 0) remembered.splice(undone, 1);
      else forgot += 1;
      await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.memory.forgot', entityType: 'User', entityId: user.id, metadata: { kind: hit.kind, channel: 'app' } });
      return { reply: 'Forgotten. Say so in a few words.', linkUrl: null };
    },
  };

  return {
    memory: facts.map((f) => f.text),
    tools: [remember, forget],
    finish: async (reply) => {
      await touchUsed(user.id, inPrompt.filter((id) => facts.some((f) => f.id === id)), now);
      const fields: HugoMemoryTurnResult['fields'] = {};
      if (remembered.length) fields.remembered = remembered;
      if (forgot) fields.forgot = forgot;
      if (first && remembered.length) {
        fields.memoryFirst = true;
        reply = reply ? `${reply}\n\n${memoryFirstLine(opts.lang, opts.name)}` : memoryFirstLine(opts.lang, opts.name);
      }
      return { reply, fields };
    },
  };
}
