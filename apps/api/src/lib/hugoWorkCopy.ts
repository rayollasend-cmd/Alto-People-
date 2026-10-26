import { toCallOutLang, whenLabel, type CallOutLang } from './callOuts.js';
import { disclosureLine } from './agentDisclosure.js';

/**
 * The words of the notices Hugo's tasks and notes send (lib/hugoTasks,
 * lib/hugoNotes), in the six languages associates read. Everything else a
 * task says — its title, its trail, its choices — the web renders from the
 * codes in packages/shared/src/hugoWork.ts.
 *
 * A notice says what happened and what, if anything, the person can do;
 * it never says they must work, and it ends with the AI disclosure.
 */

export type HugoLang = CallOutLang;
export const toHugoLang = toCallOutLang;

const LOCALES: Record<HugoLang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };

/** "Sat, Oct 31, 7:00 AM" in the store's zone and the reader's language. */
export const hugoWhen = (d: Date, tz: string, lang: HugoLang): string => whenLabel(d, tz, lang);

/** "Sat, Oct 31" for a calendar day (YYYY-MM-DD). */
export function hugoDay(ymd: string, lang: HugoLang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
}

/** "Oct 3 – Oct 16" for a pay period. */
export function hugoPeriod(start: string, end: string, lang: HugoLang): string {
  const f = new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `${f.format(new Date(`${start}T12:00:00Z`))} – ${f.format(new Date(`${end}T12:00:00Z`))}`;
}

/**
 * The disclosure as every agent notice carries it (lib/agentDisclosure);
 * the three languages that module doesn't speak get the same sentence here.
 */
export function hugoDisclosure(lang: HugoLang, agentName: string, ownerName: string | null, manager = 'supervisor'): string {
  if (lang === 'en' || lang === 'es' || lang === 'tr') return disclosureLine({ agentName, ownerName, lang });
  const who = ownerName;
  if (lang === 'ht') return who ? `${agentName} voye sa, yon ajan IA — ${who} reponn pou li.` : `${agentName} voye sa, yon ajan IA — ${manager} ou reponn pou li.`;
  if (lang === 'pt') return who ? `Enviado por ${agentName}, um agente de IA — ${who} responde por ele.` : `Enviado por ${agentName}, um agente de IA — seu ${manager} responde por ele.`;
  return who ? `Надіслано ${agentName}, агентом ШІ — за нього відповідає ${who}.` : `Надіслано ${agentName}, агентом ШІ — за нього відповідає ваш ${manager}.`;
}

type Six = Record<HugoLang, string>;
type Notice = { subject: string; body: string };
const pick = (w: Six, lang: HugoLang) => w[lang];

export const HUGO_NOTICE = {
  coverDone: (lang: HugoLang, coworker: string, when: string): Notice => ({
    subject: pick({ en: 'Your shift is covered', es: 'Tu turno está cubierto', tr: 'Vardiyan devredildi', ht: 'Yon moun pran chif ou', pt: 'Seu turno está coberto', uk: 'Вашу зміну взяли' }, lang),
    body: pick(
      {
        en: `Your manager approved the swap: ${coworker} is working ${when} instead of you.`,
        es: `Tu gerente aprobó el cambio: ${coworker} trabajará ${when} en tu lugar.`,
        tr: `Yöneticin değişimi onayladı: ${when} vardiyasında senin yerine ${coworker} çalışacak.`,
        ht: `Manadjè ou apwouve chanjman an: ${coworker} ap travay ${when} nan plas ou.`,
        pt: `Seu gerente aprovou a troca: ${coworker} vai trabalhar ${when} no seu lugar.`,
        uk: `Керівник погодив обмін: ${coworker} працюватиме ${when} замість вас.`,
      },
      lang,
    ),
  }),
  coverNoOne: (lang: HugoLang, asked: number, when: string): Notice => ({
    subject: pick({ en: 'No one could take your shift yet', es: 'Nadie pudo tomar tu turno todavía', tr: 'Vardiyanı henüz kimse alamadı', ht: 'Pèsonn pa t ka pran chif ou toujou', pt: 'Ninguém pôde pegar seu turno ainda', uk: 'Вашу зміну поки ніхто не взяв' }, lang),
    body: pick(
      {
        en: `I asked ${asked} coworker${asked === 1 ? '' : 's'} about ${when}; none could take it. You're still on this shift. I can keep trying, or pass it to your supervisor.`,
        es: `Pregunté a ${asked} compañero${asked === 1 ? '' : 's'} por ${when}; nadie pudo tomarlo. Sigues en este turno. Puedo seguir intentando o pasárselo a tu supervisor.`,
        tr: `${when} için ${asked} iş arkadaşına sordum; kimse alamadı. Bu vardiya hâlâ sende. Denemeye devam edebilir ya da yöneticine iletebilirim.`,
        ht: `Mwen mande ${asked} kòlèg pou ${when}; pèsonn pa t ka pran l. Ou toujou sou chif sa a. Mwen ka kontinye eseye, oswa pase l bay sipèvizè ou.`,
        pt: `Perguntei a ${asked} colega${asked === 1 ? '' : 's'} sobre ${when}; ninguém pôde pegar. Você continua neste turno. Posso continuar tentando ou passar para seu supervisor.`,
        uk: `Я запитав ${asked} колег про ${when}; ніхто не зміг. Зміна досі ваша. Я можу шукати далі або передати це вашому керівнику.`,
      },
      lang,
    ),
  }),
  coverRejected: (lang: HugoLang, when: string): Notice => ({
    subject: pick({ en: "Your swap wasn't approved", es: 'Tu cambio no fue aprobado', tr: 'Değişimin onaylanmadı', ht: 'Yo pa apwouve chanjman ou', pt: 'Sua troca não foi aprovada', uk: 'Обмін не погоджено' }, lang),
    body: pick(
      {
        en: `Your manager didn't approve the swap for ${when}. You're still on this shift.`,
        es: `Tu gerente no aprobó el cambio para ${when}. Sigues en este turno.`,
        tr: `Yöneticin ${when} için değişimi onaylamadı. Bu vardiya hâlâ sende.`,
        ht: `Manadjè ou pa apwouve chanjman pou ${when}. Ou toujou sou chif sa a.`,
        pt: `Seu gerente não aprovou a troca para ${when}. Você continua neste turno.`,
        uk: `Керівник не погодив обмін на ${when}. Зміна досі ваша.`,
      },
      lang,
    ),
  }),
  coverExpired: (lang: HugoLang, when: string): Notice => ({
    subject: pick({ en: "Your shift wasn't covered", es: 'Tu turno no fue cubierto', tr: 'Vardiyan devredilemedi', ht: 'Pèsonn pa t pran chif ou', pt: 'Seu turno não foi coberto', uk: 'Зміну ніхто не взяв' }, lang),
    body: pick(
      {
        en: `No one took ${when}, and it starts soon, so I stopped asking. You're still on this shift. If you can't make it, call off in the app so your supervisor knows.`,
        es: `Nadie tomó ${when} y empieza pronto, así que dejé de preguntar. Sigues en este turno. Si no puedes ir, avisa en la app para que tu supervisor lo sepa.`,
        tr: `${when} vardiyasını kimse almadı ve yakında başlıyor, bu yüzden sormayı bıraktım. Vardiya hâlâ sende. Gelemeyeceksen yöneticinin bilmesi için uygulamadan bildir.`,
        ht: `Pèsonn pa pran ${when}, epi li pral kòmanse byento, kidonk mwen sispann mande. Ou toujou sou chif sa a. Si ou pa ka vini, avèti nan aplikasyon an pou sipèvizè ou konnen.`,
        pt: `Ninguém pegou ${when}, e ele começa em breve, então parei de perguntar. Você continua neste turno. Se não puder ir, avise pelo app para seu supervisor saber.`,
        uk: `Ніхто не взяв ${when}, а зміна скоро, тому я перестав питати. Зміна досі ваша. Якщо не зможете, повідомте в застосунку, щоб керівник знав.`,
      },
      lang,
    ),
  }),
  openShifts: (lang: HugoLang, count: number, when: string, site: string | null): Notice => ({
    subject:
      count === 1
        ? pick({ en: 'An open shift fits you', es: 'Un turno abierto te queda', tr: 'Sana uyan açık bir vardiya var', ht: 'Gen yon chif ouvè ki bon pou ou', pt: 'Um turno aberto combina com você', uk: 'Є вільна зміна для вас' }, lang)
        : pick({ en: `${count} open shifts fit you`, es: `${count} turnos abiertos te quedan`, tr: `Sana uyan ${count} açık vardiya var`, ht: `${count} chif ouvè bon pou ou`, pt: `${count} turnos abertos combinam com você`, uk: `Є вільні зміни для вас: ${count}` }, lang),
    body: pick(
      {
        en: `${count === 1 ? 'It is' : 'The first is'} ${when}${site ? ` at ${site}` : ''}. Open the marketplace to pick it up.`,
        es: `${count === 1 ? 'Es el' : 'El primero es el'} ${when}${site ? ` en ${site}` : ''}. Abre el mercado de turnos para tomarlo.`,
        tr: `${count === 1 ? 'Vardiya' : 'İlki'} ${when}${site ? `, ${site}` : ''}. Almak için vardiya pazarını aç.`,
        ht: `${count === 1 ? 'Se' : 'Premye a se'} ${when}${site ? ` nan ${site}` : ''}. Louvri mache chif yo pou pran l.`,
        pt: `${count === 1 ? 'É' : 'O primeiro é'} ${when}${site ? ` em ${site}` : ''}. Abra o mercado de turnos para pegar.`,
        uk: `${count === 1 ? 'Це' : 'Перша —'} ${when}${site ? `, ${site}` : ''}. Відкрийте біржу змін, щоб узяти її.`,
      },
      lang,
    ),
  }),
  paycheck: (lang: HugoLang, period: string): Notice => ({
    subject: pick({ en: 'Your paycheck is ready', es: 'Tu pago está listo', tr: 'Maaşın hazır', ht: 'Chèk ou pare', pt: 'Seu pagamento está pronto', uk: 'Виплата готова' }, lang),
    body: pick(
      {
        en: `Your pay for ${period} is in. Tap to see your paystub.`,
        es: `Tu pago de ${period} ya está. Toca para ver tu talón de pago.`,
        tr: `${period} dönemi maaşın yattı. Bordronu görmek için dokun.`,
        ht: `Peman ou pou ${period} rive. Tape pou wè fich peman ou.`,
        pt: `Seu pagamento de ${period} saiu. Toque para ver seu holerite.`,
        uk: `Виплата за ${period} надійшла. Торкніться, щоб побачити розрахунковий лист.`,
      },
      lang,
    ),
  }),
  docVerified: (lang: HugoLang, doc: string): Notice => ({
    subject: pick({ en: 'Your document was approved', es: 'Tu documento fue aprobado', tr: 'Belgen onaylandı', ht: 'Yo apwouve dokiman ou', pt: 'Seu documento foi aprovado', uk: 'Документ схвалено' }, lang),
    body: pick(
      {
        en: `${doc} is verified. Nothing else to do.`,
        es: `${doc} está verificado. No tienes que hacer nada más.`,
        tr: `${doc} doğrulandı. Başka bir şey yapmana gerek yok.`,
        ht: `${doc} verifye. Ou pa bezwen fè anyen ankò.`,
        pt: `${doc} foi verificado. Não precisa fazer mais nada.`,
        uk: `${doc} перевірено. Більше нічого робити не треба.`,
      },
      lang,
    ),
  }),
  docRejected: (lang: HugoLang, doc: string, reason: string | null): Notice => ({
    subject: pick({ en: 'Your document needs another look', es: 'Tu documento necesita revisión', tr: 'Belgenin yeniden bakılması gerek', ht: 'Dokiman ou bezwen yon lòt koudèy', pt: 'Seu documento precisa de ajuste', uk: 'Документ потребує уваги' }, lang),
    body: pick(
      {
        en: `${doc} wasn't accepted${reason ? `: ${reason}` : ''}. Upload a new one when you can.`,
        es: `${doc} no fue aceptado${reason ? `: ${reason}` : ''}. Sube uno nuevo cuando puedas.`,
        tr: `${doc} kabul edilmedi${reason ? `: ${reason}` : ''}. Uygun olduğunda yenisini yükle.`,
        ht: `Yo pa aksepte ${doc}${reason ? `: ${reason}` : ''}. Voye yon lòt lè ou kapab.`,
        pt: `${doc} não foi aceito${reason ? `: ${reason}` : ''}. Envie um novo quando puder.`,
        uk: `${doc} не прийнято${reason ? `: ${reason}` : ''}. Завантажте новий, коли зможете.`,
      },
      lang,
    ),
  }),
  chaseDone: (lang: HugoLang, day: string, total: number): Notice => ({
    subject: pick({ en: `Everyone confirmed for ${day}`, es: `Todos confirmaron para el ${day}`, tr: `${day} için herkes onayladı`, ht: `Tout moun konfime pou ${day}`, pt: `Todos confirmaram para ${day}`, uk: `Усі підтвердили на ${day}` }, lang),
    body: pick(
      {
        en: `All ${total} shift${total === 1 ? ' is' : 's are'} confirmed.`,
        es: `${total === 1 ? 'El turno está confirmado' : `Los ${total} turnos están confirmados`}.`,
        tr: `${total} vardiyanın hepsi onaylandı.`,
        ht: `Tout ${total} chif yo konfime.`,
        pt: `${total === 1 ? 'O turno está confirmado' : `Os ${total} turnos estão confirmados`}.`,
        uk: `Підтверджено всі зміни: ${total}.`,
      },
      lang,
    ),
  }),
  chaseCalledOff: (lang: HugoLang, name: string, when: string): Notice => ({
    subject: pick({ en: `${name} can't make it`, es: `${name} no puede ir`, tr: `${name} gelemiyor`, ht: `${name} pa ka vini`, pt: `${name} não pode ir`, uk: `${name} не зможе вийти` }, lang),
    body: pick(
      {
        en: `${name} said they can't work ${when}. The shift needs cover.`,
        es: `${name} dijo que no puede trabajar ${when}. El turno necesita cobertura.`,
        tr: `${name}, ${when} çalışamayacağını söyledi. Vardiyanın devralınması gerek.`,
        ht: `${name} di li pa ka travay ${when}. Chif la bezwen yon moun.`,
        pt: `${name} disse que não pode trabalhar ${when}. O turno precisa de cobertura.`,
        uk: `${name} повідомляє, що не зможе працювати ${when}. Зміні потрібна заміна.`,
      },
      lang,
    ),
  }),
  chaseUnconfirmed: (lang: HugoLang, day: string, confirmed: number, total: number, names: string): Notice => ({
    subject: pick(
      { en: `${total - confirmed} still unconfirmed for ${day}`, es: `${total - confirmed} sin confirmar para el ${day}`, tr: `${day} için ${total - confirmed} onaysız`, ht: `${total - confirmed} poko konfime pou ${day}`, pt: `${total - confirmed} sem confirmar para ${day}`, uk: `Не підтвердили на ${day}: ${total - confirmed}` },
      lang,
    ),
    body: pick(
      {
        en: `${confirmed} of ${total} confirmed. Still waiting on: ${names}. I can nudge them again.`,
        es: `${confirmed} de ${total} confirmados. Aún falta: ${names}. Puedo recordarles otra vez.`,
        tr: `${total} kişiden ${confirmed} onayladı. Hâlâ beklenen: ${names}. Onlara yeniden hatırlatabilirim.`,
        ht: `${confirmed} sou ${total} konfime. N ap tann toujou: ${names}. Mwen ka raple yo ankò.`,
        pt: `${confirmed} de ${total} confirmados. Ainda falta: ${names}. Posso lembrá-los de novo.`,
        uk: `Підтвердили ${confirmed} з ${total}. Досі чекаємо: ${names}. Можу нагадати їм ще раз.`,
      },
      lang,
    ),
  }),
  noteOpenShift: (lang: HugoLang, when: string, site: string | null): Notice => ({
    subject: pick({ en: 'An open shift fits your availability', es: 'Un turno abierto encaja con tu disponibilidad', tr: 'Uygunluğuna uyan açık bir vardiya var', ht: 'Yon chif ouvè koresponn ak disponiblite ou', pt: 'Um turno aberto combina com sua disponibilidade', uk: 'Вільна зміна збігається з вашою доступністю' }, lang),
    body: pick(
      {
        en: `${when}${site ? ` at ${site}` : ''} is open. If you'd like the hours, it's yours to pick up — no need to answer otherwise.`,
        es: `${when}${site ? ` en ${site}` : ''} está abierto. Si quieres las horas, puedes tomarlo; si no, no tienes que responder.`,
        tr: `${when}${site ? `, ${site}` : ''} açık. Saatleri istersen alabilirsin; istemezsen yanıt vermene gerek yok.`,
        ht: `${when}${site ? ` nan ${site}` : ''} ouvè. Si ou vle lè yo, ou ka pran l — sinon ou pa bezwen reponn.`,
        pt: `${when}${site ? ` em ${site}` : ''} está aberto. Se quiser as horas, pode pegar — se não, não precisa responder.`,
        uk: `${when}${site ? `, ${site}` : ''} вільна. Якщо хочете ці години, можете взяти — інакше відповідати не потрібно.`,
      },
      lang,
    ),
  }),
  noteDirectDeposit: (lang: HugoLang, payday: string): Notice => ({
    subject: pick({ en: 'Add direct deposit before payday', es: 'Agrega tu depósito directo antes del día de pago', tr: 'Maaş gününden önce banka hesabını ekle', ht: 'Ajoute depo dirèk anvan jou peman', pt: 'Cadastre o depósito direto antes do pagamento', uk: 'Додайте прямий депозит до дня виплати' }, lang),
    body: pick(
      {
        en: `Your first payday is ${payday} and there's no bank account on file yet. Add one so your pay goes straight in.`,
        es: `Tu primer día de pago es el ${payday} y aún no hay una cuenta bancaria registrada. Agrégala para que tu pago llegue directo.`,
        tr: `İlk maaş günün ${payday} ve kayıtlı bir banka hesabın yok. Maaşının doğrudan yatması için bir hesap ekle.`,
        ht: `Premye jou peman ou se ${payday}, epi poko gen kont labank sou dosye a. Ajoute youn pou lajan ou ale dirèkteman.`,
        pt: `Seu primeiro pagamento é ${payday} e ainda não há conta bancária cadastrada. Adicione uma para receber direto.`,
        uk: `Ваша перша виплата ${payday}, а банківського рахунку ще немає. Додайте його, щоб гроші надходили напряму.`,
      },
      lang,
    ),
  }),
  swapClosed: (lang: HugoLang, requester: string, when: string): Notice => ({
    subject: pick({ en: 'Swap request closed', es: 'Solicitud de cambio cerrada', tr: 'Değişim isteği kapandı', ht: 'Demann chanjman an fèmen', pt: 'Pedido de troca encerrado', uk: 'Запит на обмін закрито' }, lang),
    body: pick(
      {
        en: `The request to take ${requester}'s shift ${when} has closed. Nothing to do.`,
        es: `La solicitud para tomar el turno de ${requester} (${when}) se cerró. No tienes que hacer nada.`,
        tr: `${requester} adlı kişinin ${when} vardiyasını devralma isteği kapandı. Bir şey yapmana gerek yok.`,
        ht: `Demann pou pran chif ${requester} ${when} fèmen. Ou pa bezwen fè anyen.`,
        pt: `O pedido para pegar o turno de ${requester} (${when}) foi encerrado. Não precisa fazer nada.`,
        uk: `Запит узяти зміну ${requester} (${when}) закрито. Нічого робити не потрібно.`,
      },
      lang,
    ),
  }),
  /** What reaches the supervisor when the person asks Hugo to pass a shift on. */
  coverHandoff: (lang: HugoLang, when: string, asked: number, agentName: string): string =>
    pick(
      {
        en: `I need cover for my shift ${when}. ${agentName} asked ${asked} coworker${asked === 1 ? '' : 's'} and it isn't covered yet. Can you help?`,
        es: `Necesito que alguien cubra mi turno ${when}. ${agentName} preguntó a ${asked} compañero${asked === 1 ? '' : 's'} y aún no está cubierto. ¿Me puedes ayudar?`,
        tr: `${when} vardiyam için birine ihtiyacım var. ${agentName} ${asked} iş arkadaşına sordu, henüz kimse almadı. Yardım edebilir misin?`,
        ht: `Mwen bezwen yon moun pou chif mwen ${when}. ${agentName} mande ${asked} kòlèg epi pèsonn poko pran l. Èske ou ka ede m?`,
        pt: `Preciso de alguém para cobrir meu turno ${when}. ${agentName} perguntou a ${asked} colega${asked === 1 ? '' : 's'} e ainda não está coberto. Pode me ajudar?`,
        uk: `Мені потрібна заміна на зміну ${when}. ${agentName} запитав ${asked} колег, але заміни поки немає. Допоможете?`,
      },
      lang,
    ),
} as const;
