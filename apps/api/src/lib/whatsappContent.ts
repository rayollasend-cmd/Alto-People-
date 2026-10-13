import { getBrandingSync } from './branding.js';
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
    description: 'The day-before reminder.',
    body: {
      en: 'Reminder: {{1}} at {{2}} tomorrow, {{3}}. Reply RIDE if you need a van.',
      es: 'Recordatorio: {{1}} en {{2}} mañana, {{3}}. Responde VIAJE si necesitas una van.',
      tr: 'Hatırlatma: yarın {{1}}, {{2}}, {{3}}. Minibüs gerekiyorsa SERVİS yaz.',
    },
  },
  {
    key: 'alto_ride_pickup',
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
  /** The first thing Hugo says in a tenant: who he is, what he is, and what he can do. */
  intro: (lang: WaLang, name: string) =>
    say(
      {
        en: `I'm ${name}, the AI assistant in Alto People. I'm not a person. Ask me about your next payday, your ride or your schedule; anything else I pass to your supervisor.`,
        es: `Soy ${name}, el asistente de inteligencia artificial de Alto People. No soy una persona. Pregúntame por tu próximo día de pago, tu viaje o tu horario; todo lo demás se lo paso a tu supervisor.`,
        tr: `Ben ${name}, Alto People'ın yapay zeka asistanıyım. Bir insan değilim. Bana bir sonraki maaş gününü, servisini veya programını sorabilirsin; diğer her şeyi amirine iletirim.`,
      },
      lang,
    ),
  /** Whenever anyone asks who or what he is. */
  whoAmI: (lang: WaLang, name: string) =>
    say(
      {
        en: `I'm ${name}, the AI assistant in Alto People, by Alto People. I'm not a person: I answer from your own records (payday, ride, schedule) and hand everything else to your supervisor.`,
        es: `Soy ${name}, el asistente de inteligencia artificial de Alto People, por Alto People. No soy una persona: respondo con tus propios datos (pago, viaje, horario) y paso todo lo demás a tu supervisor.`,
        tr: `Ben ${name}, Alto People'ın yapay zeka asistanıyım (Alto People tarafından). Bir insan değilim: kendi kayıtlarından yanıt veririm (maaş, servis, program), diğer her şeyi amirine iletirim.`,
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
        en: 'There is no pay schedule on your record yet. I have passed this to your supervisor.',
        es: 'Aún no hay un calendario de pago en tu registro. Se lo pasé a tu supervisor.',
        tr: 'Kaydında henüz bir ödeme takvimi yok. Bunu amirine ilettim.',
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
  handoff: (lang: WaLang, who: string | null) =>
    say(
      {
        en: who ? `I have passed this to ${who}, who will answer in the ${app()} app messages.` : 'I have passed this to your supervisor, who will answer in the ${app()} app messages.',
        es: who ? `Se lo pasé a ${who}, que te responderá en los mensajes de la app de ${app()}.` : 'Se lo pasé a tu supervisor, que te responderá en los mensajes de la app de ${app()}.',
        tr: who ? `Bunu ${who} adlı kişiye ilettim; ${app()} uygulamasındaki mesajlardan yanıt verecek.` : 'Bunu amirine ilettim; ${app()} uygulamasındaki mesajlardan yanıt verecek.',
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
