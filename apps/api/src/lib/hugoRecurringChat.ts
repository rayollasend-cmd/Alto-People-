import {
  HUGO_RECURRING_CADENCES,
  HUGO_RECURRING_WHATS,
  HugoTaskCreateInputSchema,
  type HugoRecurringCadence,
  type HugoRecurringWhat,
  type HugoTaskCreate,
  type HugoTaskOffer,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { modelAvailable, type AssistantTool } from './assistantModel.js';
import { intentsFor, normalizeHugoText, type HugoContext } from './hugo.js';
import { REGISTRY_WHATS, prepareRecurring, recurringWhatsFor } from './hugoRecurring.js';
import { RECURRING_CHAT, scheduleLabel, whatList } from './hugoRecurringCopy.js';
import type { TaskTurn } from './hugoTaskChat.js';
import type { HugoLang } from './hugoWorkCopy.js';
import { companyWorkweek } from './timeAnomalies.js';

/**
 * Asking for a brief on a schedule, in the chat (lib/hugoRecurring):
 * "every Friday tell me my hours", "each morning tell me who's short",
 * "remind me every day at 7 of my next shift". Deterministic, like the
 * other task offers (lib/hugoTaskChat): the words need a cadence AND a
 * request ("tell me", "remind me", "avísame", "hatırlat"…) — "do I work
 * every Friday?" is a question, not a brief. The answer is a Start card;
 * nothing is set up until the person taps it. With a model on, phrasings
 * the rules miss reach the same card through the `offer_recurring` tool.
 */

type Parsed = { cadence: HugoRecurringCadence; weekday: number | null };
type Part = 'morning' | 'afternoon' | 'evening' | 'night' | null;

// Every pattern runs on normalizeHugoText (lower case, no accents, ı → i).
// Cyrillic letters are not \w, so the Ukrainian patterns carry no \b.
const DAY_WORDS: Array<[RegExp, number]> = [
  [/^(sun|sunday|domingo|pazar|dimanch|неділ)/, 0],
  [/^(mon|monday|lunes|pazartesi|segunda|lendi|понеділ)/, 1],
  [/^(tue|tues|tuesday|martes|sali|terca|madi|вівтор)/, 2],
  [/^(wed|wednesday|miercoles|carsamba|quarta|mekredi|серед)/, 3],
  [/^(thu|thur|thurs|thursday|jueves|persembe|quinta|jedi|четвер)/, 4],
  [/^(fri|friday|viernes|cuma|sexta|vandredi|п.ятниц)/, 5],
  [/^(sat|saturday|sabado|cumartesi|samdi|субот)/, 6],
];
const dayOf = (word: string): number | null => {
  // Longest names first where one is the start of another (pazar/pazartesi, cuma/cumartesi).
  if (/^cumartesi/.test(word)) return 6;
  if (/^pazartesi/.test(word)) return 1;
  for (const [re, n] of DAY_WORDS) if (re.test(word)) return n;
  return null;
};

const WEEKDAYS =
  /\b(every weekday|each weekday|weekdays|on weekdays|monday (to|through|thru) friday|mon-fri|entre semana|dias de semana|dias laborables|de lunes a viernes|hafta ici|dias uteis|de segunda a sexta|jou lasemen|chak jou travay)\b|щобудн|у будні|по буднях/;
const WEEKLY_ON = [
  /\b(?:every|each|on)\s+(sun|mon|tues?|wed|thu(?:rs?)?|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/,
  /\b(sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\b/,
  /\b(?:cada|todos los|los)\s+(domingo|lunes|martes|miercoles|jueves|viernes|sabado)s?\b/,
  /\bher\s+(pazartesi|pazar|sali|carsamba|persembe|cumartesi|cuma)\b/,
  /\b(pazartesi|pazar|sali|carsamba|persembe|cumartesi|cuma)(?:lari|leri)\b/,
  /\b(?:todo|toda|todos os|todas as|cada|aos|as)\s+(domingo|segunda|terca|quarta|quinta|sexta|sabado)s?(?:-feiras?)?\b/,
  /\bchak\s+(dimanch|lendi|madi|mekredi|jedi|vandredi|samdi)\b/,
  /кожн\S*\s+(неділ|понеділ|вівтор|серед|четвер|п.ятниц|субот)/,
];
const UK_EVERY_DAY: Array<[RegExp, number]> = [
  [/щонеділі/, 0],
  [/щопонеділка/, 1],
  [/щовівторка/, 2],
  [/щосереди/, 3],
  [/щочетверга/, 4],
  [/щоп.ятниці/, 5],
  [/щосуботи/, 6],
];
const WEEKLY = /\b(every week|each week|weekly|once a week|cada semana|semanal\w*|todas las semanas|una vez (a|por) semana|her hafta|haftalik|haftada bir|toda semana|todas as semanas|semanalmente|uma vez por semana|chak semen|chak semenn)\b|щотижня|кожного тижня|раз на тиждень/;
const DAILY =
  /\b(every ?day|each day|daily|every single day|(every|each) (morning|evening|night|afternoon)|cada (dia|manana|noche|tarde)|todos los dias|todas las (mananas|noches|tardes)|diari\w*|a diario|her ?gun|her (sabah|aksam|gece)|gunluk|todo dia|todos os dias|toda (manha|noite|tarde)|todas as (manhas|noites|tardes)|diariamente|chak (jou|maten|aswe|swa)|tou le jou|chak lannwit)\b|щодня|щоранку|щовечора|кожного (дня|ранку|вечора)|щоночі/;

/** Asking for something, not asking a question. */
const REQUEST =
  /\b(tell me|remind me|send me|let me know|text me|ping me|notify me|update me|show me|give me|brief me|keep me posted|alert me|dime|digame|avisame|recuerdame|recordame|mandame|enviame|informame|hazme saber|mantenme al tanto|soyle|soyler misin|hatirlat\w*|bildir\w*|gonder\w*|haber ver\w*|me (diga|diz|avise|avisa|lembre|lembra|mande|manda|envie|envia|informe|informa)|di m|fe m konnen|raple m|voye ban m|voye pou mwen|fe m sonje)\b|нагад|скажи|повідомл|надсила|надішли|розкажи/;

const MY_HOURS =
  /\b(my hours|hours (i('ve| have)? worked|worked|this week|so far)|how many hours|mis horas|cuantas horas|horas trabajadas|saatlerim\w*|kac saat|calistigim saat\w*|minhas horas|quantas horas|konbyen edtan|edtan mwen)\b|мої години|моїх годин|скільки годин/;

const PART: Array<[RegExp, Exclude<Part, null>]> = [
  [/\b(morning|mornings|manana|mananas|sabah|manha|manhas|maten)\b|ранк|вранці/, 'morning'],
  [/\b(afternoon|afternoons|tarde|tardes|ogleden sonra|apremidi)\b|пообід|по обіді/, 'afternoon'],
  [/\b(evening|evenings|aksam\w*|aswe|swa)\b|вечор|ввечері/, 'evening'],
  [/\b(night|nights|tonight|noche|noches|gece|noite|noites|lannwit)\b|ноч/, 'night'],
];
const PART_DEFAULT: Record<Exclude<Part, null>, string> = { morning: '07:00', afternoon: '15:00', evening: '18:00', night: '20:00' };

function cadenceOf(t: string): Parsed | null {
  if (WEEKDAYS.test(t)) return { cadence: 'WEEKDAYS', weekday: null };
  for (const re of WEEKLY_ON) {
    const m = re.exec(t);
    const day = m?.[1] ? dayOf(m[1]) : null;
    if (day !== null) return { cadence: 'WEEKLY', weekday: day };
  }
  for (const [re, n] of UK_EVERY_DAY) if (re.test(t)) return { cadence: 'WEEKLY', weekday: n };
  if (WEEKLY.test(t)) return { cadence: 'WEEKLY', weekday: -1 };
  if (DAILY.test(t)) return { cadence: 'DAILY', weekday: null };
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "at 7", "7am", "16:00", "a las 7 de la tarde", "saat 7", "às 7h30" → HH:MM; a part of the day sets AM/PM and the default. */
export function timeOf(t: string, part: Part): string | null {
  const mer = (s: string | undefined) => (s ? (s.replace(/[^ap]/g, '').startsWith('p') ? 'pm' : 'am') : null);
  let h: number | null = null;
  let m = 0;
  let meridiem: 'am' | 'pm' | null = null;
  const withMinutes = /\b(\d{1,2})[:.h](\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/.exec(t);
  const withMeridiem = /\b(\d{1,2})\s*(a\.?\s?m\b\.?|p\.?\s?m\b\.?)/.exec(t);
  const afterWord = /(?:\bat|\ba las|\ba la|\bas|\bsaat|\ba|(?:^|\s)о|(?:^|\s)об)\s+(\d{1,2})h?(?!\d)/.exec(t);
  if (withMinutes) {
    h = Number(withMinutes[1]);
    m = Number(withMinutes[2]);
    meridiem = mer(withMinutes[3]);
  } else if (withMeridiem) {
    h = Number(withMeridiem[1]);
    meridiem = mer(withMeridiem[2]);
  } else if (afterWord) {
    h = Number(afterWord[1]);
  }
  if (h === null) return null;
  if (h > 23 || m > 59) return null;
  if (meridiem) {
    if (h > 12) return null;
    if (h === 12) h = meridiem === 'pm' ? 12 : 0;
    else if (meridiem === 'pm') h += 12;
  } else if (h <= 12) {
    if (part === 'afternoon' || part === 'evening' || part === 'night') {
      if (h < 12) h += 12;
    } else if (part !== 'morning' && h >= 1 && h <= 6) {
      // "at 5" with no morning in it: five in the afternoon.
      h += 12;
    }
  }
  return `${pad(h)}:${pad(m)}`;
}

/**
 * Words the registry (en/es/tr) doesn't reach: a Turkish possessive
 * ("vardiyamı"), and Portuguese, Haitian Creole and Ukrainian.
 */
const MORE_WORDS: Partial<Record<HugoRecurringWhat, RegExp>> = {
  SCHEDULE: /\b(vardiya\w*|turnos?|escala|chif|ore)\b|змін|графік/,
  PAYDAY: /\b(pagamento|salario|peman|lajan)\b|виплат|зарплат/,
  RIDE: /\b(carona|woulib|transpo)\b|поїздк|автобус|трансфер/,
  RENEW: /\b(belge\w*|documentos?|dokiman)\b|документ/,
  COVERAGE: /\b(eksik\w*|falta gente|manke moun)\b|бракує|покритт/,
  DESK: /\b(bekleyen\w*|esperando por mim)\b|чекає на мене/,
};

/** What the person wants repeated: their hours, or one of the registry's answers open to them. */
function whatOf(t: string, user: SessionUser, ctx: HugoContext): HugoRecurringWhat | null {
  if (user.associateId && MY_HOURS.test(t)) return 'MY_HOURS';
  const open = intentsFor(ctx).filter((i) => (REGISTRY_WHATS as readonly string[]).includes(i.key));
  const hit = open.find((i) => i.match(t)) ?? open.find((i) => MORE_WORDS[i.key as HugoRecurringWhat]?.test(t));
  return hit ? (hit.key as HugoRecurringWhat) : null;
}

/** A chat turn asking for a brief on a schedule, or null when the words ask for something else. */
export async function recurringTurn(text: string, user: SessionUser, ctx: HugoContext, lang: HugoLang, now: Date = new Date()): Promise<TaskTurn | null> {
  // Briefs are set up in the app (their Start card, their Tasks tab).
  if (ctx.channel !== 'app') return null;
  const t = normalizeHugoText(text);
  const when = cadenceOf(t);
  if (!when || !REQUEST.test(t)) return null;

  let what = whatOf(t, user, ctx);
  if (!what) {
    if (!modelAvailable()) {
      const can = (await recurringWhatsFor(user, now)).filter((w) => w !== 'ASK');
      return { intent: 'TASK_RECURRING', reply: can.length ? RECURRING_CHAT.noModel(lang, whatList(can, lang)) : RECURRING_CHAT.unavailable(lang), offers: [] };
    }
    what = 'ASK';
  }
  const part = PART.find(([re]) => re.test(t))?.[1] ?? null;
  const time = timeOf(t, part) ?? (part ? PART_DEFAULT[part] : what === 'MY_HOURS' ? '17:00' : '08:00');
  // "Every week" with no day: the week's last day for hours and pay, its first for the rest.
  const weekday = when.cadence === 'WEEKLY' ? (when.weekday !== null && when.weekday >= 0 ? when.weekday : what === 'MY_HOURS' || what === 'PAYDAY' ? 5 : companyWorkweek().weekStartsOn) : null;
  const task = {
    kind: 'RECURRING' as const,
    what,
    cadence: when.cadence,
    time,
    ...(weekday !== null ? { weekday } : {}),
    ...(what === 'ASK' ? { question: text.trim().slice(0, 300) } : {}),
  };
  try {
    const prep = await prepareRecurring(user, HugoTaskCreateInputSchema.parse(task) as Extract<HugoTaskCreate, { kind: 'RECURRING' }>, now);
    const label = scheduleLabel({ cadence: when.cadence, weekday, time }, lang);
    return { intent: 'TASK_RECURRING', reply: RECURRING_CHAT.offer(lang, what, label), offers: [{ task, subject: prep.subject }] };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    if (err.code === 'too_many_recurring') return { intent: 'TASK_RECURRING', reply: RECURRING_CHAT.tooMany(lang, env.HUGO_RECURRING_MAX_PER_USER), offers: [] };
    return { intent: 'TASK_RECURRING', reply: RECURRING_CHAT.unavailable(lang), offers: [] };
  }
}

/**
 * The model's way to the same Start card, for phrasings the rules miss:
 * it records an offer only — nothing is set up until the person taps Start.
 * At most two offers an answer.
 */
export function offerRecurringTool(user: SessionUser, offers: HugoTaskOffer[], now: Date = new Date()): AssistantTool {
  return {
    key: 'OFFER_RECURRING',
    name: 'offer_recurring',
    description:
      'Offer to send the person something on a repeating schedule, when they ask to be told or reminded of something every day, every weekday or on a day each week ("every Friday tell me my hours", "each morning tell me who is short"). This only shows a Start card; nothing is set up until they tap Start. Not for a one-time question. what: SCHEDULE (their next shifts), PAYDAY, RIDE, RENEW (documents to renew), DESK (what waits on their desk), COVERAGE (where their sites are short), DRIVER_NEXT_RUN, MY_HOURS (hours worked this week and still scheduled), or ASK with their question in `question` for anything else.',
    input: {
      properties: {
        what: { type: 'string', enum: [...HUGO_RECURRING_WHATS] },
        cadence: { type: 'string', enum: [...HUGO_RECURRING_CADENCES] },
        weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'WEEKLY only: 0 = Sunday … 6 = Saturday.' },
        time: { type: 'string', description: 'HH:MM, 24-hour, on their clock (e.g. 07:00, 16:30).' },
        question: { type: 'string', description: 'ASK only: the question to answer each time, in their words.' },
      },
      required: ['what', 'cadence', 'time'],
    },
    run: async (args) => {
      if (offers.length >= 2) return { reply: 'Two offers are already on the screen; do not make another.', linkUrl: null };
      const parsed = HugoTaskCreateInputSchema.safeParse({ ...(args ?? {}), kind: 'RECURRING' });
      if (!parsed.success || parsed.data.kind !== 'RECURRING') return { reply: 'That offer is not valid: check what, cadence (DAILY, WEEKDAYS, WEEKLY with weekday) and time (HH:MM).', linkUrl: null };
      try {
        const prep = await prepareRecurring(user, parsed.data, now);
        const { kind: _k, ...rest } = parsed.data;
        offers.push({ task: { kind: 'RECURRING', ...rest }, subject: prep.subject });
        return { reply: 'A Start card is on the screen. Nothing is set up until they tap Start; say that in one short sentence, with when it will come.', linkUrl: null };
      } catch (err) {
        if (err instanceof HttpError) return { reply: `Could not offer it: ${err.message}`, linkUrl: null };
        throw err;
      }
    },
  };
}
