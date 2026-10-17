import type { Prisma, PrismaClient } from '@prisma/client';
import { termsIn, type TermKey } from '@alto-people/shared';
import { ALTO_TENANT_ID } from './tenant.js';
import { loadTenantProfile } from './tenantProfile.js';
import { toWaLang, type WaLang } from './whatsappContent.js';

/**
 * AI disclosure, by default. Every message or change an agent causes ends
 * with one line, in the person's language, saying that an AI agent did it
 * and who answers for it (the agent's owner on the registry record). The
 * in-app record of the same message carries the agent's id (byAgentId) so
 * the screens can badge it.
 *
 *   withDisclosure(text, { agentName, ownerName, lang })   the text with the line
 *   discloserFor(db, agent)                                 the owner looked up once; a
 *                                                           function the sender calls per text
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface DisclosureOpts {
  agentName: string;
  /** Who answers for the agent; null when nobody is on file (the line then names the tenant's word for the manager). */
  ownerName: string | null;
  lang: WaLang;
  /** The tenant's words (termsIn), for the fallback when no owner is on file. */
  terms?: Pick<Record<TermKey, string>, 'manager'>;
}

const DEFAULT_MANAGER: Record<WaLang, string> = { en: 'supervisor', es: 'supervisor', tr: 'süpervizör' };

/** The one trailing line. */
export function disclosureLine(o: DisclosureOpts): string {
  const manager = (o.terms?.manager ?? DEFAULT_MANAGER[o.lang]).toLowerCase();
  if (o.lang === 'es') {
    return o.ownerName
      ? `Enviado por ${o.agentName}, un agente de IA — ${o.ownerName} responde por él.`
      : `Enviado por ${o.agentName}, un agente de IA — tu ${manager} responde por él.`;
  }
  if (o.lang === 'tr') {
    return o.ownerName
      ? `${o.agentName} tarafından gönderildi; bir yapay zeka ajanıdır — ondan ${o.ownerName} sorumludur.`
      : `${o.agentName} tarafından gönderildi; bir yapay zeka ajanıdır — ondan ${manager} sorumludur.`;
  }
  return o.ownerName
    ? `Sent by ${o.agentName}, an AI agent — ${o.ownerName} answers for it.`
    : `Sent by ${o.agentName}, an AI agent — your ${manager} answers for it.`;
}

/** The text with the disclosure as its last line. Idempotent: a text that already ends with it is left alone. */
export function withDisclosure(text: string, o: DisclosureOpts): string {
  const line = disclosureLine(o);
  const body = text.trimEnd();
  if (body.endsWith(line)) return body;
  return body ? `${body}\n\n${line}` : line;
}

/** The owner's name as the registry shows it: the person's name, else their email. */
export async function ownerNameOf(db: Db, ownerUserId: string | null | undefined): Promise<string | null> {
  if (!ownerUserId) return null;
  const u = await db.user.findUnique({ where: { id: ownerUserId }, select: { email: true, associate: { select: { firstName: true, lastName: true } } } });
  if (!u) return null;
  const full = u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '';
  return full || u.email;
}

/** A user's language for a message, English when unset. */
export async function userLang(db: Db, userId: string | null | undefined): Promise<WaLang> {
  if (!userId) return 'en';
  const u = await db.user.findUnique({ where: { id: userId }, select: { language: true } });
  return toWaLang(u?.language);
}

/** An associate's language: their account's, English when they have none yet. */
export async function associateLang(db: Db, associateId: string | null | undefined): Promise<WaLang> {
  if (!associateId) return 'en';
  const u = await db.user.findFirst({ where: { associateId, deletedAt: null }, select: { language: true } });
  return toWaLang(u?.language);
}

export interface Discloser {
  /** The text with the line, in `lang` (the agent's default language when omitted). */
  (text: string, lang?: WaLang): string;
  agentName: string;
  ownerName: string | null;
  /** The agent's Worker id, for the record's byAgentId. */
  byAgentId: string;
  line: (lang?: WaLang) => string;
}

/** Everything a sender needs, resolved once per agent: the owner and the tenant's words. */
export async function discloserFor(
  db: Db,
  agent: { workerId: string; name: string; ownerUserId: string | null; tenantId: string | null },
  defaultLang: WaLang = 'en',
): Promise<Discloser> {
  const tenantId = agent.tenantId ?? ALTO_TENANT_ID;
  const [ownerName, profile] = await Promise.all([ownerNameOf(db, agent.ownerUserId), loadTenantProfile(tenantId)]);
  const opts = (lang: WaLang): DisclosureOpts => ({ agentName: agent.name, ownerName, lang, terms: termsIn(profile, lang) });
  const fn = ((text: string, lang: WaLang = defaultLang) => withDisclosure(text, opts(lang))) as Discloser;
  fn.agentName = agent.name;
  fn.ownerName = ownerName;
  fn.byAgentId = agent.workerId;
  fn.line = (lang: WaLang = defaultLang) => disclosureLine(opts(lang));
  return fn;
}
