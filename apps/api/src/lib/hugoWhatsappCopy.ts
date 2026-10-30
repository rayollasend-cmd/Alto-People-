import type { HugoTaskCreateInput, HugoTaskSubject } from '@alto-people/shared';
import { hugoDay } from './hugoWorkCopy.js';
import type { WaLang } from './whatsappContent.js';

/**
 * What Hugo says on WhatsApp about work he can take on (lib/hugoWhatsapp),
 * in the three languages WhatsApp speaks. The tap the app asks for is a
 * reply here: START (EMPEZAR, BAŞLA) — the word each language's opt-in
 * already uses, so it never collides with STOP / BAJA / DUR.
 */

type Words = Record<WaLang, string>;
const say = (w: Words, lang: WaLang) => w[lang];

/** The reply word that takes an offer, as each language writes it. */
export const START_WORD: Record<WaLang, string> = { en: 'START', es: 'EMPEZAR', tr: 'BAŞLA' };

type WatchKind = 'WATCH_TIME_OFF' | 'WATCH_DOCUMENT' | 'WATCH_PAYCHECK' | 'WATCH_OPEN_SHIFTS';

const dayRange = (start: string, end: string, lang: WaLang) => (start === end ? hugoDay(start, lang) : `${hugoDay(start, lang)} – ${hugoDay(end, lang)}`);

/** What Hugo would watch, as a noun phrase ("your time-off request for Mon, Nov 3"). */
export function watchThing(task: HugoTaskCreateInput, subject: HugoTaskSubject, lang: WaLang): string {
  const kind = task.kind as WatchKind;
  if (kind === 'WATCH_TIME_OFF') {
    const reqs = subject.timeOff ?? [];
    const one = reqs.length === 1 ? reqs[0]! : null;
    if (one) {
      const r = dayRange(one.startDate, one.endDate, lang);
      return say({ en: `your time-off request for ${r}`, es: `tu solicitud de tiempo libre del ${r}`, tr: `${r} izin isteğin` }, lang);
    }
    return say({ en: `your ${reqs.length} time-off requests`, es: `tus ${reqs.length} solicitudes de tiempo libre`, tr: `${reqs.length} izin isteğin` }, lang);
  }
  if (kind === 'WATCH_DOCUMENT') {
    const docs = subject.documents ?? [];
    const one = docs.length === 1 ? docs[0]! : null;
    if (one) return say({ en: `your document “${one.name}” under review`, es: `tu documento “${one.name}” en revisión`, tr: `incelemedeki “${one.name}” belgen` }, lang);
    return say({ en: `your ${docs.length} documents under review`, es: `tus ${docs.length} documentos en revisión`, tr: `incelemedeki ${docs.length} belgen` }, lang);
  }
  if (kind === 'WATCH_OPEN_SHIFTS') {
    const days = subject.days ?? 7;
    return say({ en: `open shifts that fit you in the next ${days} days`, es: `turnos abiertos que te sirvan en los próximos ${days} días`, tr: `önümüzdeki ${days} gün içinde sana uyan açık vardiyalar` }, lang);
  }
  return say({ en: 'your next paycheck', es: 'tu próximo pago', tr: 'bir sonraki maaşın' }, lang);
}

/** When Hugo speaks up, as the end of a sentence ("when it's decided"); Turkish opens its sentence with it. */
export function watchWhen(task: HugoTaskCreateInput, lang: WaLang): string {
  const w: Record<WatchKind, Words> = {
    WATCH_TIME_OFF: { en: "when it's decided", es: 'cuando se decida', tr: 'Karar verilince' },
    WATCH_DOCUMENT: { en: "when it's checked", es: 'cuando lo revisen', tr: 'İncelenince' },
    WATCH_PAYCHECK: { en: "when it's paid", es: 'cuando te paguen', tr: 'Ödenince' },
    WATCH_OPEN_SHIFTS: { en: 'when one comes up', es: 'cuando aparezca uno', tr: 'Biri çıkınca' },
  };
  return say(w[task.kind as WatchKind] ?? w.WATCH_PAYCHECK, lang);
}

export const WA_HUGO = {
  /** One thing to watch: what, when he'd speak up, and the word that starts it. */
  offerOne: (lang: WaLang, thing: string, when: string) =>
    say(
      {
        en: `I can keep an eye on ${thing} and tell you here and in the app ${when}. Reply START within 30 minutes to have me do it.`,
        es: `Puedo estar pendiente de ${thing} y avisarte aquí y en la app ${when}. Responde EMPEZAR en los próximos 30 minutos para que lo haga.`,
        tr: `Takip edebileceğim: ${thing}. ${when} sana burada ve uygulamada haber veririm. Yapmamı istiyorsan 30 dakika içinde BAŞLA yaz.`,
      },
      lang,
    ),
  /** Several: numbered, one picked by its number. */
  offerPick: (lang: WaLang, lines: string[]) =>
    say(
      {
        en: `I can keep an eye on one of these and tell you here and in the app when it happens:\n${lines.join('\n')}\nReply START and its number (START 1) within 30 minutes to have me do it.`,
        es: `Puedo estar pendiente de una de estas cosas y avisarte aquí y en la app cuando pase:\n${lines.join('\n')}\nResponde EMPEZAR y su número (EMPEZAR 1) en los próximos 30 minutos para que lo haga.`,
        tr: `Bunlardan birini takip edip olunca sana burada ve uygulamada haber verebilirim:\n${lines.join('\n')}\nYapmamı istediğinin numarasıyla 30 dakika içinde BAŞLA yaz (BAŞLA 1).`,
      },
      lang,
    ),
  /** START alone, with several on offer. */
  whichOne: (lang: WaLang, n: number) =>
    say(
      {
        en: `Which one? Reply START and its number, 1 to ${n} (START 1).`,
        es: `¿Cuál? Responde EMPEZAR y su número, del 1 al ${n} (EMPEZAR 1).`,
        tr: `Hangisi? BAŞLA ve 1 ile ${n} arasında numarasını yaz (BAŞLA 1).`,
      },
      lang,
    ),
  /** Started: what he is doing, where they'll hear, and where to follow it. */
  started: (lang: WaLang, thing: string, when: string, link: string) =>
    say(
      {
        en: `Done — I'm keeping an eye on ${thing}. I'll tell you here and in the app ${when}. Follow it in the app: ${link}`,
        es: `Listo: estoy pendiente de ${thing}. Te aviso aquí y en la app ${when}. Síguelo en la app: ${link}`,
        tr: `Tamam, takipteyim: ${thing}. ${when} sana burada ve uygulamada haber vereceğim. Uygulamadan izle: ${link}`,
      },
      lang,
    ),
  /** The same watch was already running. */
  already: (lang: WaLang, thing: string, when: string, link: string) =>
    say(
      {
        en: `I'm already keeping an eye on ${thing}. I'll tell you here and in the app ${when}. Follow it in the app: ${link}`,
        es: `Ya estoy pendiente de ${thing}. Te aviso aquí y en la app ${when}. Síguelo en la app: ${link}`,
        tr: `Zaten takipteyim: ${thing}. ${when} sana burada ve uygulamada haber vereceğim. Uygulamadan izle: ${link}`,
      },
      lang,
    ),
  /** START more than 30 minutes after the offer. */
  expired: (lang: WaLang) =>
    say(
      {
        en: "That was more than 30 minutes ago, so I didn't start anything. Ask me again and I'll set it up.",
        es: 'Eso fue hace más de 30 minutos, así que no empecé nada. Pídemelo otra vez y lo preparo.',
        tr: 'Bu 30 dakikadan önceydi, o yüzden hiçbir şey başlatmadım. Tekrar sor, hazırlayayım.',
      },
      lang,
    ),
  /** startHugoTask said no: too many running. */
  tooMany: (lang: WaLang, link: string) =>
    say(
      {
        en: `I couldn't start it: you already have as many tasks running as I can take. Stop one in the app first: ${link}`,
        es: `No pude empezarlo: ya tienes tantas tareas en marcha como puedo llevar. Detén una en la app primero: ${link}`,
        tr: `Başlatamadım: zaten alabileceğim kadar görevin çalışıyor. Önce uygulamadan birini durdur: ${link}`,
      },
      lang,
    ),
  /** startHugoTask said no: nothing waits for a decision any more. */
  nothingLeft: (lang: WaLang) =>
    say(
      {
        en: 'Nothing is waiting for a decision any more, so there is nothing for me to watch.',
        es: 'Ya no hay nada esperando una decisión, así que no hay nada que vigilar.',
        tr: 'Artık karar bekleyen bir şey yok, takip edecek bir şey kalmadı.',
      },
      lang,
    ),
  /** startHugoTask said no, for another reason. */
  cantStart: (lang: WaLang, link: string) =>
    say(
      {
        en: `I couldn't start that just now. You can start it in the app: ${link}`,
        es: `No pude empezarlo ahora. Puedes hacerlo en la app: ${link}`,
        tr: `Bunu şu an başlatamadım. Uygulamadan başlatabilirsin: ${link}`,
      },
      lang,
    ),
  /** Finding cover changes a schedule: it starts in the app, where the shift is picked. */
  coverInApp: (lang: WaLang, link: string) =>
    say(
      {
        en: `I can ask coworkers who are free to cover your shift, one at a time. That starts in the app, where you pick the shift: ${link}`,
        es: `Puedo preguntar a compañeros libres, uno a la vez, si cubren tu turno. Eso se empieza en la app, donde eliges el turno: ${link}`,
        tr: `Vardiyanı devralmaları için boştaki iş arkadaşlarına tek tek sorabilirim. Bunu uygulamada, vardiyayı seçerek başlatırsın: ${link}`,
      },
      lang,
    ),
  /** Any other work to hand him: the app. */
  taskInApp: (lang: WaLang, link: string) =>
    say(
      {
        en: `I can do that from the app: ${link}`,
        es: `Puedo hacerlo desde la app: ${link}`,
        tr: `Bunu uygulamadan yapabilirim: ${link}`,
      },
      lang,
    ),
  /** After the task list: where to see it. */
  seeTasks: (lang: WaLang, link: string) => say({ en: `See them in the app: ${link}`, es: `Míralas en la app: ${link}`, tr: `Uygulamada gör: ${link}` }, lang),
};
