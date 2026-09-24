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
        en: { title: 'Jump anywhere', body: 'Search pages, people and clients from here — or press ⌘K (Ctrl+K) on any page.' },
        es: { title: 'Ve a cualquier lugar', body: 'Busca páginas, personas y clientes desde aquí — o pulsa ⌘K (Ctrl+K) en cualquier página.' },
      },
      {
        anchor: 'nav',
        en: { title: 'Your modules', body: 'Everything you can open lives here. Hover an item and tap the star to pin it to the top.' },
        es: { title: 'Tus módulos', body: 'Todo lo que puedes abrir está aquí. Pasa el cursor sobre un elemento y toca la estrella para fijarlo arriba.' },
      },
      {
        anchor: 'bell',
        en: { title: 'Waiting on you', body: 'Approvals, requests and alerts land in the bell. Opening it clears the badge.' },
        es: { title: 'Te está esperando', body: 'Aprobaciones, solicitudes y alertas llegan a la campana. Al abrirla, se limpia el indicador.' },
      },
      {
        anchor: 'help',
        en: { title: 'Help for this page', body: 'On any page, this opens what the page is for, what you can do here, and related help-center articles.' },
        es: { title: 'Ayuda para esta página', body: 'En cualquier página, esto muestra para qué sirve, qué puedes hacer aquí y artículos relacionados del centro de ayuda.' },
      },
    ],
  },
];

export function tourFor(pathname: string): Tour | null {
  return TOURS.find((t) => t.match.test(pathname)) ?? null;
}

export function stepCopy(step: TourStep, lang: Lang): { title: string; body: string } {
  return lang === 'es' ? step.es : step.en;
}

export const seenKey = (tourId: string, userId: string) => `alto.tour.${tourId}.${userId}`;
