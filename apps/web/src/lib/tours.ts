import type { Lang } from './i18n';

/**
 * Coach marks — a handful of "this is here" callouts the first time
 * someone lands on a surface, anchored to elements that carry a
 * `data-tour` attribute. A tour is skipped entirely if any anchor is
 * missing (a role that has no sidebar, a phone with no search box), and
 * remembered per person once seen or dismissed.
 */

export interface TourStep {
  /** Matches `[data-tour="…"]`. */
  anchor: string;
  en: { title: string; body: string };
  es: { title: string; body: string };
  /** The associate app's other languages (deep audit 2026-10-29, ASSOC-11); English when absent. */
  tr?: { title: string; body: string };
  ht?: { title: string; body: string };
  pt?: { title: string; body: string };
  uk?: { title: string; body: string };
  /**
   * The copy for a person whose search finds client accounts, with
   * `{clients}` standing for the tenant's own word (term('label.clients')).
   * Without it — a direct employer (a hotel: no clients module) or a client
   * user, who can't search other clients — `en`/`es` are used as they are.
   * The search step hard-coded "people and clients" for every tenant and
   * role (deep audit LEAD-13).
   */
  withClients?: { en: { title: string; body: string }; es: { title: string; body: string } };
  /** For a reader whose search finds pages and help but not people (no view:org: an associate, a driver, a client user). */
  pagesOnly?: Record<'en' | 'es' | 'tr' | 'ht' | 'pt' | 'uk', { title: string; body: string }>;
}

/** Who is reading the tour: the tenant's word for clients when they apply, else null. */
export interface TourContext {
  clients: string | null;
  /** False when the reader's search doesn't reach the people directory (CommandPalette: view:org). */
  findsPeople?: boolean;
}

export interface Tour {
  id: string;
  match: RegExp;
  steps: TourStep[];
}

export const TOURS: Tour[] = [
  {
    id: 'shell-v1',
    match: /^\/$/,
    steps: [
      {
        anchor: 'search',
        en: { title: 'Jump anywhere', body: 'Search pages and people from here — or press ⌘K (Ctrl+K) on any page.' },
        es: { title: 'Ve a cualquier lugar', body: 'Busca páginas y personas desde aquí — o pulsa ⌘K (Ctrl+K) en cualquier página.' },
        tr: { title: 'Her yere hızlıca gidin', body: 'Sayfaları ve kişileri buradan arayın — ya da herhangi bir sayfada ⌘K (Ctrl+K) tuşlarına basın.' },
        ht: { title: 'Ale nenpòt kote', body: 'Chèche paj ak moun isit la — oswa peze ⌘K (Ctrl+K) sou nenpòt paj.' },
        pt: { title: 'Vá para qualquer lugar', body: 'Pesquise páginas e pessoas por aqui — ou pressione ⌘K (Ctrl+K) em qualquer página.' },
        uk: { title: 'Переходьте будь-куди', body: 'Шукайте сторінки й людей звідси — або натисніть ⌘K (Ctrl+K) на будь-якій сторінці.' },
        withClients: {
          en: { title: 'Jump anywhere', body: 'Search pages, people and {clients} from here — or press ⌘K (Ctrl+K) on any page.' },
          es: { title: 'Ve a cualquier lugar', body: 'Busca páginas, personas y {clients} desde aquí — o pulsa ⌘K (Ctrl+K) en cualquier página.' },
        },
        pagesOnly: {
          en: { title: 'Jump anywhere', body: 'Search pages and help from here — or press ⌘K (Ctrl+K) on any page.' },
          es: { title: 'Ve a cualquier lugar', body: 'Busca páginas y ayuda desde aquí — o pulsa ⌘K (Ctrl+K) en cualquier página.' },
          tr: { title: 'Her yere hızlıca gidin', body: 'Sayfaları ve yardım konularını buradan arayın — ya da herhangi bir sayfada ⌘K (Ctrl+K) tuşlarına basın.' },
          ht: { title: 'Ale nenpòt kote', body: 'Chèche paj ak èd isit la — oswa peze ⌘K (Ctrl+K) sou nenpòt paj.' },
          pt: { title: 'Vá para qualquer lugar', body: 'Pesquise páginas e ajuda por aqui — ou pressione ⌘K (Ctrl+K) em qualquer página.' },
          uk: { title: 'Переходьте будь-куди', body: 'Шукайте сторінки й довідку звідси — або натисніть ⌘K (Ctrl+K) на будь-якій сторінці.' },
        },
      },
      {
        anchor: 'nav',
        en: { title: 'Your modules', body: 'Everything you can open lives here. Hover an item and tap the star to pin it to the top.' },
        es: { title: 'Tus módulos', body: 'Todo lo que puedes abrir está aquí. Pasa el cursor sobre un elemento y toca la estrella para fijarlo arriba.' },
        tr: { title: 'Bölümleriniz', body: 'Açabildiğiniz her şey burada. Bir öğenin üzerine gelin ve yıldıza dokunarak en üste sabitleyin.' },
        ht: { title: 'Seksyon ou yo', body: 'Tout sa ou ka louvri yo la a. Pase sourit la sou yon eleman epi tape zetwal la pou kole l anlè.' },
        pt: { title: 'Suas seções', body: 'Tudo o que você pode abrir fica aqui. Passe o cursor sobre um item e toque na estrela para fixá-lo no topo.' },
        uk: { title: 'Ваші розділи', body: 'Усе, що ви можете відкрити, — тут. Наведіть курсор на пункт і торкніться зірочки, щоб закріпити його вгорі.' },
      },
      {
        anchor: 'bell',
        en: { title: 'Waiting on you', body: 'Approvals, requests and alerts land in the bell. Opening it clears the badge.' },
        es: { title: 'Te está esperando', body: 'Aprobaciones, solicitudes y alertas llegan a la campana. Al abrirla, se limpia el indicador.' },
        tr: { title: 'Sizi bekleyenler', body: 'Onaylar, talepler ve uyarılar zile gelir. Zili açtığınızda rozet temizlenir.' },
        ht: { title: 'Sa k ap tann ou', body: 'Apwobasyon, demann ak alèt yo rive nan klòch la. Lè ou louvri l, siy la efase.' },
        pt: { title: 'Esperando por você', body: 'Aprovações, pedidos e alertas chegam ao sino. Ao abri-lo, o indicador some.' },
        uk: { title: 'Чекає на вас', body: 'Погодження, запити й сповіщення надходять у дзвіночок. Коли ви його відкриваєте, позначка зникає.' },
      },
      {
        anchor: 'help',
        en: { title: 'Help for this page', body: 'On any page, this opens what the page is for, what you can do here, and related help-center articles.' },
        es: { title: 'Ayuda para esta página', body: 'En cualquier página, esto muestra para qué sirve, qué puedes hacer aquí y artículos relacionados del centro de ayuda.' },
        tr: { title: 'Bu sayfa için yardım', body: 'Her sayfada bu düğme, sayfanın ne işe yaradığını, burada neler yapabileceğinizi ve ilgili yardım merkezi makalelerini açar.' },
        ht: { title: 'Èd pou paj sa a', body: 'Sou nenpòt paj, sa a montre pou kisa paj la ye, sa ou ka fè la a, ak atik sant èd ki gen rapò.' },
        pt: { title: 'Ajuda para esta página', body: 'Em qualquer página, isto mostra para que ela serve, o que você pode fazer aqui e artigos relacionados da central de ajuda.' },
        uk: { title: 'Довідка для цієї сторінки', body: 'На будь-якій сторінці це відкриває, для чого вона, що тут можна зробити, і пов’язані статті з центру довідки.' },
      },
    ],
  },
];

export function tourFor(pathname: string): Tour | null {
  return TOURS.find((t) => t.match.test(pathname)) ?? null;
}

export function stepCopy(step: TourStep, lang: Lang, ctx: TourContext = { clients: null }): { title: string; body: string } {
  if (ctx.findsPeople === false && step.pagesOnly) return step.pagesOnly[lang as keyof typeof step.pagesOnly] ?? step.pagesOnly.en;
  const variant = ctx.clients && step.withClients ? step.withClients : step;
  // A language the client-word variant doesn't carry reads the plain step in that language.
  const copy = lang === 'es' ? variant.es : lang === 'en' ? variant.en : ((variant as TourStep)[lang] ?? step[lang] ?? variant.en);
  return ctx.clients ? { title: copy.title, body: copy.body.replace('{clients}', ctx.clients) } : copy;
}

export const seenKey = (tourId: string, userId: string) => `alto.tour.${tourId}.${userId}`;
