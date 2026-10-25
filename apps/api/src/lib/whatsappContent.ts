import { PRODUCT_NAME, defaultTenantProfile, termsIn } from '@alto-people/shared';
import { getBrandingSync } from './branding.js';
import { tenantProfileSync } from './tenantProfile.js';
/**
 * What Alto says on WhatsApp, in the three languages the platform speaks.
 *
 * Meta only lets a business open a conversation with a pre-approved
 * TEMPLATE (name + language + numbered parameters); free text is allowed
 * only inside 24 hours of the associate's last message. So every outbound
 * notice has a template here — the exact text to register in WhatsApp
 * Manager under the Meta name — and the same text is rendered into the
 * message record, so what the associate saw is what the record shows.
 *
 * Parameters are positional ({{1}}, {{2}}…) because that is what Meta's
 * API takes; the `params` list names them for the person registering.
 */

export type WaLang = 'en' | 'es' | 'tr';

export type WaTemplateKey =
  | 'alto_notice'
  | 'alto_shift_assigned'
  | 'alto_shift_changed'
  | 'alto_shift_cancelled'
  | 'alto_shift_reminder'
  | 'alto_shift_reminder_plain'
  | 'alto_shift_confirm'
  | 'alto_ride_pickup'
  | 'alto_ride_near'
  | 'alto_payday'
  | 'alto_emergency';

export interface WaTemplateDef {
  key: WaTemplateKey;
  /** The template name as registered in WhatsApp Manager. */
  metaName: string;
  /** Category Meta files it under. */
  metaCategory: 'UTILITY';
  /** What each positional parameter is, in order. */
  params: string[];
  /** Brief 2-1b: brand values appended after `params` by the sender — the tenant's display name and the assistant's name. */
  brandParams?: Array<'orgName' | 'assistantName'>;
  /** Brief 2-1b: sent only when the tenant runs this module; with a fallback, that template goes instead. */
  requiresModule?: 'transportation';
  fallbackKey?: WaTemplateKey;
  description: string;
  body: Record<WaLang, string>;
}

export const WA_TEMPLATES: readonly WaTemplateDef[] = [
  {
    key: 'alto_notice',
    metaName: 'alto_notice_v2',
    brandParams: ['orgName'],
    metaCategory: 'UTILITY',
    params: ['subject', 'message'],
    description: 'Any notice that has no template of its own — the bell text, as is.',
    body: {
      en: '{{1}}\n\n{{2}}\n\nOpen the {{3}} app for details. Reply STOP to leave WhatsApp updates.',
      es: '{{1}}\n\n{{2}}\n\nAbre la app de {{3}} para ver los detalles. Responde BAJA para dejar de recibir avisos por WhatsApp.',
      tr: '{{1}}\n\n{{2}}\n\nAyrıntılar için {{3}} uygulamasını aç. WhatsApp bildirimlerini bırakmak için DUR yaz.',
    },
  },
  {
    key: 'alto_shift_assigned',
    metaName: 'alto_shift_assigned_v2',
    brandParams: ['orgName'],
    metaCategory: 'UTILITY',
    params: ['position', 'store', 'when'],
    description: 'A shift was put on their schedule.',
    body: {
      en: 'New shift: {{1}} at {{2}}, {{3}}. Tap "I\'ll be there" in the {{4}} app to confirm.',
      es: 'Nuevo turno: {{1}} en {{2}}, {{3}}. Toca "Ahí estaré" en la app de {{4}} para confirmar.',
      tr: 'Yeni vardiya: {{1}}, {{2}}, {{3}}. Onaylamak için {{4}} uygulamasında "Orada olacağım"a dokun.',
    },
  },
  {
    key: 'alto_shift_changed',
    metaName: 'alto_shift_changed_v2',
    brandParams: ['orgName'],
    metaCategory: 'UTILITY',
    params: ['position', 'store', 'when'],
    description: 'A shift on their schedule changed (time, place, or they were taken off it).',
    body: {
      en: 'Schedule change: {{1}} at {{2}} is now {{3}}. Check the {{4}} app.',
      es: 'Cambio de horario: {{1}} en {{2}} ahora es {{3}}. Revisa la app de {{4}}.',
      tr: 'Program değişikliği: {{1}}, {{2}} artık {{3}}. {{4}} uygulamasına bak.',
    },
  },
  {
    key: 'alto_shift_cancelled',
    metaName: 'alto_shift_cancelled',
    metaCategory: 'UTILITY',
    params: ['position', 'store', 'when'],
    description: 'A shift was cancelled.',
    body: {
      en: 'Cancelled: {{1}} at {{2}}, {{3}}. You do not need to come in for it.',
      es: 'Cancelado: {{1}} en {{2}}, {{3}}. No necesitas presentarte para ese turno.',
      tr: 'İptal: {{1}}, {{2}}, {{3}}. Bu vardiya için gelmen gerekmiyor.',
    },
  },
  {
    key: 'alto_shift_reminder',
    metaName: 'alto_shift_reminder',
    metaCategory: 'UTILITY',
    params: ['position', 'store', 'when'],
    description: 'The day-before reminder, with the van offer (tenants with transportation on).',
    requiresModule: 'transportation',
    fallbackKey: 'alto_shift_reminder_plain',
    body: {
      en: 'Reminder: {{1}} at {{2}} tomorrow, {{3}}. Reply RIDE if you need a van.',
      es: 'Recordatorio: {{1}} en {{2}} mañana, {{3}}. Responde VIAJE si necesitas una van.',
      tr: 'Hatırlatma: yarın {{1}}, {{2}}, {{3}}. Minibüs gerekiyorsa SERVİS yaz.',
    },
  },
  {
    key: 'alto_shift_reminder_plain',
    metaName: 'alto_shift_reminder_plain',
    metaCategory: 'UTILITY',
    params: ['position', 'site', 'when'],
    description: 'The day-before reminder without the van offer (tenants with transportation off).',
    body: {
      en: 'Reminder: {{1}} at {{2}} tomorrow, {{3}}.',
      es: 'Recordatorio: {{1}} en {{2}} mañana, {{3}}.',
      tr: 'Hatırlatma: yarın {{1}}, {{2}}, {{3}}.',
    },
  },
  {
    key: 'alto_shift_confirm',
    metaName: 'alto_shift_confirm',
    metaCategory: 'UTILITY',
    params: ['position', 'site', 'when', 'cut-off'],
    description: 'The Workforce agent asks a holder the day before whether they are coming (attendance.confirm). YES or NO by the cut-off; silence may move the shift.',
    body: {
      en: 'Are you coming to {{1}} at {{2}}, {{3}}? Reply YES or NO by {{4}}. If we do not hear from you, the shift may go to someone else.',
      es: '¿Vienes a {{1}} en {{2}}, {{3}}? Responde SÍ o NO antes de {{4}}. Si no sabemos de ti, el turno podría pasar a otra persona.',
      tr: '{{1}}, {{2}}, {{3}} vardiyana geliyor musun? {{4}} saatine kadar EVET ya da HAYIR yaz. Senden haber alamazsak vardiya başka birine verilebilir.',
    },
  },
  {
    key: 'alto_ride_pickup',
    requiresModule: 'transportation',
    metaName: 'alto_ride_pickup',
    metaCategory: 'UTILITY',
    params: ['van', 'pickup time and place'],
    description: 'Their seat is on a van: which van, when, where.',
    body: {
      en: 'Your van: {{1}}. Pickup {{2}}. Be outside a few minutes early.',
      es: 'Tu van: {{1}}. Recogida {{2}}. Sal unos minutos antes.',
      tr: 'Minibüsün: {{1}}. Alış {{2}}. Birkaç dakika erken dışarıda ol.',
    },
  },
  {
    key: 'alto_ride_near',
    requiresModule: 'transportation',
    metaName: 'alto_ride_near',
    metaCategory: 'UTILITY',
    params: ['van', 'minutes'],
    description: 'The van is a few minutes away.',
    body: {
      en: '{{1}} is about {{2}} minutes away. Please be ready.',
      es: '{{1}} está a unos {{2}} minutos. Prepárate.',
      tr: '{{1}} yaklaşık {{2}} dakika uzakta. Lütfen hazır ol.',
    },
  },
  {
    key: 'alto_payday',
    metaName: 'alto_payday_v2',
    brandParams: ['orgName'],
    metaCategory: 'UTILITY',
    params: ['pay date', 'period'],
    description: 'Pay day notice.',
    body: {
      en: 'Payday: {{1}}, for {{2}}. Your paystub is in the {{3}} app under Pay.',
      es: 'Día de pago: {{1}}, por {{2}}. Tu recibo está en la app de {{3}}, en Pago.',
      tr: 'Maaş günü: {{1}}, {{2}} dönemi için. Bordron {{3}} uygulamasında Maaş altında.',
    },
  },
  {
    key: 'alto_emergency',
    metaName: 'alto_emergency',
    metaCategory: 'UTILITY',
    params: ['title', 'message'],
    description: 'Emergency Mode: the declaration or the stand-down.',
    body: {
      en: 'EMERGENCY — {{1}}\n\n{{2}}',
      es: 'EMERGENCIA — {{1}}\n\n{{2}}',
      tr: 'ACİL DURUM — {{1}}\n\n{{2}}',
    },
  },
];

const byKey = new Map(WA_TEMPLATES.map((t) => [t.key, t]));

export function templateDef(key: WaTemplateKey): WaTemplateDef {
  return byKey.get(key)!;
}

/** The text the associate sees, for the record. */
export function renderTemplate(key: WaTemplateKey, lang: WaLang, params: string[]): string {
  const def = templateDef(key);
  return def.body[lang].replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
}

/** Meta's language codes for the three we speak. */
export function metaLanguageCode(lang: WaLang): string {
  return lang === 'es' ? 'es' : lang === 'tr' ? 'tr' : 'en_US';
}

export function toWaLang(v: string | null | undefined): WaLang {
  return v === 'es' || v === 'tr' ? v : 'en';
}

/* ----------------------------------------------------- the assistant's words */

type Words = Record<WaLang, string>;
const say = (w: Words, lang: WaLang) => w[lang];

/** The tenant's display name: what "the app" is called in a reply (Brief 2-1b). */
const app = () => getBrandingSync().orgName;
/** The tenant's word for the person a question is handed to (Brief 2-1b), lower-cased for the sentence. */
const manager = (lang: WaLang) => termsIn(tenantProfileSync() ?? defaultTenantProfile('WORKFORCE_PROVIDER'), lang).manager.toLowerCase();

export const WA_REPLY = {
  optedOut: (lang: WaLang) =>
    say(
      {
        en: `You will no longer get ${app()} updates on WhatsApp. Reply START to turn them back on. Your schedule, pay and rides are always in the ${app()} app.`,
        es: `Ya no recibirás avisos de ${app()} por WhatsApp. Responde ALTA para activarlos de nuevo. Tu horario, pago y viajes siempre están en la app de ${app()}.`,
        tr: `Artık ${app()} bildirimlerini WhatsApp üzerinden almayacaksın. Yeniden açmak için BAŞLA yaz. Programın, maaşın ve servislerin her zaman ${app()} uygulamasında.`,
      },
      lang,
    ),
  /**
   * The first thing the assistant says in a tenant: who it is (the name the
   * tenant chose), what it is, and what it can do. The product name appears
   * once (exempt from the forbidden-word list by the owner's ruling, 2026-10-13).
   */
  intro: (lang: WaLang, name: string) =>
    say(
      {
        en: `I'm ${name}, the AI assistant in ${PRODUCT_NAME}. I'm not a person. Ask me about your next payday, your ride or your schedule; anything else I pass to your ${manager('en')}.`,
        es: `Soy ${name}, el asistente de inteligencia artificial de ${PRODUCT_NAME}. No soy una persona. Pregúntame por tu próximo día de pago, tu viaje o tu horario; todo lo demás se lo paso a tu ${manager('es')}.`,
        tr: `Ben ${name}, ${PRODUCT_NAME}'ın yapay zeka asistanıyım. Bir insan değilim. Bana bir sonraki maaş gününü, servisini veya programını sorabilirsin; diğer her şeyi ${manager('tr')} adlı kişiye iletirim.`,
      },
      lang,
    ),
  /** Whenever anyone asks who or what it is. */
  whoAmI: (lang: WaLang, name: string) =>
    say(
      {
        en: `I'm ${name}, the AI assistant in ${PRODUCT_NAME}. I'm not a person: I answer from your own records (payday, ride, schedule) and hand everything else to your ${manager('en')}.`,
        es: `Soy ${name}, el asistente de inteligencia artificial de ${PRODUCT_NAME}. No soy una persona: respondo con tus propios datos (pago, viaje, horario) y paso todo lo demás a tu ${manager('es')}.`,
        tr: `Ben ${name}, ${PRODUCT_NAME}'ın yapay zeka asistanıyım. Bir insan değilim: kendi kayıtlarından yanıt veririm (maaş, servis, program), diğer her şeyi ${manager('tr')} adlı kişiye iletirim.`,
      },
      lang,
    ),
  optedIn: (lang: WaLang, name: string) =>
    `${WA_REPLY.intro(lang, name)} ${say(
      {
        en: `${app()} updates on WhatsApp are on. Reply STOP any time to leave.`,
        es: `Los avisos de ${app()} por WhatsApp están activados. Responde BAJA cuando quieras para salir.`,
        tr: `${app()} WhatsApp bildirimleri açık. Çıkmak için istediğin zaman DUR yaz.`,
      },
      lang,
    )}`,
  languageSet: (lang: WaLang) =>
    say({ en: 'Got it — English from now on.', es: 'Listo — español de ahora en adelante.', tr: 'Tamam — bundan sonra Türkçe.' }, lang),
  payday: (lang: WaLang, date: string, period: string) =>
    say(
      {
        en: `Your next payday is ${date}, for ${period}. Paystubs are in the ${app()} app under Pay.`,
        es: `Tu próximo día de pago es ${date}, por ${period}. Los recibos están en la app de ${app()}, en Pago.`,
        tr: `Bir sonraki maaş günün ${date}, ${period} dönemi için. Bordrolar ${app()} uygulamasında Maaş altında.`,
      },
      lang,
    ),
  noPayday: (lang: WaLang) =>
    say(
      {
        en: `There is no pay schedule on your record yet.`,
        es: `Aún no hay un calendario de pago en tu registro.`,
        tr: `Kaydında henüz bir ödeme takvimi yok.`,
      },
      lang,
    ),
  ride: (lang: WaLang, when: string, where: string, van: string | null) =>
    say(
      {
        en: `Your next ride: ${when}, pickup at ${where}${van ? ` — ${van}` : ' — a van will be assigned'}.`,
        es: `Tu próximo viaje: ${when}, recogida en ${where}${van ? ` — ${van}` : ' — se asignará una van'}.`,
        tr: `Bir sonraki servisin: ${when}, alış yeri ${where}${van ? ` — ${van}` : ' — bir minibüs atanacak'}.`,
      },
      lang,
    ),
  noRide: (lang: WaLang) =>
    say(
      {
        en: `You have no ride booked. Book one in the ${app()} app under Rides.`,
        es: `No tienes ningún viaje reservado. Resérvalo en la app de ${app()}, en Viajes.`,
        tr: `Rezerve edilmiş servisin yok. ${app()} uygulamasında Servisler altından ayırt.`,
      },
      lang,
    ),
  schedule: (lang: WaLang, lines: string[]) =>
    say(
      {
        en: `Your next shifts:\n${lines.join('\n')}`,
        es: `Tus próximos turnos:\n${lines.join('\n')}`,
        tr: `Sonraki vardiyaların:\n${lines.join('\n')}`,
      },
      lang,
    ),
  noShifts: (lang: WaLang) =>
    say(
      {
        en: `Nothing is on your schedule yet. Open shifts you can pick up are in the ${app()} app.`,
        es: `Todavía no hay nada en tu horario. Los turnos abiertos que puedes tomar están en la app de ${app()}.`,
        tr: `Programında henüz bir şey yok. Alabileceğin açık vardiyalar ${app()} uygulamasında.`,
      },
      lang,
    ),
  /** A hand-off that reached nobody (no placement, no supervisor at the store): say so, never "I have passed this". */
  handoffUnsent: (lang: WaLang) =>
    say(
      {
        en: `I couldn't reach your ${manager('en')} from here. Please ask them in person.`,
        es: `No pude contactar a tu ${manager('es')} desde aquí. Pregúntale en persona, por favor.`,
        tr: `Buradan ${manager('tr')} ile iletişim kuramadım. Lütfen yüz yüze sor.`,
      },
      lang,
    ),
  handoff: (lang: WaLang, who: string | null) =>
    say(
      {
        en: who ? `I have passed this to ${who}, who will answer in the ${app()} app messages.` : `I have passed this to your ${manager('en')}, who will answer in the ${app()} app messages.`,
        es: who ? `Se lo pasé a ${who}, que te responderá en los mensajes de la app de ${app()}.` : `Se lo pasé a tu ${manager('es')}, que te responderá en los mensajes de la app de ${app()}.`,
        tr: who ? `Bunu ${who} adlı kişiye ilettim; ${app()} uygulamasındaki mesajlardan yanıt verecek.` : `Bunu ${manager('tr')} adlı kişiye ilettim; ${app()} uygulamasındaki mesajlardan yanıt verecek.`,
      },
      lang,
    ),
  /** The assistant in the app (agent families step 3): who it is and what it can do here, in one breath. */
  appIntro: (lang: WaLang, name: string, can: string[]) =>
    say(
      {
        en: `I'm ${name}, the AI assistant in ${PRODUCT_NAME}. I'm not a person. ${can.length ? `I can help with: ${can.join('; ')}.` : 'Nothing is switched on for me to help with here yet.'}`,
        es: `Soy ${name}, el asistente de inteligencia artificial de ${PRODUCT_NAME}. No soy una persona. ${can.length ? `Puedo ayudarte con: ${can.join('; ')}.` : 'Todavía no hay nada activado con lo que pueda ayudarte aquí.'}`,
        tr: `Ben ${name}, ${PRODUCT_NAME}'ın yapay zeka asistanıyım. Bir insan değilim. ${can.length ? `Şunlarda yardımcı olabilirim: ${can.join('; ')}.` : 'Burada yardımcı olabileceğim açık bir şey henüz yok.'}`,
      },
      lang,
    ),
  /** coverage.forecast, asked: nobody short. */
  coverageAllCovered: (lang: WaLang, sitesNoun: string) =>
    say(
      {
        en: `Next 7 days: every one of your ${sitesNoun} meets its staffing target.`,
        es: `Próximos 7 días: todos tus ${sitesNoun} cumplen su objetivo de personal.`,
        tr: `Önümüzdeki 7 gün: tüm ${sitesNoun} kadro hedefini karşılıyor.`,
      },
      lang,
    ),
  /** coverage.forecast, asked: no targets set anywhere in scope. */
  coverageNoTargets: (lang: WaLang, sitesNoun: string) =>
    say(
      {
        en: `None of your ${sitesNoun} has a staffing target yet, so there is nothing to compare the schedule with.`,
        es: `Ninguno de tus ${sitesNoun} tiene todavía un objetivo de personal, así que no hay con qué comparar el horario.`,
        tr: `${sitesNoun} için henüz bir kadro hedefi yok; programı karşılaştıracak bir şey yok.`,
      },
      lang,
    ),
  /** coverage.forecast, asked: the short days, earliest first. */
  coverageShort: (lang: WaLang, shortDays: number, places: number, sitesNoun: string, lines: string[]) =>
    say(
      {
        en: `Next 7 days: ${shortDays} short day${shortDays === 1 ? '' : 's'} across ${places} of your ${sitesNoun}.\n${lines.join('\n')}`,
        es: `Próximos 7 días: ${shortDays} día${shortDays === 1 ? '' : 's'} con falta de personal en ${places} de tus ${sitesNoun}.\n${lines.join('\n')}`,
        tr: `Önümüzdeki 7 gün: ${sitesNoun} içinde ${places} yerde ${shortDays} eksik gün.\n${lines.join('\n')}`,
      },
      lang,
    ),
  /** One short day: where, when, how many short, how many free on the bench. */
  coverageLine: (lang: WaLang, place: string, day: string, gap: number, bench: number) =>
    say(
      {
        en: `• ${place}, ${day}: short ${gap}, ${bench} free on the bench`,
        es: `• ${place}, ${day}: faltan ${gap}, ${bench} libres en la reserva`,
        tr: `• ${place}, ${day}: ${gap} eksik, yedekte ${bench} boş kişi`,
      },
      lang,
    ),
  /** What waits on the desk from the agents. */
  deskNothing: (lang: WaLang) =>
    say(
      {
        en: 'Nothing from the agents is waiting on you.',
        es: 'No hay nada de los agentes pendiente para ti.',
        tr: 'Ajanlardan seni bekleyen bir şey yok.',
      },
      lang,
    ),
  deskWaiting: (lang: WaLang, n: number, lines: string[]) =>
    say(
      {
        en: `${n} agent proposal${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} on you. Nothing happens until you approve.\n${lines.join('\n')}`,
        es: `${n} propuesta${n === 1 ? '' : 's'} de agentes espera${n === 1 ? '' : 'n'} tu decisión. No pasa nada hasta que apruebes.\n${lines.join('\n')}`,
        tr: `Ajanlardan ${n} öneri kararını bekliyor. Onaylayana kadar hiçbir şey olmaz.\n${lines.join('\n')}`,
      },
      lang,
    ),
  /** document.chase, asked: nothing of theirs expires soon. */
  noRenewals: (lang: WaLang) =>
    say(
      {
        en: 'Nothing of yours expires in the next 30 days.',
        es: 'Nada tuyo vence en los próximos 30 días.',
        tr: 'Önümüzdeki 30 gün içinde süresi dolan bir belgen yok.',
      },
      lang,
    ),
  /** attendance.confirm: they said YES. */
  confirmedYes: (lang: WaLang, when: string) =>
    say(
      {
        en: `Thank you. You are confirmed for ${when}.`,
        es: `Gracias. Quedas confirmado para ${when}.`,
        tr: `Teşekkürler. ${when} için onaylandın.`,
      },
      lang,
    ),
  /** attendance.confirm: they said NO. */
  confirmedNo: (lang: WaLang, when: string) =>
    say(
      {
        en: `Thank you for telling us. We will look for cover for ${when}; you will hear when it is off your schedule.`,
        es: `Gracias por avisarnos. Buscaremos a alguien para ${when}; te avisaremos cuando salga de tu horario.`,
        tr: `Haber verdiğin için teşekkürler. ${when} için yerine birini arayacağız; programından çıkınca haber vereceğiz.`,
      },
      lang,
    ),
  unknownNumber: (lang: WaLang) =>
    say(
      {
        en: `This number is not linked to an ${app()} account. Turn on WhatsApp updates in the ${app()} app under Settings.`,
        es: `Este número no está vinculado a una cuenta de ${app()}. Activa los avisos por WhatsApp en la app de ${app()}, en Ajustes.`,
        tr: `Bu numara bir ${app()} hesabına bağlı değil. ${app()} uygulamasında Ayarlar altından WhatsApp bildirimlerini aç.`,
      },
      lang,
    ),
};
