import type { TenantModule } from '@alto-people/shared';
import { hasCapability, type Role } from '@alto-people/shared';
import type { WaLang } from './whatsappContent.js';

/**
 * Hugo's intent registry (agent families step 3;
 * docs/agent-families-investigation.md §4.5).
 *
 *   Every intent names the capability it routes to (a family capability
 *   from the catalog, or null for Hugo's own self-service answers), who may
 *   ask it, on which channel, the module it needs and the words that reach
 *   it in English, Spanish and Turkish. Order is precedence: the first match
 *   wins, and nothing matched falls to the channel's fallback (WhatsApp: hand
 *   the question to a person; the app: what Hugo can do).
 *
 *   An intent whose module is off is never offered and never matched: it is
 *   absent from the help text, not refused (owner's decision 2026-10-13).
 */

export type HugoIntentKey =
  | 'OPT_OUT'
  | 'OPT_IN'
  | 'LANGUAGE'
  | 'WHO'
  | 'HELP'
  | 'DESK'
  | 'COVERAGE'
  | 'PAYDAY'
  | 'RIDE'
  | 'SCHEDULE'
  | 'HANDOFF';

export type HugoAudience = 'associate' | 'manager' | 'admin';
export type HugoChannel = 'whatsapp' | 'app';

export interface HugoIntent {
  key: HugoIntentKey;
  /** The catalog capability it routes to; null = Hugo's own answer from the person's records. */
  capability: string | null;
  audiences: readonly HugoAudience[];
  channels: readonly HugoChannel[];
  requiresModule: TenantModule | null;
  /** Matched against the normalized text (lower case, no accents, ı → i). */
  match: (t: string) => boolean | { lang: WaLang };
  /** What the help text calls it, and a question that reaches it. Null: not listed (housekeeping). */
  help: Record<WaLang, { label: string; example: string }> | null;
}

export const normalizeHugoText = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .trim();

const STAFF: readonly HugoAudience[] = ['manager', 'admin'];
const EVERYONE: readonly HugoAudience[] = ['associate', 'manager', 'admin'];

const OPT_OUT = /^\s*(stop|baja|dur|unsubscribe|cancelar|salir|parar|iptal)\b/;
const OPT_IN = /^\s*(start|alta|basla|unstop|empezar|activar)\b/;
const LANGS: Array<[RegExp, WaLang]> = [
  [/\b(english|ingles)\b/, 'en'],
  [/\b(espanol|spanish|castellano)\b/, 'es'],
  [/\b(turkce|turkish|turk)\b/, 'tr'],
];
// "Who are you?" in three languages: the answer always says the product and that he is an AI.
const WHO = /\b(who are you|what are you|are you (a |an )?(bot|robot|ai|human|real person|person)|is this a (bot|robot|person)|quien eres|que eres|eres (un|una) (bot|robot|persona|humano|ia)|kimsin|nesin|sen kimsin|bot musun|robot musun|insan misin)\b/;
const HELP = /\b(help|what can you do|what do you do|ayuda|ayudame|que puedes hacer|que haces|yardim|neler yapabilirsin|ne yapabilirsin)\b/;
const DESK = /\b(waiting on me|my desk|my queue|to approve|approvals?|proposals?|pending|what are you doing|que estas haciendo|pendientes?|aprobar|bekleyen|bekliyor|onay\w*|ne yapiyorsun)\b/;
const COVERAGE = /\b(coverage|covered|short|shortfall|staffing|staffed|understaffed|gaps?|cobertura|faltan?|falta gente|personal|eksik|kadro)\b/;
const PAYDAY = /\b(pay ?day|paid|pay\b|paycheck|paystub|cobr\w*|pago|pagan|sueldo|nomina|maas|odeme|para)\b/;
const RIDE = /\b(ride|van|pick ?up|bus|shuttle|viaje|camioneta|recog\w*|transporte|servis|arac|minibus|ulasim)\b/;
const SCHEDULE = /\b(schedule|shift|shifts|work|working|hours|horario|turno|turnos|trabajo|vardiya|calis\w*|program\w*|mesai)\b/;

const h = (en: [string, string], es: [string, string], tr: [string, string]) => ({
  en: { label: en[0], example: en[1] },
  es: { label: es[0], example: es[1] },
  tr: { label: tr[0], example: tr[1] },
});

export const HUGO_INTENTS: readonly HugoIntent[] = [
  { key: 'OPT_OUT', capability: null, audiences: ['associate'], channels: ['whatsapp'], requiresModule: null, match: (t) => OPT_OUT.test(t), help: null },
  { key: 'OPT_IN', capability: null, audiences: ['associate'], channels: ['whatsapp'], requiresModule: null, match: (t) => OPT_IN.test(t), help: null },
  {
    key: 'LANGUAGE',
    capability: null,
    audiences: ['associate'],
    channels: ['whatsapp'],
    requiresModule: null,
    match: (t) => {
      if (t.split(/\s+/).length > 4) return false;
      for (const [re, lang] of LANGS) if (re.test(t)) return { lang };
      return false;
    },
    help: null,
  },
  { key: 'WHO', capability: null, audiences: EVERYONE, channels: ['whatsapp', 'app'], requiresModule: null, match: (t) => WHO.test(t), help: null },
  {
    key: 'HELP',
    capability: null,
    audiences: STAFF,
    channels: ['app'],
    requiresModule: null,
    match: (t) => HELP.test(t),
    help: null,
  },
  {
    key: 'DESK',
    capability: null,
    audiences: STAFF,
    channels: ['app'],
    requiresModule: null,
    match: (t) => DESK.test(t),
    help: h(['What waits on your desk', 'What is waiting on me?'], ['Lo que espera en tu escritorio', '¿Qué está pendiente para mí?'], ['Masanda bekleyenler', 'Bende ne bekliyor?']),
  },
  {
    key: 'COVERAGE',
    capability: 'coverage.forecast',
    audiences: STAFF,
    channels: ['app'],
    requiresModule: 'scheduling',
    match: (t) => COVERAGE.test(t),
    help: h(['Coverage for the next 7 days', 'Where are we short this week?'], ['Cobertura de los próximos 7 días', '¿Dónde nos falta gente esta semana?'], ['Önümüzdeki 7 günün kadrosu', 'Bu hafta nerede eksik var?']),
  },
  {
    key: 'PAYDAY',
    capability: null,
    audiences: ['associate'],
    channels: ['whatsapp', 'app'],
    requiresModule: null,
    match: (t) => PAYDAY.test(t),
    help: h(['Your next payday', 'When is payday?'], ['Tu próximo día de pago', '¿Cuándo me pagan?'], ['Bir sonraki maaş günün', 'Maaş ne zaman?']),
  },
  {
    key: 'RIDE',
    capability: null,
    audiences: ['associate'],
    channels: ['whatsapp', 'app'],
    requiresModule: 'transportation',
    match: (t) => RIDE.test(t),
    help: h(['Your next ride', 'What time is my ride?'], ['Tu próximo viaje', '¿A qué hora es mi viaje?'], ['Bir sonraki servisin', 'Servisim kaçta?']),
  },
  {
    key: 'SCHEDULE',
    capability: null,
    audiences: ['associate'],
    channels: ['whatsapp', 'app'],
    requiresModule: 'scheduling',
    match: (t) => SCHEDULE.test(t),
    help: h(['Your next shifts', "What's my schedule?"], ['Tus próximos turnos', '¿Cuál es mi horario?'], ['Sonraki vardiyaların', 'Programım ne?']),
  },
];

export interface HugoContext {
  channel: HugoChannel;
  audience: HugoAudience;
  /** Is this module on for the tenant? */
  moduleOn: (m: TenantModule) => boolean;
  /** Is this catalog capability running for the tenant (agent and capability on)? */
  capabilityOn: (key: string) => boolean;
}

/** The intents open to this person on this channel, in precedence order. */
export function intentsFor(ctx: HugoContext): HugoIntent[] {
  return HUGO_INTENTS.filter(
    (i) =>
      i.channels.includes(ctx.channel) &&
      i.audiences.includes(ctx.audience) &&
      (!i.requiresModule || ctx.moduleOn(i.requiresModule)) &&
      (!i.capability || ctx.capabilityOn(i.capability)),
  );
}

/**
 * The first intent open to this person that the text reaches; HANDOFF on
 * WhatsApp and HELP in the app when none does.
 */
export function detectHugoIntent(text: string, ctx: HugoContext): { intent: HugoIntentKey; lang?: WaLang } {
  const t = normalizeHugoText(text);
  for (const i of intentsFor(ctx)) {
    const m = i.match(t);
    if (m) return typeof m === 'object' ? { intent: i.key, lang: m.lang } : { intent: i.key };
  }
  return { intent: ctx.channel === 'whatsapp' ? 'HANDOFF' : ctx.audience === 'associate' ? 'HANDOFF' : 'HELP' };
}

/** Who is asking, by the hat they wear: admin (manage:org), manager (a desk or the org view), or an associate. */
export function hugoAudienceOf(user: { role: Role; associateId: string | null }): HugoAudience | null {
  if (hasCapability(user.role, 'manage:org')) return 'admin';
  if (hasCapability(user.role, 'manage:scheduling') || hasCapability(user.role, 'view:org')) return 'manager';
  if (user.associateId) return 'associate';
  return null;
}

/** A bare YES / NO (attendance.confirm's answer), in three languages. */
const YES = /^(yes|y|yeah|yep|si|claro|evet|tamam|ok|okay)[.!\s]*$/;
const NO = /^(no|n|nope|hayir|olmaz|yok)[.!\s]*$/;

export function detectConfirmAnswer(text: string): 'YES' | 'NO' | null {
  const t = normalizeHugoText(text);
  if (YES.test(t)) return 'YES';
  if (NO.test(t)) return 'NO';
  return null;
}
