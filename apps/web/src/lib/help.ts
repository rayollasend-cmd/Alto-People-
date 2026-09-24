import type { Lang } from './i18n';

/**
 * Contextual help — what this page is for and what you can do on it,
 * matched by route. Long-form copy lives here rather than in the
 * dictionary so the MessageKey union stays flat; both languages sit
 * side by side so a missing translation is visible at the definition.
 *
 * Every entry is a few sentences and a short list of actions, not a
 * manual. The help center (knowledge base) is where the manual goes,
 * and the sheet searches it with `kb` for the longer read.
 */

export interface HelpCopy {
  title: string;
  /** One or two plain sentences: what this page is for. */
  intro: string;
  /** "You can…" — the verbs on this page, in the order people need them. */
  actions: string[];
}

export interface HelpEntry {
  key: string;
  match: RegExp;
  /** Query for related help-center articles. */
  kb: string;
  en: HelpCopy;
  es: HelpCopy;
}

export const HELP: HelpEntry[] = [
  {
    key: 'home',
    match: /^\/$/,
    kb: 'getting started',
    en: {
      title: 'Home',
      intro: 'Your day at a glance: what needs you, what is coming up, and where the floor stands right now.',
      actions: [
        'Press ⌘K (Ctrl+K) anywhere to jump to a page, a person or a client.',
        'Open the bell for anything waiting on you; the Approvals count is live.',
        'Pin the pages you use most from the sidebar — hover an item and tap the star.',
      ],
    },
    es: {
      title: 'Inicio',
      intro: 'Tu día de un vistazo: qué te necesita, qué viene y cómo está el piso ahora mismo.',
      actions: [
        'Pulsa ⌘K (Ctrl+K) en cualquier lugar para ir a una página, una persona o un cliente.',
        'Abre la campana para ver lo que te espera; el conteo de Aprobaciones es en vivo.',
        'Fija las páginas que más usas desde la barra lateral — pasa el cursor y toca la estrella.',
      ],
    },
  },
  {
    key: 'people',
    match: /^\/people/,
    kb: 'associate profile',
    en: {
      title: 'People',
      intro: 'Every associate, with their status, workplace, position and pay. Open a row to see the full profile.',
      actions: [
        'Search by name or email; filter by status, workplace or employment type — filters are remembered.',
        'Sort any column; hide columns you do not need with the column chooser; export what is on screen.',
        'Open a profile for documents, pay history, compliance and the kiosk clock-in number.',
      ],
    },
    es: {
      title: 'Personas',
      intro: 'Cada asociado, con su estado, lugar de trabajo, puesto y pago. Abre una fila para ver el perfil completo.',
      actions: [
        'Busca por nombre o correo; filtra por estado, lugar de trabajo o tipo de empleo — los filtros se recuerdan.',
        'Ordena cualquier columna; oculta las que no necesites con el selector de columnas; exporta lo que ves.',
        'Abre un perfil para documentos, historial de pago, cumplimiento y el número de marcación del kiosco.',
      ],
    },
  },
  {
    key: 'scheduling',
    match: /^\/scheduling/,
    kb: 'scheduling shifts',
    en: {
      title: 'Scheduling',
      intro: 'Shifts by week, day, month or as a list, per client and store. Open shifts are the ones still needing a person.',
      actions: [
        'Switch views with the toggle; the list view sorts and exports like every other grid.',
        'Auto-fill an open shift to let the app pick the best available associate, or assign by hand.',
        'Publish when the week is ready — associates only see published shifts.',
      ],
    },
    es: {
      title: 'Horarios',
      intro: 'Turnos por semana, día, mes o en lista, por cliente y tienda. Los turnos abiertos son los que aún necesitan a alguien.',
      actions: [
        'Cambia la vista con el selector; la vista de lista ordena y exporta como cualquier otra tabla.',
        'Usa el autollenado para que la app elija al mejor asociado disponible, o asigna a mano.',
        'Publica cuando la semana esté lista — los asociados solo ven turnos publicados.',
      ],
    },
  },
  {
    key: 'time',
    match: /^\/time-attendance/,
    kb: 'time entries approval',
    en: {
      title: 'Time & attendance',
      intro: 'Who is clocked in right now, and the queue of completed entries waiting for a decision.',
      actions: [
        'Review a pending entry: approve it, approve at shift end, or reject it with a reason.',
        'Select several clean entries and approve them in one go.',
        'Open an entry for its punches, edits and audit trail; the live board clocks someone out if they forgot.',
      ],
    },
    es: {
      title: 'Tiempo y asistencia',
      intro: 'Quién está con entrada marcada ahora, y la cola de registros completados que esperan una decisión.',
      actions: [
        'Revisa un registro pendiente: apruébalo, apruébalo al final del turno, o recházalo con un motivo.',
        'Selecciona varios registros limpios y apruébalos de una vez.',
        'Abre un registro para ver sus marcaciones, ediciones y auditoría; el tablero en vivo marca la salida a quien se olvidó.',
      ],
    },
  },
  {
    key: 'payroll',
    match: /^\/payroll/,
    kb: 'payroll run',
    en: {
      title: 'Payroll',
      intro: 'Payroll runs from draft to disbursed, with readiness checks before you start and compliance work after.',
      actions: [
        'Check readiness first — it lists every associate missing a W-4, tax state, payout method or schedule.',
        'Open a run for its paystubs; finalize, approve and disburse from the run drawer.',
        'Tax deposits, garnishment remittances and new-hire reporting live under Compliance.',
      ],
    },
    es: {
      title: 'Nómina',
      intro: 'Corridas de nómina de borrador a pagadas, con verificaciones antes de empezar y cumplimiento después.',
      actions: [
        'Revisa primero la preparación — lista a cada asociado sin W-4, estado fiscal, método de pago u horario.',
        'Abre una corrida para ver sus recibos; finaliza, aprueba y paga desde el panel de la corrida.',
        'Depósitos de impuestos, remesas de embargos y reporte de nuevas contrataciones están en Cumplimiento.',
      ],
    },
  },
  {
    key: 'onboarding',
    match: /^\/onboarding/,
    kb: 'onboarding application',
    en: {
      title: 'Onboarding',
      intro: 'Every application from invite to approval, with what each one is blocked on and how long it has sat.',
      actions: [
        'Invite one person or a whole start class from a CSV; the preview shows problems before anything is sent.',
        'Open an application to review documents, nudge the applicant, or onboard them in person.',
        'Select several applications for a bulk reject, with one reason.',
      ],
    },
    es: {
      title: 'Incorporación',
      intro: 'Cada solicitud desde la invitación hasta la aprobación, con lo que la detiene y cuánto lleva esperando.',
      actions: [
        'Invita a una persona o a toda una clase de inicio desde un CSV; la vista previa muestra problemas antes de enviar nada.',
        'Abre una solicitud para revisar documentos, recordar al solicitante, o incorporarlo en persona.',
        'Selecciona varias solicitudes para un rechazo en bloque, con un solo motivo.',
      ],
    },
  },
  {
    key: 'clients',
    match: /^\/clients/,
    kb: 'client statements',
    en: {
      title: 'Clients',
      intro: 'The companies you staff: their stores, jobs and rates, and the statements you bill them.',
      actions: [
        'Open a client for its locations, jobs, benefits plans and store-portal accounts.',
        'Statements roll up approved hours per period; finalize drafts in bulk and mark them paid.',
        'Every statement has a PDF for the client and a CSV of the hours behind it.',
      ],
    },
    es: {
      title: 'Clientes',
      intro: 'Las empresas a las que das personal: sus tiendas, puestos y tarifas, y los estados de cuenta que les facturas.',
      actions: [
        'Abre un cliente para ver sus ubicaciones, puestos, planes de beneficios y cuentas del portal de tienda.',
        'Los estados de cuenta agrupan horas aprobadas por período; finaliza borradores en bloque y márcalos como pagados.',
        'Cada estado de cuenta tiene un PDF para el cliente y un CSV con las horas detrás.',
      ],
    },
  },
  {
    key: 'approvals',
    match: /^\/approvals/,
    kb: 'approvals',
    en: {
      title: 'Approvals',
      intro: 'One queue for everything waiting on you — time, time off, reimbursements, swaps — newest first.',
      actions: [
        'Decide from the row, or open the item for the full story before you do.',
        'The count in the sidebar is live; the "as of" stamp tells you how fresh the list is.',
      ],
    },
    es: {
      title: 'Aprobaciones',
      intro: 'Una sola cola para todo lo que te espera — tiempo, permisos, reembolsos, cambios — lo más nuevo primero.',
      actions: [
        'Decide desde la fila, o abre el elemento para ver la historia completa antes.',
        'El conteo en la barra lateral es en vivo; la marca "al" te dice qué tan fresca es la lista.',
      ],
    },
  },
  {
    key: 'ops',
    match: /^\/ops/,
    kb: 'store ops sop',
    en: {
      title: 'Store Ops',
      intro: "Every shift's SOP checklist as the supervisor works through it, live, and the record it leaves behind.",
      actions: [
        'Live now shows floors in progress; Closed today shows what was submitted and what was left undone.',
        'Open a shift record for the full checklist, photos, temperature readings and the handover.',
        'Download a shift, day or month packet as a PDF for a client or an audit.',
      ],
    },
    es: {
      title: 'Operaciones de tienda',
      intro: 'La lista SOP de cada turno mientras el supervisor la trabaja, en vivo, y el registro que deja.',
      actions: [
        'En vivo muestra los pisos en marcha; Cerrados hoy muestra lo enviado y lo que quedó sin hacer.',
        'Abre el registro de un turno para ver la lista completa, fotos, lecturas de temperatura y la entrega.',
        'Descarga un paquete de turno, día o mes en PDF para un cliente o una auditoría.',
      ],
    },
  },
  {
    key: 'documents',
    match: /^\/documents/,
    kb: 'documents verification',
    en: {
      title: 'Documents',
      intro: 'Every file associates have uploaded, grouped by person, with what still needs verifying.',
      actions: [
        'Verify or reject from the row; expiring kinds ask for the expiry date when you verify.',
        'Select several uploaded documents and verify them together.',
        'Request a fresh upload for anything expired — the associate gets a task, not just an email.',
      ],
    },
    es: {
      title: 'Documentos',
      intro: 'Cada archivo que los asociados han subido, agrupado por persona, con lo que aún falta verificar.',
      actions: [
        'Verifica o rechaza desde la fila; los tipos con vencimiento piden la fecha al verificar.',
        'Selecciona varios documentos subidos y verifícalos juntos.',
        'Pide una nueva carga de lo vencido — el asociado recibe una tarea, no solo un correo.',
      ],
    },
  },
  {
    key: 'timesheets',
    match: /^\/time-attendance\/timesheets|^\/timesheets/,
    kb: 'fieldglass timesheets',
    en: {
      title: 'Timesheets',
      intro: 'Approved hours per associate for the week, in the shape Fieldglass expects, with a tick for each one entered there.',
      actions: [
        'Tick "Entered" as you key each timesheet into Fieldglass; the progress strip counts down.',
        'Import the Fieldglass list to match IDs line for line and see any mismatch in hours.',
        'Scheduled vs actual flags no-shows and anyone far from their scheduled hours.',
      ],
    },
    es: {
      title: 'Hojas de tiempo',
      intro: 'Horas aprobadas por asociado para la semana, en la forma que espera Fieldglass, con una marca por cada una ya capturada allí.',
      actions: [
        'Marca "Capturado" a medida que ingresas cada hoja en Fieldglass; la barra de progreso descuenta.',
        'Importa la lista de Fieldglass para cruzar IDs línea por línea y ver cualquier diferencia de horas.',
        'Programado vs real señala ausencias y a quien esté lejos de sus horas programadas.',
      ],
    },
  },
];

/** The most specific entry wins: longer patterns are listed first where they overlap. */
export function helpFor(pathname: string, lang: Lang): { key: string; kb: string; copy: HelpCopy } | null {
  const ordered = [...HELP].sort((a, b) => b.match.source.length - a.match.source.length);
  const entry = ordered.find((e) => e.match.test(pathname));
  if (!entry) return null;
  return { key: entry.key, kb: entry.kb, copy: lang === 'es' ? entry.es : entry.en };
}
