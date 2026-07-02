import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Hand-rolled i18n — deliberately not a library. The needs are small
 * (two languages, flat string keys, {name} interpolation) and every
 * i18n dependency drags in pluralization engines, ICU parsers, and a
 * runtime we'd ship to every phone. The dictionary lives in this chunk;
 * missing es keys fall back to en, and a missing key renders the key
 * itself so it's findable in QA instead of blank.
 *
 * Spanish first because it's the workforce's dominant second language;
 * the associate-facing core (tab bar, dashboard, schedule) is the
 * translated slice — admin surfaces stay English for now.
 */

export type Lang = 'en' | 'es';

const STORAGE_KEY = 'alto.lang';

const en = {
  // Bottom tab bar
  'tabs.home': 'Home',
  'tabs.schedule': 'Schedule',
  'tabs.clock': 'Clock',
  'tabs.timeOff': 'Time off',
  'tabs.pay': 'Pay',
  'tabs.more': 'More',
  'tabs.moreAria': 'More — open full navigation',

  // Common
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',
  'common.search': 'Search…',
  'common.language': 'Language',

  // Associate dashboard
  'dash.greeting': 'Hey {name} 👋',
  'dash.subtitle': "Here's what's on for today.",
  'dash.clock': 'Clock',
  'dash.onClock': 'On the clock',
  'dash.offClock': 'Off the clock',
  'dash.startedIn': 'Started {time} · {elapsed} in',
  'dash.kioskHint': 'Punch in with your PIN at the worksite kiosk tablet.',
  'dash.nextShift': 'Next shift',
  'dash.nothingScheduled': 'Nothing scheduled',
  'dash.managerWillPublish':
    'Your manager will publish shifts ahead of the week. Check back soon.',
  'dash.viewSchedule': 'View schedule',
  'dash.seeFullSchedule': 'See full schedule',
  'dash.lastPaystub': 'Last paystub',
  'dash.noPaystubs': 'No paystubs yet',
  'dash.firstPaystub':
    'Your first one will show up here once your manager runs payroll.',
  'dash.netWorked': 'Net · {hours}h worked',
  'dash.paidOn': 'paid {date}',
  'dash.viewPayHistory': 'View pay history',
  'dash.timeOff': 'Time off',
  'dash.noBalance': 'No balance yet',
  'dash.sickAccrues': 'Sick-leave hours accrue automatically as you work.',
  'dash.openTimeOff': 'Open time off',
  'dash.requestOrView': 'Request or view balance',
  'dash.quickLinks': 'Quick links',
  'dash.myTimesheet': 'My timesheet',
  'dash.scheduleSwaps': 'Schedule & swaps',
  'dash.documents': 'Documents',
  'dash.requestTimeOff': 'Request time off',
  'dash.loadFailed': "Couldn't load this",
  'dash.checkConnection': 'Check your connection and try again.',
  'dash.pushTitle': 'Get shift alerts on your lock screen',
  'dash.pushBody': 'New shifts, swaps, and reminders — even when the app is closed.',
  'dash.pushOn': 'Turn on',
  'dash.pushLater': 'Not now',

  // My schedule chrome
  'sched.title': 'My schedule',
  'sched.subtitle': 'Your published shifts.',
  'sched.list': 'List',
  'sched.week': 'Week',
  'sched.month': 'Month',
  'sched.viewAria': 'Schedule view',
  'sched.refresh': 'Refresh',
  'sched.upcoming': 'Upcoming',
  'sched.thisWeek': 'This week',
  'sched.nextWeek': 'Next week',
  'sched.over40': 'Over 40h — check with your manager',
  'sched.shiftsWord': '{count} shift',
  'sched.shiftsWordPlural': '{count} shifts',
  'sched.noUpcoming': 'No upcoming shifts.',
  'sched.noShifts': 'No shifts yet',
  'sched.emptyDesc':
    "When a manager publishes a shift for you, it'll show up here. Post your availability below to make scheduling easier.",
  'sched.truncated':
    'Showing your next 100 shifts — anything scheduled beyond them will appear here as earlier shifts pass.',
  'sched.showRecent': 'Show recent shifts ({count})',
  'sched.hideRecent': 'Hide recent shifts ({count})',
  'sched.loadOlder': 'Load older shifts',
  'sched.fullHistory': "That's your full shift history.",

  // Shift card
  'shift.next': 'Next',
  'shift.confirmed': 'Confirmed',
  'shift.open': 'Open',
  'shift.worked': 'Worked',
  'shift.draft': 'Draft',
  'shift.cancelled': 'Cancelled',
  'shift.workingWithYou': 'Working with you',
  'shift.noTeammates': 'No one else is scheduled alongside this shift yet.',
  'shift.managerNote': 'Note from your manager: ',
  'shift.illBeThere': "I'll be there",
  'shift.youConfirmed': 'You confirmed this shift',
  'shift.confirmedToast': 'Confirmed — your manager can see you acknowledged it.',
  'shift.offerToTeammate': 'Offer this shift to a teammate',
  'shift.offerTo': 'Offer to',
  'shift.loadingTeammates': 'Loading teammates…',
  'shift.pickTeammate': 'Pick a teammate',
  'shift.busyDuring': ' — busy during this shift',
  'shift.tradeLabel': 'Take one of their shifts in exchange (optional)',
  'shift.justHandOff': 'Nothing — just hand mine off',
  'shift.noteOptional': 'Note (optional)',
  'shift.notePlaceholder': "e.g. Doctor's appointment that morning",
  'shift.sendRequest': 'Send request',
} as const;

export type MessageKey = keyof typeof en;

const es: Record<MessageKey, string> = {
  'tabs.home': 'Inicio',
  'tabs.schedule': 'Horario',
  'tabs.clock': 'Reloj',
  'tabs.timeOff': 'Ausencias',
  'tabs.pay': 'Pago',
  'tabs.more': 'Más',
  'tabs.moreAria': 'Más — abrir la navegación completa',

  'common.retry': 'Reintentar',
  'common.cancel': 'Cancelar',
  'common.search': 'Buscar…',
  'common.language': 'Idioma',

  'dash.greeting': 'Hola {name} 👋',
  'dash.subtitle': 'Esto es lo que hay para hoy.',
  'dash.clock': 'Reloj',
  'dash.onClock': 'En turno',
  'dash.offClock': 'Fuera de turno',
  'dash.startedIn': 'Entrada {time} · {elapsed} trabajadas',
  'dash.kioskHint': 'Marca con tu PIN en la tableta del quiosco de tu sitio de trabajo.',
  'dash.nextShift': 'Próximo turno',
  'dash.nothingScheduled': 'Nada programado',
  'dash.managerWillPublish':
    'Tu gerente publicará los turnos antes de la semana. Vuelve pronto.',
  'dash.viewSchedule': 'Ver horario',
  'dash.seeFullSchedule': 'Ver horario completo',
  'dash.lastPaystub': 'Último recibo de pago',
  'dash.noPaystubs': 'Aún no hay recibos',
  'dash.firstPaystub':
    'El primero aparecerá aquí cuando tu gerente procese la nómina.',
  'dash.netWorked': 'Neto · {hours}h trabajadas',
  'dash.paidOn': 'pagado {date}',
  'dash.viewPayHistory': 'Ver historial de pagos',
  'dash.timeOff': 'Ausencias',
  'dash.noBalance': 'Aún sin saldo',
  'dash.sickAccrues':
    'Las horas por enfermedad se acumulan automáticamente al trabajar.',
  'dash.openTimeOff': 'Abrir ausencias',
  'dash.requestOrView': 'Solicitar o ver saldo',
  'dash.quickLinks': 'Accesos rápidos',
  'dash.myTimesheet': 'Mi hoja de horas',
  'dash.scheduleSwaps': 'Horario y cambios',
  'dash.documents': 'Documentos',
  'dash.requestTimeOff': 'Solicitar ausencia',
  'dash.loadFailed': 'No se pudo cargar',
  'dash.checkConnection': 'Revisa tu conexión e inténtalo de nuevo.',
  'dash.pushTitle': 'Recibe alertas de turnos en tu pantalla de bloqueo',
  'dash.pushBody':
    'Nuevos turnos, cambios y recordatorios — incluso con la app cerrada.',
  'dash.pushOn': 'Activar',
  'dash.pushLater': 'Ahora no',

  'sched.title': 'Mi horario',
  'sched.subtitle': 'Tus turnos publicados.',
  'sched.list': 'Lista',
  'sched.week': 'Semana',
  'sched.month': 'Mes',
  'sched.viewAria': 'Vista del horario',
  'sched.refresh': 'Actualizar',
  'sched.upcoming': 'Próximos',
  'sched.thisWeek': 'Esta semana',
  'sched.nextWeek': 'Próxima semana',
  'sched.over40': 'Más de 40h — consulta con tu gerente',
  'sched.shiftsWord': '{count} turno',
  'sched.shiftsWordPlural': '{count} turnos',
  'sched.noUpcoming': 'No hay turnos próximos.',
  'sched.noShifts': 'Aún no hay turnos',
  'sched.emptyDesc':
    'Cuando un gerente publique un turno para ti, aparecerá aquí. Publica tu disponibilidad abajo para facilitar la programación.',
  'sched.truncated':
    'Mostrando tus próximos 100 turnos — lo programado más allá aparecerá aquí a medida que pasen los anteriores.',
  'sched.showRecent': 'Mostrar turnos recientes ({count})',
  'sched.hideRecent': 'Ocultar turnos recientes ({count})',
  'sched.loadOlder': 'Cargar turnos anteriores',
  'sched.fullHistory': 'Ese es todo tu historial de turnos.',

  'shift.next': 'Próximo',
  'shift.confirmed': 'Confirmado',
  'shift.open': 'Abierto',
  'shift.worked': 'Trabajado',
  'shift.draft': 'Borrador',
  'shift.cancelled': 'Cancelado',
  'shift.workingWithYou': 'Trabajan contigo',
  'shift.noTeammates': 'Nadie más está programado junto a este turno todavía.',
  'shift.managerNote': 'Nota de tu gerente: ',
  'shift.illBeThere': 'Ahí estaré',
  'shift.youConfirmed': 'Confirmaste este turno',
  'shift.confirmedToast': 'Confirmado — tu gerente puede ver que lo aceptaste.',
  'shift.offerToTeammate': 'Ofrecer este turno a un compañero',
  'shift.offerTo': 'Ofrecer a',
  'shift.loadingTeammates': 'Cargando compañeros…',
  'shift.pickTeammate': 'Elige un compañero',
  'shift.busyDuring': ' — ocupado durante este turno',
  'shift.tradeLabel': 'Tomar uno de sus turnos a cambio (opcional)',
  'shift.justHandOff': 'Nada — solo entregar el mío',
  'shift.noteOptional': 'Nota (opcional)',
  'shift.notePlaceholder': 'p. ej. Cita médica esa mañana',
  'shift.sendRequest': 'Enviar solicitud',
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, es };

function detectLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'es') return stored;
    return navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
  } catch {
    return 'en';
  }
}

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    // Keep <html lang> honest for screen readers and hyphenation.
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice just doesn't persist.
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => format(MESSAGES[lang][key] ?? en[key] ?? key, vars),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const FALLBACK: I18nContextValue = {
  lang: 'en',
  setLang: () => {},
  t: (key, vars) => format(en[key] ?? key, vars),
};

/** Works without a provider (English) so isolated component tests and
 *  storybook-style renders don't need wrapping. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK;
}
