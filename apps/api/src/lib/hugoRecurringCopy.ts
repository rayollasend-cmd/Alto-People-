import type { HugoRecurringCadence, HugoRecurringWhat } from '@alto-people/shared';
import type { HugoLang } from './hugoWorkCopy.js';

/**
 * The words of Hugo's recurring briefs (lib/hugoRecurring) in the six
 * languages associates read: the schedule as a phrase ("every Friday at
 * 4:00 PM"), each brief's subject line, the hours brief, the notices around
 * a brief (keep going, ended, held to tomorrow, skipped) and the chat's
 * replies when someone asks for one. The answers themselves are the
 * registry's (lib/hugoRegistry) or the model's.
 */

type Six = Record<HugoLang, string>;
const pick = (w: Six, lang: HugoLang) => w[lang];
const LOCALES: Record<HugoLang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };

/** "4:00 PM" / "16:00" for an HH:MM, in the reader's language. */
export function clockLabel(time: string, lang: HugoLang): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  // A fixed day at that wall time, formatted as UTC: no zone can move it.
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date(Date.UTC(2026, 0, 4, h, m)));
}

/** Intl has no Haitian Creole: its weekdays, by hand. */
const HT_DAYS = ['dimanch', 'lendi', 'madi', 'mèkredi', 'jedi', 'vandredi', 'samdi'];

/** Monday… in the reader's language (0 = Sunday). 2026-01-04 was a Sunday. */
function weekdayName(dow: number, lang: HugoLang): string {
  if (lang === 'ht') return HT_DAYS[dow] ?? '';
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', weekday: 'long' }).format(new Date(Date.UTC(2026, 0, 4 + dow, 12)));
}

/** Ukrainian needs the weekday in the genitive after "кожного/кожної". */
const UK_EVERY = ['кожної неділі', 'кожного понеділка', 'кожного вівторка', 'кожної середи', 'кожного четверга', 'кожної пʼятниці', 'кожної суботи'];

/** "every Friday at 4:00 PM", "every weekday at 7:00 AM", "every day at 7:00 AM". */
export function scheduleLabel(s: { cadence: HugoRecurringCadence; weekday: number | null; time: string }, lang: HugoLang): string {
  const at = clockLabel(s.time, lang);
  if (s.cadence === 'DAILY') {
    return pick({ en: `every day at ${at}`, es: `todos los días a las ${at}`, tr: `her gün saat ${at}`, ht: `chak jou a ${at}`, pt: `todos os dias às ${at}`, uk: `щодня о ${at}` }, lang);
  }
  if (s.cadence === 'WEEKDAYS') {
    return pick({ en: `every weekday at ${at}`, es: `de lunes a viernes a las ${at}`, tr: `hafta içi her gün saat ${at}`, ht: `chak jou lasemèn a ${at}`, pt: `de segunda a sexta às ${at}`, uk: `щобудня о ${at}` }, lang);
  }
  const dow = s.weekday ?? 5;
  const day = weekdayName(dow, lang);
  return pick(
    {
      en: `every ${day} at ${at}`,
      es: `cada ${day} a las ${at}`,
      tr: `her ${day} saat ${at}`,
      ht: `chak ${day} a ${at}`,
      pt: `${dow === 0 || dow === 6 ? 'todo' : 'toda'} ${day} às ${at}`,
      uk: `${UK_EVERY[dow]} о ${at}`,
    },
    lang,
  );
}

/** What a brief is, as a noun phrase inside a sentence. */
export const WHAT_PHRASE: Record<HugoRecurringWhat, Six> = {
  SCHEDULE: { en: 'your next shifts', es: 'tus próximos turnos', tr: 'sonraki vardiyaların', ht: 'pwochen chif ou yo', pt: 'seus próximos turnos', uk: 'ваші наступні зміни' },
  PAYDAY: { en: 'your next payday', es: 'tu próximo día de pago', tr: 'bir sonraki maaş günün', ht: 'pwochen jou peman ou', pt: 'seu próximo dia de pagamento', uk: 'ваш наступний день виплати' },
  RIDE: { en: 'your next ride', es: 'tu próximo viaje', tr: 'bir sonraki servisin', ht: 'pwochen woulib ou', pt: 'sua próxima carona', uk: 'вашу наступну поїздку' },
  RENEW: { en: 'documents to renew', es: 'los documentos por renovar', tr: 'yenilenecek belgeler', ht: 'dokiman pou renouvle', pt: 'documentos para renovar', uk: 'документи, які треба оновити' },
  DESK: { en: 'what’s waiting on you', es: 'lo que espera por ti', tr: 'seni bekleyenler', ht: 'sa k ap tann ou', pt: 'o que está esperando você', uk: 'що на вас чекає' },
  COVERAGE: { en: 'where you’re short this week', es: 'dónde falta gente esta semana', tr: 'bu hafta nerede eksik olduğu', ht: 'kote ki manke moun semèn sa a', pt: 'onde falta gente nesta semana', uk: 'де цього тижня бракує людей' },
  DRIVER_NEXT_RUN: { en: 'your next run', es: 'tu próxima ruta', tr: 'bir sonraki seferin', ht: 'pwochen wout ou', pt: 'sua próxima rota', uk: 'ваш наступний рейс' },
  MY_HOURS: { en: 'your hours this week', es: 'tus horas de esta semana', tr: 'bu haftaki saatlerin', ht: 'è ou semèn sa a', pt: 'suas horas desta semana', uk: 'ваші години цього тижня' },
  ASK: { en: 'the answer to your question', es: 'la respuesta a tu pregunta', tr: 'sorunun cevabı', ht: 'repons kesyon ou', pt: 'a resposta à sua pergunta', uk: 'відповідь на ваше запитання' },
};

/** A brief's notice subject. */
const SUBJECT: Record<HugoRecurringWhat, Six> = {
  SCHEDULE: { en: 'Your next shifts', es: 'Tus próximos turnos', tr: 'Sonraki vardiyaların', ht: 'Pwochen chif ou yo', pt: 'Seus próximos turnos', uk: 'Ваші наступні зміни' },
  PAYDAY: { en: 'Your next payday', es: 'Tu próximo día de pago', tr: 'Bir sonraki maaş günün', ht: 'Pwochen jou peman ou', pt: 'Seu próximo dia de pagamento', uk: 'Ваш наступний день виплати' },
  RIDE: { en: 'Your next ride', es: 'Tu próximo viaje', tr: 'Bir sonraki servisin', ht: 'Pwochen woulib ou', pt: 'Sua próxima carona', uk: 'Ваша наступна поїздка' },
  RENEW: { en: 'Documents to renew', es: 'Documentos por renovar', tr: 'Yenilenecek belgeler', ht: 'Dokiman pou renouvle', pt: 'Documentos para renovar', uk: 'Документи, які треба оновити' },
  DESK: { en: 'What’s waiting on you', es: 'Lo que espera por ti', tr: 'Seni bekleyenler', ht: 'Sa k ap tann ou', pt: 'O que está esperando você', uk: 'Що на вас чекає' },
  COVERAGE: { en: 'Coverage this week', es: 'Cobertura de esta semana', tr: 'Bu haftanın kadrosu', ht: 'Kouvèti semèn sa a', pt: 'Cobertura desta semana', uk: 'Покриття цього тижня' },
  DRIVER_NEXT_RUN: { en: 'Your next run', es: 'Tu próxima ruta', tr: 'Bir sonraki seferin', ht: 'Pwochen wout ou', pt: 'Sua próxima rota', uk: 'Ваш наступний рейс' },
  MY_HOURS: { en: 'Your hours this week', es: 'Tus horas de esta semana', tr: 'Bu haftaki saatlerin', ht: 'È ou semèn sa a', pt: 'Suas horas desta semana', uk: 'Ваші години цього тижня' },
  ASK: { en: 'Your question', es: 'Tu pregunta', tr: 'Sorun', ht: 'Kesyon ou', pt: 'Sua pergunta', uk: 'Ваше запитання' },
};

export function briefSubject(what: HugoRecurringWhat, lang: HugoLang, question?: string): string {
  const base = pick(SUBJECT[what], lang);
  if (what !== 'ASK' || !question) return base;
  const q = question.length > 48 ? `${question.slice(0, 47).trimEnd()}…` : question;
  return `${base}: ${q}`;
}

const num = (n: number, lang: HugoLang) => new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: 2 }).format(n);

/** MY_HOURS: worked this store week so far, and what is still scheduled. Never money — it reaches a lock screen. */
export function hoursBrief(lang: HugoLang, week: string, worked: number, left: number): string {
  const w = num(worked, lang);
  const l = num(left, lang);
  if (left > 0) {
    return pick(
      {
        en: `This week (${week}) you’ve worked ${w} hours so far, with ${l} more scheduled.`,
        es: `Esta semana (${week}) llevas ${w} horas trabajadas, y tienes ${l} más programadas.`,
        tr: `Bu hafta (${week}) şimdiye kadar ${w} saat çalıştın; ${l} saat daha planlı.`,
        ht: `Semèn sa a (${week}) ou travay ${w} èdtan deja, epi ou gen ${l} lòt ki pwograme.`,
        pt: `Nesta semana (${week}) você trabalhou ${w} horas até agora, com mais ${l} programadas.`,
        uk: `Цього тижня (${week}) ви вже відпрацювали ${w} год, і ще ${l} год у графіку.`,
      },
      lang,
    );
  }
  return pick(
    {
      en: `This week (${week}) you’ve worked ${w} hours, and nothing more is scheduled.`,
      es: `Esta semana (${week}) llevas ${w} horas trabajadas, y no tienes más programadas.`,
      tr: `Bu hafta (${week}) ${w} saat çalıştın; planlı başka saat yok.`,
      ht: `Semèn sa a (${week}) ou travay ${w} èdtan, epi pa gen lòt ki pwograme.`,
      pt: `Nesta semana (${week}) você trabalhou ${w} horas, e não há mais nada programado.`,
      uk: `Цього тижня (${week}) ви відпрацювали ${w} год, і більше нічого не заплановано.`,
    },
    lang,
  );
}

type Notice = { subject: string; body: string };

export const RECURRING_NOTICE = {
  /** A week before the end: carry on, or let it end. */
  keepGoing: (lang: HugoLang, what: HugoRecurringWhat, schedule: string, ends: string): Notice => {
    const thing = pick(WHAT_PHRASE[what], lang);
    return {
      subject: pick({ en: 'Keep these coming?', es: '¿Sigo enviándote esto?', tr: 'Göndermeye devam edeyim mi?', ht: 'Pou m kontinye voye sa?', pt: 'Continuo enviando?', uk: 'Надсилати й далі?' }, lang),
      body: pick(
        {
          en: `I’ve been sending you ${thing} ${schedule}. It ends on ${ends} unless you tap Keep going.`,
          es: `Te he estado enviando ${thing} ${schedule}. Termina el ${ends}, a menos que toques Seguir.`,
          tr: `Sana ${schedule} ${thing} gönderiyorum. Devam et’e dokunmazsan ${ends} tarihinde biter.`,
          ht: `M ap voye ${thing} ba ou ${schedule}. Sa ap fini ${ends} si ou pa tape Kontinye.`,
          pt: `Tenho enviado ${thing} ${schedule}. Termina em ${ends}, a menos que você toque em Continuar.`,
          uk: `Я надсилаю вам ${thing} ${schedule}. Це закінчиться ${ends}, якщо ви не натиснете «Продовжити».`,
        },
        lang,
      ),
    };
  },
  /** It ran its time with no answer. */
  ended: (lang: HugoLang, what: HugoRecurringWhat): Notice => {
    const thing = pick(WHAT_PHRASE[what], lang);
    return {
      subject: pick({ en: 'I’ve stopped a repeating message', es: 'Dejé de enviar un mensaje repetido', tr: 'Tekrarlanan bir mesajı durdurdum', ht: 'Mwen sispann yon mesaj ki t ap repete', pt: 'Parei uma mensagem repetida', uk: 'Я зупинив повторюване повідомлення' }, lang),
      body: pick(
        {
          en: `I’ve stopped sending ${thing}. Start it again any time from Tasks.`,
          es: `Dejé de enviarte ${thing}. Puedes volver a empezarlo cuando quieras desde Tareas.`,
          tr: `${thing} göndermeyi bıraktım. İstediğin zaman Görevler’den yeniden başlatabilirsin.`,
          ht: `Mwen sispann voye ${thing}. Ou ka rekòmanse l nenpòt ki lè nan Travay yo.`,
          pt: `Parei de enviar ${thing}. Comece de novo quando quiser em Tarefas.`,
          uk: `Я більше не надсилаю ${thing}. Увімкніть знову будь-коли в розділі «Завдання».`,
        },
        lang,
      ),
    };
  },
  /** The person can no longer have this answer (a role changed, a part of the app switched off). */
  stopped: (lang: HugoLang, what: HugoRecurringWhat): Notice => {
    const thing = pick(WHAT_PHRASE[what], lang);
    return {
      subject: pick({ en: 'I’ve stopped a repeating message', es: 'Dejé de enviar un mensaje repetido', tr: 'Tekrarlanan bir mesajı durdurdum', ht: 'Mwen sispann yon mesaj ki t ap repete', pt: 'Parei uma mensagem repetida', uk: 'Я зупинив повторюване повідомлення' }, lang),
      body: pick(
        {
          en: `I can’t tell you ${thing} any more — your access changed or that part of the app is off — so I’ve stopped.`,
          es: `Ya no puedo decirte ${thing}: cambió tu acceso o esa parte de la app está apagada. Así que lo detuve.`,
          tr: `Artık sana ${thing} söyleyemiyorum; erişimin değişti ya da uygulamanın o bölümü kapalı. Bu yüzden durdurdum.`,
          ht: `Mwen pa ka di w ${thing} ankò — aksè ou chanje oswa pati sa a nan aplikasyon an fèmen — kidonk mwen sispann.`,
          pt: `Não consigo mais informar ${thing} — seu acesso mudou ou essa parte do app está desligada — então parei.`,
          uk: `Я більше не можу повідомляти ${thing} — ваш доступ змінився або цю частину застосунку вимкнено, — тож я зупинився.`,
        },
        lang,
      ),
    };
  },
  /** The tenant's free questions for today are used up: tomorrow, same time. */
  tomorrow: (lang: HugoLang): string =>
    pick(
      {
        en: 'I’ll answer this one tomorrow — I’ve answered all the questions I can for today.',
        es: 'Esta te la respondo mañana: ya respondí todas las preguntas que puedo por hoy.',
        tr: 'Bunu yarın cevaplayacağım; bugün cevaplayabileceğim tüm soruları cevapladım.',
        ht: 'M ap reponn sa a demen — mwen deja reponn tout kesyon mwen kapab pou jodi a.',
        pt: 'Respondo esta amanhã — já respondi todas as perguntas que posso hoje.',
        uk: 'Відповім на це завтра — на сьогодні я вже відповів на всі запитання, які міг.',
      },
      lang,
    ),
  /** Free questions need the model, which is off here: said once, then quiet. */
  noModel: (lang: HugoLang): string =>
    pick(
      {
        en: 'I can’t answer free questions here right now, so I skipped this one. I’ll try again next time.',
        es: 'Ahora no puedo responder preguntas libres aquí, así que me salté esta. Lo intento de nuevo la próxima vez.',
        tr: 'Şu an burada serbest soruları cevaplayamıyorum, bu yüzden bunu atladım. Bir dahaki sefere yeniden denerim.',
        ht: 'Mwen pa ka reponn kesyon lib isit la kounye a, kidonk mwen sote sa a. M ap eseye ankò pwochen fwa.',
        pt: 'No momento não consigo responder perguntas livres aqui, então pulei esta. Tento de novo na próxima vez.',
        uk: 'Зараз я не можу відповідати тут на довільні запитання, тож пропустив це. Спробую наступного разу.',
      },
      lang,
    ),
  /** The person's monthly allowance is used up: back on its renewal day; the registry's answer when there is one. */
  allowance: (lang: HugoLang, renews: string, fallback: string | null): string => {
    const lead = pick(
      {
        en: `I’ve used this month’s thinking time, so your question is back on ${renews}.`,
        es: `Ya usé el tiempo para pensar de este mes, así que tu pregunta vuelve el ${renews}.`,
        tr: `Bu ayın düşünme süresini kullandım; sorun ${renews} tarihinde geri gelecek.`,
        ht: `Mwen fin itilize tan pou reflechi mwa sa a, kidonk kesyon ou ap tounen ${renews}.`,
        pt: `Usei o tempo para pensar deste mês, então sua pergunta volta em ${renews}.`,
        uk: `Я вичерпав час на роздуми цього місяця, тож ваше запитання повернеться ${renews}.`,
      },
      lang,
    );
    if (!fallback) return lead;
    const here = pick({ en: 'Here’s what I can tell you:', es: 'Esto es lo que puedo decirte:', tr: 'Sana şunu söyleyebilirim:', ht: 'Men sa mwen ka di w:', pt: 'Eis o que posso dizer:', uk: 'Ось що я можу сказати:' }, lang);
    return `${lead} ${here}\n${fallback}`;
  },
};

/** The chat's replies when someone asks for a brief on a schedule. */
export const RECURRING_CHAT = {
  offer: (lang: HugoLang, what: HugoRecurringWhat, schedule: string): string => {
    const thing = pick(WHAT_PHRASE[what], lang);
    return pick(
      {
        en: `I can send you ${thing} ${schedule}. Tap Start — you can pause it, change the time or stop it any time in Tasks.`,
        es: `Puedo enviarte ${thing} ${schedule}. Toca Empezar; puedes pausarlo, cambiar la hora o detenerlo cuando quieras en Tareas.`,
        tr: `Sana ${schedule} ${thing} gönderebilirim. Başlat’a dokun; Görevler’den istediğin zaman duraklatabilir, saatini değiştirebilir ya da durdurabilirsin.`,
        ht: `Mwen ka voye ${thing} ba ou ${schedule}. Tape Kòmanse — ou ka poze l, chanje lè a oswa sispann li nenpòt ki lè nan Travay yo.`,
        pt: `Posso enviar ${thing} ${schedule}. Toque em Começar — você pode pausar, mudar o horário ou parar quando quiser em Tarefas.`,
        uk: `Я можу надсилати вам ${thing} ${schedule}. Натисніть «Почати» — призупинити, змінити час чи зупинити можна будь-коли в розділі «Завдання».`,
      },
      lang,
    );
  },
  tooMany: (lang: HugoLang, n: number): string =>
    pick(
      {
        en: `You already have ${n} repeating messages — stop one in Tasks, then ask again.`,
        es: `Ya tienes ${n} mensajes repetidos; detén uno en Tareas y vuelve a pedirlo.`,
        tr: `Zaten ${n} tekrarlanan mesajın var; Görevler’den birini durdur, sonra yeniden iste.`,
        ht: `Ou deja gen ${n} mesaj k ap repete — sispann youn nan Travay yo, epi mande ankò.`,
        pt: `Você já tem ${n} mensagens repetidas — pare uma em Tarefas e peça de novo.`,
        uk: `У вас уже ${n} повторюваних повідомлень — зупиніть одне в розділі «Завдання» і попросіть знову.`,
      },
      lang,
    ),
  noModel: (lang: HugoLang, can: string): string =>
    pick(
      {
        en: `I can repeat ${can} on a schedule. A free question of your own needs more than I have here right now.`,
        es: `Puedo repetir ${can} con un horario. Una pregunta libre tuya necesita más de lo que tengo aquí ahora.`,
        tr: `${can} bilgisini düzenli olarak tekrarlayabilirim. Kendi serbest sorun için şu an burada yeterli imkânım yok.`,
        ht: `Mwen ka repete ${can} sou yon orè. Yon kesyon lib pa w bezwen plis pase sa mwen genyen isit la kounye a.`,
        pt: `Posso repetir ${can} com horário. Uma pergunta livre sua precisa de mais do que tenho aqui agora.`,
        uk: `Я можу регулярно повідомляти ${can}. Для вашого довільного запитання зараз тут бракує можливостей.`,
      },
      lang,
    ),
  unavailable: (lang: HugoLang): string =>
    pick(
      {
        en: 'That isn’t something I can tell you here, so I can’t repeat it.',
        es: 'Eso no es algo que pueda decirte aquí, así que no puedo repetirlo.',
        tr: 'Bunu burada sana söyleyemiyorum, bu yüzden tekrarlayamam.',
        ht: 'Se pa yon bagay mwen ka di w isit la, kidonk mwen pa ka repete l.',
        pt: 'Isso não é algo que eu possa informar aqui, então não posso repetir.',
        uk: 'Це не те, що я можу повідомити тут, тож повторювати не можу.',
      },
      lang,
    ),
};

/** "your next shifts, your next payday and …" — what this person can have repeated. */
export function whatList(whats: HugoRecurringWhat[], lang: HugoLang): string {
  const items = whats.map((w) => pick(WHAT_PHRASE[w], lang));
  if (items.length <= 1) return items.join('');
  const and = pick({ en: 'and', es: 'y', tr: 've', ht: 'ak', pt: 'e', uk: 'і' }, lang);
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}
