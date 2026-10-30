import type { HugoLang } from './hugoWorkCopy.js';

/**
 * The words of Hugo's goals that the server writes (lib/hugoGoals,
 * lib/hugoGoalActions): what each proposed step says it will do, and the
 * notices a goal sends. Everything else — the plan, the trail, the buttons —
 * the web renders from codes ('hugoWork.goal.*').
 *
 * An associate's own steps read in the six languages associates use; a
 * scheduling desk's in English and Spanish (staff copy), English otherwise.
 * A notice says what happened and what, if anything, the person can do; the
 * AI disclosure is added where it is sent (lib/hugoWork sendHugoNotice).
 */

type Six = Record<HugoLang, string>;
type Notice = { subject: string; body: string };
const pick = (w: Six, lang: HugoLang) => w[lang];
/** Staff copy: English and Spanish; the rest read English. */
const staff = (lang: HugoLang, en: string, es: string) => (lang === 'es' ? es : en);
/** The goal as a notice quotes it: «…» in Ukrainian, “…” elsewhere. */
const q = (lang: HugoLang, goal: string) => (lang === 'uk' ? `«${goal}»` : `“${goal}”`);

export const TIME_OFF_WORD: Record<string, Six> = {
  SICK: { en: 'Sick', es: 'Enfermedad', tr: 'Hastalık', ht: 'Maladi', pt: 'Doença', uk: 'Лікарняний' },
  VACATION: { en: 'Vacation', es: 'Vacaciones', tr: 'Tatil', ht: 'Vakans', pt: 'Férias', uk: 'Відпустка' },
  PTO: { en: 'Paid time off', es: 'Tiempo libre pagado', tr: 'Ücretli izin', ht: 'Konje peye', pt: 'Folga remunerada', uk: 'Оплачувана відпустка' },
  BEREAVEMENT: { en: 'Bereavement', es: 'Duelo', tr: 'Vefat izni', ht: 'Lanmò nan fanmi', pt: 'Luto', uk: 'Відпустка у зв’язку з втратою' },
  JURY_DUTY: { en: 'Jury duty', es: 'Servicio de jurado', tr: 'Jüri görevi', ht: 'Sèvis jiri', pt: 'Serviço de júri', uk: 'Обов’язки присяжного' },
  OTHER: { en: 'Other', es: 'Otro', tr: 'Diğer', ht: 'Lòt', pt: 'Outro', uk: 'Інше' },
};

/** What a proposed step says it will do: a title and a line under it. */
export const GOAL_STEP_WORDS = {
  pickUp: (lang: HugoLang, position: string, when: string, site: string | null) => ({
    title: pick(
      {
        en: `Ask for the open ${position} shift, ${when}`,
        es: `Pedir el turno abierto de ${position}, ${when}`,
        tr: `Açık ${position} vardiyasını iste, ${when}`,
        ht: `Mande chif ${position} ki louvri a, ${when}`,
        pt: `Pedir o turno aberto de ${position}, ${when}`,
        uk: `Попросити вільну зміну «${position}», ${when}`,
      },
      lang,
    ),
    detail: `${site ? `${site}. ` : ''}${pick({ en: 'Your manager approves it.', es: 'Tu gerente lo aprueba.', tr: 'Yöneticin onaylar.', ht: 'Manadjè ou apwouve l.', pt: 'Seu gerente aprova.', uk: 'Погоджує ваш керівник.' }, lang)}`,
  }),
  timeOff: (lang: HugoLang, range: string, category: string, hours: number) => ({
    title: pick({ en: `Request time off, ${range}`, es: `Pedir tiempo libre, ${range}`, tr: `İzin iste, ${range}`, ht: `Mande konje, ${range}`, pt: `Pedir folga, ${range}`, uk: `Попросити відпустку, ${range}` }, lang),
    detail: pick(
      {
        en: `${category} · ${hours} h. Your manager decides.`,
        es: `${category} · ${hours} h. Tu gerente decide.`,
        tr: `${category} · ${hours} saat. Yöneticin karar verir.`,
        ht: `${category} · ${hours} è. Manadjè ou deside.`,
        pt: `${category} · ${hours} h. Seu gerente decide.`,
        uk: `${category} · ${hours} год. Рішення ухвалює керівник.`,
      },
      lang,
    ),
  }),
  cover: (lang: HugoLang, when: string) => ({
    title: pick(
      {
        en: `Ask coworkers to cover your shift, ${when}`,
        es: `Pedir a compañeros que cubran tu turno, ${when}`,
        tr: `${when} vardiyan için iş arkadaşlarına sor`,
        ht: `Mande kòlèg pran chif ou, ${when}`,
        pt: `Pedir a colegas que cubram seu turno, ${when}`,
        uk: `Попросити колег підмінити вас, ${when}`,
      },
      lang,
    ),
    detail: pick(
      {
        en: 'I ask free coworkers one at a time. Your manager approves, and you stay on the shift until then.',
        es: 'Pregunto a compañeros libres, uno a la vez. Tu gerente aprueba, y sigues en el turno hasta entonces.',
        tr: 'Boştaki iş arkadaşlarına tek tek sorarım. Onay yöneticinde; o zamana kadar vardiya sende.',
        ht: 'M ap mande kòlèg ki disponib youn apre lòt. Manadjè ou apwouve, epi ou rete sou chif la jiskaske sa fèt.',
        pt: 'Pergunto a colegas livres, um de cada vez. Seu gerente aprova, e você continua no turno até lá.',
        uk: 'Я питаю вільних колег по одному. Погоджує керівник, а до того зміна ваша.',
      },
      lang,
    ),
  }),
  scheduleChange: (lang: HugoLang) =>
    pick(
      {
        en: 'Send your lead a schedule-change request',
        es: 'Enviar a tu líder una solicitud de cambio de horario',
        tr: 'Sorumluna vardiya değişikliği isteği gönder',
        ht: 'Voye yon demann chanjman orè bay chèf ou',
        pt: 'Enviar ao seu líder um pedido de mudança de horário',
        uk: 'Надіслати керівнику запит на зміну графіка',
      },
      lang,
    ),
  askSupervisor: (lang: HugoLang, who: string | null) =>
    who
      ? pick({ en: `Pass your question to ${who}`, es: `Pasar tu pregunta a ${who}`, tr: `Sorunu ${who} adlı kişiye ilet`, ht: `Pase kesyon ou bay ${who}`, pt: `Passar sua pergunta para ${who}`, uk: `Передати ваше запитання: ${who}` }, lang)
      : pick({ en: 'Pass your question to your supervisor', es: 'Pasar tu pregunta a tu supervisor', tr: 'Sorunu yöneticine ilet', ht: 'Pase kesyon ou bay sipèvizè ou', pt: 'Passar sua pergunta para seu supervisor', uk: 'Передати ваше запитання керівнику' }, lang),
  keepGoing: (lang: HugoLang, n: number) => ({
    title: pick({ en: 'Keep working on this goal', es: 'Seguir trabajando en esta meta', tr: 'Bu hedef üzerinde çalışmaya devam et', ht: 'Kontinye travay sou objektif sa a', pt: 'Continuar trabalhando nesta meta', uk: 'Продовжити роботу над цією ціллю' }, lang),
    detail: pick(
      {
        en: `I've taken ${n} steps on it. I can take up to ${n} more.`,
        es: `Ya di ${n} pasos. Puedo dar hasta ${n} más.`,
        tr: `Bunun için ${n} adım attım. ${n} adım daha atabilirim.`,
        ht: `Mwen fè ${n} etap deja. Mwen ka fè jiska ${n} ankò.`,
        pt: `Já dei ${n} passos. Posso dar até ${n} a mais.`,
        uk: `Я зробив ${n} кроків. Можу зробити ще до ${n}.`,
      },
      lang,
    ),
  }),
  // A scheduling desk's steps (staff copy).
  chase: (lang: HugoLang, day: string, count: number) => ({
    title: staff(lang, `Chase confirmations for ${day}`, `Pedir confirmaciones para ${day}`),
    detail: staff(
      lang,
      `${count} ${count === 1 ? 'shift' : 'shifts'} to confirm. I nudge each person and tell you who's still out.`,
      `${count} ${count === 1 ? 'turno' : 'turnos'} por confirmar. Aviso a cada persona y te digo quién falta.`,
    ),
  }),
  offerShift: (lang: HugoLang, name: string, position: string, when: string, site: string | null) => ({
    title: staff(lang, `Give ${name} the ${position} shift, ${when}`, `Dar a ${name} el turno de ${position}, ${when}`),
    detail: site,
  }),
  crew: (lang: HugoLang, people: number, body: string, names: string) => ({
    title: staff(lang, `Text ${people} ${people === 1 ? 'person' : 'people'}: “${body}”`, `Enviar un texto a ${people} ${people === 1 ? 'persona' : 'personas'}: “${body}”`),
    detail: names,
  }),
};

/** The notices a goal sends (the disclosure line is added where they are sent). */
export const GOAL_NOTICE = {
  proposed: (lang: HugoLang, goal: string, title: string): Notice => ({
    subject: pick(
      {
        en: 'One step to approve for your goal',
        es: 'Un paso por aprobar para tu meta',
        tr: 'Hedefin için onaylanacak bir adım',
        ht: 'Yon etap pou w apwouve pou objektif ou',
        pt: 'Um passo para aprovar na sua meta',
        uk: 'Крок для вашої цілі чекає на схвалення',
      },
      lang,
    ),
    body: pick(
      {
        en: `For ${q(lang, goal)}: ${title}. Nothing happens until you approve it.`,
        es: `Para ${q(lang, goal)}: ${title}. No pasa nada hasta que lo apruebes.`,
        tr: `${q(lang, goal)} için: ${title}. Sen onaylamadan hiçbir şey olmaz.`,
        ht: `Pou ${q(lang, goal)}: ${title}. Anyen p ap fèt jiskaske ou apwouve l.`,
        pt: `Para ${q(lang, goal)}: ${title}. Nada acontece até você aprovar.`,
        uk: `Для ${q(lang, goal)}: ${title}. Нічого не станеться, доки ви не схвалите.`,
      },
      lang,
    ),
  }),
  update: (lang: HugoLang, goal: string, message: string): Notice => ({
    subject: pick({ en: 'An update on your goal', es: 'Novedades sobre tu meta', tr: 'Hedefinle ilgili bir gelişme', ht: 'Nouvèl sou objektif ou', pt: 'Novidades sobre sua meta', uk: 'Новини щодо вашої цілі' }, lang),
    body: `${q(lang, goal)} — ${message}`,
  }),
  done: (lang: HugoLang, goal: string, summary: string): Notice => ({
    subject: pick({ en: 'Your goal is done', es: 'Tu meta está cumplida', tr: 'Hedefin tamamlandı', ht: 'Objektif ou fini', pt: 'Sua meta foi concluída', uk: 'Вашу ціль досягнуто' }, lang),
    body: `${q(lang, goal)} — ${summary}`,
  }),
  gaveUp: (lang: HugoLang, goal: string, summary: string): Notice => ({
    subject: pick({ en: "I couldn't finish your goal", es: 'No pude terminar tu meta', tr: 'Hedefini tamamlayamadım', ht: 'Mwen pa t ka fini objektif ou', pt: 'Não consegui concluir sua meta', uk: 'Я не зміг досягти вашої цілі' }, lang),
    body: `${q(lang, goal)} — ${summary}`,
  }),
  expired: (lang: HugoLang, goal: string): Notice => ({
    subject: pick({ en: "I've stopped working on your goal", es: 'Dejé de trabajar en tu meta', tr: 'Hedefin üzerindeki çalışmayı bıraktım', ht: 'Mwen sispann travay sou objektif ou', pt: 'Parei de trabalhar na sua meta', uk: 'Я припинив роботу над вашою ціллю' }, lang),
    body: pick(
      {
        en: `${q(lang, goal)} reached its end date. Give it to me again if you still want it.`,
        es: `${q(lang, goal)} llegó a su fecha final. Dámela otra vez si todavía la quieres.`,
        tr: `${q(lang, goal)} bitiş tarihine ulaştı. Hâlâ istiyorsan bana yeniden ver.`,
        ht: `${q(lang, goal)} rive nan dat li fini. Ban m li ankò si ou toujou vle l.`,
        pt: `${q(lang, goal)} chegou à data final. Me passe de novo se ainda quiser.`,
        uk: `Для ${q(lang, goal)} настала кінцева дата. Доручіть її мені знову, якщо це ще потрібно.`,
      },
      lang,
    ),
  }),
  keepGoing: (lang: HugoLang, goal: string, n: number): Notice => ({
    subject: pick({ en: 'Keep working on your goal?', es: '¿Sigo trabajando en tu meta?', tr: 'Hedefin üzerinde çalışmaya devam edeyim mi?', ht: 'Pou m kontinye travay sou objektif ou?', pt: 'Continuo trabalhando na sua meta?', uk: 'Продовжити роботу над вашою ціллю?' }, lang),
    body: pick(
      {
        en: `I've taken ${n} steps on ${q(lang, goal)}. Want me to keep going?`,
        es: `Ya di ${n} pasos en ${q(lang, goal)}. ¿Quieres que siga?`,
        tr: `${q(lang, goal)} için ${n} adım attım. Devam etmemi ister misin?`,
        ht: `Mwen fè ${n} etap sou ${q(lang, goal)}. Ou vle m kontinye?`,
        pt: `Já dei ${n} passos em ${q(lang, goal)}. Quer que eu continue?`,
        uk: `Я зробив ${n} кроків для ${q(lang, goal)}. Продовжувати?`,
      },
      lang,
    ),
  }),
};
