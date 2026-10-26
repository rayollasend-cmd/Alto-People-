import { HugoTaskCreateInputSchema, type HugoTaskCreateInput, type HugoTaskOffer } from '@alto-people/shared';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { detectHugoIntent, normalizeHugoText, type HugoContext } from './hugo.js';
import { hugoTaskCounts, previewHugoTask } from './hugoTasks.js';
import type { HugoLang } from './hugoWorkCopy.js';
import { DEFAULT_TIMEZONE, addDaysInZone, localDateKey, zonedDayOfWeek } from './timezone.js';

/**
 * Handing Hugo work from the chat (lib/hugoTasks). The words reach a task
 * intent (lib/hugo); the answer is an OFFER — a card the person taps Start
 * on — never the task itself. Deterministic on purpose, with or without the
 * model: what Hugo will do for someone is never left to a guess.
 */

export interface TaskTurn {
  intent: 'TASK_LIST' | 'TASK_FIND_COVER' | 'TASK_TELL_ME_WHEN' | 'TASK_CHASE';
  reply: string;
  offers: HugoTaskOffer[];
  /** The panel opens its Tasks tab. */
  view?: 'tasks';
}

type Six = Record<HugoLang, string>;
const say = (w: Six, lang: HugoLang) => w[lang];

const WORDS = {
  offerOne: {
    en: "I can take care of that. Tap Start and carry on — I'll tell you when it's done.",
    es: 'Puedo encargarme. Toca Empezar y sigue con lo tuyo; te aviso cuando esté listo.',
    tr: 'Bununla ben ilgilenebilirim. Başlat’a dokun ve işine devam et; bitince sana haber veririm.',
    ht: 'Mwen ka okipe sa. Tape Kòmanse epi kontinye — m ap di w lè li fini.',
    pt: 'Posso cuidar disso. Toque em Começar e siga em frente — aviso quando terminar.',
    uk: 'Я можу цим зайнятися. Натисніть «Почати» і займайтеся своїм — я повідомлю, коли буде готово.',
  },
  offerPick: {
    en: 'Which one should I watch? Tap Start on it and carry on — I’ll tell you when it happens.',
    es: '¿Qué quieres que vigile? Toca Empezar y sigue con lo tuyo; te aviso cuando pase.',
    tr: 'Neyi takip edeyim? Başlat’a dokun ve işine devam et; olunca haber veririm.',
    ht: 'Kisa pou m veye? Tape Kòmanse epi kontinye — m ap di w lè sa rive.',
    pt: 'O que devo acompanhar? Toque em Começar e siga em frente — aviso quando acontecer.',
    uk: 'За чим стежити? Натисніть «Почати» і займайтеся своїм — я повідомлю, коли це станеться.',
  },
  offerCover: {
    en: "I'll ask coworkers who are free, one at a time. Your manager still approves, and you stay on the shift until then. Tap Start on the shift you need covered.",
    es: 'Preguntaré a compañeros que estén libres, uno a la vez. Tu gerente igual tiene que aprobar, y sigues en el turno hasta entonces. Toca Empezar en el turno que necesitas cubrir.',
    tr: 'Boşta olan iş arkadaşlarına tek tek soracağım. Onay yine yöneticinde; o zamana kadar vardiya sende kalır. Devretmek istediğin vardiyada Başlat’a dokun.',
    ht: 'M ap mande kòlèg ki disponib, youn apre lòt. Manadjè ou toujou dwe apwouve, epi ou rete sou chif la jiskaske sa fèt. Tape Kòmanse sou chif ou bezwen kouvri a.',
    pt: 'Vou perguntar a colegas livres, um de cada vez. Seu gerente ainda aprova, e você continua no turno até lá. Toque em Começar no turno que precisa cobrir.',
    uk: 'Я питатиму вільних колег по одному. Погоджує все одно керівник, а до того зміна лишається за вами. Натисніть «Почати» на зміні, яку треба передати.',
  },
  noShifts: {
    en: 'You have no upcoming shift I can find cover for. A shift starting in the next three hours is too soon — call off in the app so your supervisor knows.',
    es: 'No tienes un turno próximo para el que pueda buscar cobertura. Un turno que empieza en menos de tres horas es muy pronto: avisa en la app para que tu supervisor lo sepa.',
    tr: 'Devredebileceğim yaklaşan bir vardiyan yok. Üç saat içinde başlayan bir vardiya için çok geç; yöneticinin bilmesi için uygulamadan bildir.',
    ht: 'Ou pa gen yon chif k ap vini mwen ka chèche moun pou li. Yon chif ki kòmanse nan twa èdtan twò pre — avèti nan aplikasyon an pou sipèvizè ou konnen.',
    pt: 'Você não tem um turno próximo para o qual eu possa buscar cobertura. Um turno que começa nas próximas três horas é cedo demais — avise pelo app para seu supervisor saber.',
    uk: 'Немає найближчої зміни, на яку я можу шукати заміну. Зміна, що починається за три години, — це надто скоро: повідомте в застосунку, щоб керівник знав.',
  },
  nothingToWatch: {
    en: "There's nothing waiting right now that I can watch — no time-off request or document under review.",
    es: 'Ahora no hay nada pendiente que pueda vigilar: ninguna solicitud de tiempo libre ni documento en revisión.',
    tr: 'Şu an takip edebileceğim bekleyen bir şey yok; incelemede izin isteği ya da belge yok.',
    ht: 'Pa gen anyen k ap tann kounye a mwen ka veye — okenn demann konje oswa dokiman y ap revize.',
    pt: 'Não há nada pendente agora que eu possa acompanhar — nenhum pedido de folga ou documento em análise.',
    uk: 'Зараз немає нічого, за чим я можу стежити, — жодного запиту на відпустку чи документа на перевірці.',
  },
  nothingToChase: {
    en: 'No shifts that day need confirming.',
    es: 'Ningún turno de ese día necesita confirmación.',
    tr: 'O gün onay bekleyen vardiya yok.',
    ht: 'Pa gen chif jou sa a ki bezwen konfimasyon.',
    pt: 'Nenhum turno nesse dia precisa de confirmação.',
    uk: 'Того дня немає змін, які треба підтвердити.',
  },
  offerChase: {
    en: "I'll nudge everyone who hasn't confirmed, keep count, and tell you who's still out before the evening. Tap Start.",
    es: 'Recordaré a todos los que no han confirmado, llevaré la cuenta y te diré quién falta antes de la noche. Toca Empezar.',
    tr: 'Onaylamayan herkese hatırlatacağım, sayıyı tutacağım ve akşamdan önce kimin eksik olduğunu söyleyeceğim. Başlat’a dokun.',
    ht: 'M ap raple tout moun ki poko konfime, m ap konte, epi m ap di w ki moun ki manke anvan aswè. Tape Kòmanse.',
    pt: 'Vou lembrar todos que não confirmaram, acompanhar a contagem e dizer quem ainda falta antes da noite. Toque em Começar.',
    uk: 'Я нагадаю всім, хто не підтвердив, рахуватиму й до вечора скажу, кого ще бракує. Натисніть «Почати».',
  },
} satisfies Record<string, Six>;

function listReply(lang: HugoLang, working: number, needsYou: number): string {
  if (!working && !needsYou) {
    return say({ en: 'Nothing running right now. Hand me something and carry on.', es: 'Nada en marcha ahora. Pásame algo y sigue con lo tuyo.', tr: 'Şu an çalışan bir şey yok. Bana bir iş ver ve devam et.', ht: 'Anyen pa an mach kounye a. Ban m yon bagay epi kontinye.', pt: 'Nada em andamento agora. Me passe algo e siga em frente.', uk: 'Зараз нічого не виконується. Доручіть мені щось і займайтеся своїм.' }, lang);
  }
  const parts: Record<HugoLang, string[]> = { en: [], es: [], tr: [], ht: [], pt: [], uk: [] };
  if (working) {
    parts.en.push(`${working} running`);
    parts.es.push(`${working} en marcha`);
    parts.tr.push(`${working} devam ediyor`);
    parts.ht.push(`${working} an mach`);
    parts.pt.push(`${working} em andamento`);
    parts.uk.push(`виконується: ${working}`);
  }
  if (needsYou) {
    parts.en.push(`${needsYou} waiting on you`);
    parts.es.push(`${needsYou} esperando por ti`);
    parts.tr.push(`${needsYou} seni bekliyor`);
    parts.ht.push(`${needsYou} ap tann ou`);
    parts.pt.push(`${needsYou} esperando você`);
    parts.uk.push(`чекають на вас: ${needsYou}`);
  }
  const lead = { en: 'Your tasks', es: 'Tus tareas', tr: 'Görevlerin', ht: 'Travay ou yo', pt: 'Suas tarefas', uk: 'Ваші завдання' }[lang];
  return `${lead}: ${parts[lang].join(', ')}.`;
}

/** "tomorrow", "today" or a weekday in the words, as a calendar day in the zone. */
function dayAsked(t: string, tz: string, now: Date): string | null {
  if (/\b(tomorrow|manana|yarin|demen|amanha|zavtra|завтра)\b/.test(t)) return localDateKey(addDaysInZone(now, 1, tz), tz);
  if (/\b(today|tonight|hoy|bugun|jodi a|hoje|сьогодні)\b/.test(t)) return localDateKey(now, tz);
  const WEEKDAYS: Array<RegExp> = [
    /\b(sunday|domingo|pazar)\b/,
    /\b(monday|lunes|pazartesi)\b/,
    /\b(tuesday|martes|sali)\b/,
    /\b(wednesday|miercoles|carsamba)\b/,
    /\b(thursday|jueves|persembe)\b/,
    /\b(friday|viernes|cuma)\b/,
    /\b(saturday|sabado|cumartesi)\b/,
  ];
  const dow = WEEKDAYS.findIndex((re) => re.test(t));
  if (dow < 0) return null;
  for (let i = 0; i < 8; i++) {
    const d = addDaysInZone(now, i, tz);
    if (zonedDayOfWeek(d, tz) === dow) return localDateKey(d, tz);
  }
  return null;
}

async function offer(user: SessionUser, task: HugoTaskCreateInput, now: Date): Promise<HugoTaskOffer | null> {
  const subject = await previewHugoTask(user, HugoTaskCreateInputSchema.parse(task), now);
  return subject ? { task, subject } : null;
}

async function coverTurn(user: SessionUser, t: string, lang: HugoLang, now: Date): Promise<TaskTurn> {
  const shifts = await prisma.shift.findMany({
    where: { assignedAssociateId: user.associateId!, status: 'ASSIGNED', publishedAt: { not: null }, startsAt: { gt: new Date(now.getTime() + 3 * 3_600_000), lt: new Date(now.getTime() + 21 * 86_400_000) } },
    orderBy: { startsAt: 'asc' },
    take: 10,
    select: { id: true, startsAt: true, locationRel: { select: { timezone: true } } },
  });
  const tz = shifts[0]?.locationRel?.timezone ?? user.timezone ?? DEFAULT_TIMEZONE;
  const day = dayAsked(t, tz, now);
  const picked = day ? shifts.filter((s) => localDateKey(s.startsAt, s.locationRel?.timezone ?? tz) === day) : [];
  const candidates = (picked.length ? picked : shifts).slice(0, 3);
  const offers = (await Promise.all(candidates.map((s) => offer(user, { kind: 'FIND_COVER', shiftId: s.id }, now)))).filter((o): o is HugoTaskOffer => o !== null);
  return { intent: 'TASK_FIND_COVER', reply: offers.length ? say(WORDS.offerCover, lang) : say(WORDS.noShifts, lang), offers };
}

async function tellMeWhenTurn(user: SessionUser, t: string, lang: HugoLang, now: Date): Promise<TaskTurn> {
  const wants: HugoTaskCreateInput[] = [];
  if (/\b(time ?off|pto|vacation|day off|days off|leave|request|vacaciones|permiso|dia libre|izin\w*|tatil)\b/.test(t)) wants.push({ kind: 'WATCH_TIME_OFF' });
  if (/\b(paid|pay\b|paycheck|paystub|payday|check|pago|pagan|paguen|cobr\w*|sueldo|nomina|maas\w*|odeme)\b/.test(t)) wants.push({ kind: 'WATCH_PAYCHECK' });
  if (/\b(documents?|license|licence|papers?|id\b|i-?9|visa|documentos?|papeles|licencia|belge\w*|ehliyet|kimlik)\b/.test(t)) wants.push({ kind: 'WATCH_DOCUMENT' });
  if (/\b(open shifts?|extra (hours|shifts?)|more hours|pick ?up|shifts? (open|available)|turnos? (abiertos?|extra|disponibles?)|horas extra|mas horas|acik vardiya\w*|ek vardiya\w*|fazla mesai)\b/.test(t)) wants.push({ kind: 'WATCH_OPEN_SHIFTS', days: 7 });
  const asked = wants.length ? wants : ([{ kind: 'WATCH_TIME_OFF' }, { kind: 'WATCH_DOCUMENT' }, { kind: 'WATCH_PAYCHECK' }, { kind: 'WATCH_OPEN_SHIFTS', days: 7 }] as HugoTaskCreateInput[]);
  const offers = (await Promise.all(asked.map((task) => offer(user, task, now)))).filter((o): o is HugoTaskOffer => o !== null);
  if (!offers.length) return { intent: 'TASK_TELL_ME_WHEN', reply: say(WORDS.nothingToWatch, lang), offers: [] };
  return { intent: 'TASK_TELL_ME_WHEN', reply: say(offers.length === 1 ? WORDS.offerOne : WORDS.offerPick, lang), offers };
}

async function chaseTurn(user: SessionUser, t: string, lang: HugoLang, now: Date): Promise<TaskTurn> {
  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const date = dayAsked(t, tz, now) ?? undefined;
  const o = await offer(user, { kind: 'CHASE_CONFIRMATIONS', ...(date ? { date } : {}) }, now);
  return { intent: 'TASK_CHASE', reply: say(o ? WORDS.offerChase : WORDS.nothingToChase, lang), offers: o ? [o] : [] };
}

/** A chat turn that hands Hugo work, or null when the words are about something else. */
export async function hugoTaskTurn(text: string, user: SessionUser, ctx: HugoContext, lang: HugoLang, now: Date = new Date()): Promise<TaskTurn | null> {
  const { intent } = detectHugoIntent(text, ctx);
  const t = normalizeHugoText(text);
  switch (intent) {
    case 'TASK_LIST': {
      const c = await hugoTaskCounts(user.id, now);
      return { intent, reply: listReply(lang, c.working, c.needsYou), offers: [], view: 'tasks' };
    }
    case 'TASK_FIND_COVER':
      return coverTurn(user, t, lang, now);
    case 'TASK_TELL_ME_WHEN':
      return tellMeWhenTurn(user, t, lang, now);
    case 'TASK_CHASE':
      return chaseTurn(user, t, lang, now);
    default:
      return null;
  }
}
