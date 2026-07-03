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
  'common.undo': 'Undo',
  'common.from': 'From',
  'common.to': 'To',
  'nav.pinned': 'Pinned',

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
  'sched.offline': "You're offline — showing your schedule from {time}.",

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

  // Time & attendance — associate kiosk-only explainer
  'time.title': 'Time & Attendance',
  'time.subtitle': 'Clock in at the worksite kiosk.',
  'time.kioskHeading': 'Use the time-clock tablet at your worksite',
  'time.kioskBody':
    "Hourly associates clock in and out using the kiosk tablet installed at your site, not from a personal phone. Tap your 4-digit PIN, take the selfie, and you're punched in. Ask your manager if you don't know your PIN yet.",
  'time.myTimesheet': 'My timesheet',
  'time.myTimesheetDesc':
    'Every kiosk punch with your hours and approval status.',
  'time.approvedTotal': '{hours} approved',
  'time.pendingTotal': '{hours} pending review',
  'time.stillOn': 'still on the clock',
  'time.breakMinutes': '{minutes}m break',
  'time.noEntries': 'No punches in this range',
  'time.noEntriesDesc':
    'Punches from the worksite kiosk will show up here the moment you clock in.',
  'time.loadFailed': 'Could not load your timesheet.',
  'time.status.ACTIVE': 'On the clock',
  'time.status.COMPLETED': 'Pending review',
  'time.status.APPROVED': 'Approved',
  'time.status.REJECTED': 'Rejected',
  'time.lastWeek': 'Last week',
  'time.last14': 'Last 14 days',
  'time.rangeAria': 'Quick date ranges',
  'time.weekOf': 'Week of {date}',
  'time.weekOvertime': 'includes {hours} overtime',
  'time.scheduled': 'Scheduled {range}',
  'time.grossEstimate': '≈ {amount} gross (approved)',
  'time.grossLabel': '≈ Est. gross',
  'time.grossDisclaimer':
    'Estimate before taxes and deductions — not a pay statement.',
  'time.reportIssue': 'Report an issue',
  'time.reportIssueDesc':
    "Tell HR what looks wrong with this entry. The date and punch times are attached automatically, and you can track the case under HR cases.",
  'time.whatsWrong': 'What looks wrong?',
  'time.reportPlaceholder': 'e.g. I clocked out at 5:00, not 4:30',
  'time.send': 'Send to HR',
  'time.reportSent': 'Sent — HR will follow up.',
  'time.reportFailed': 'Could not send',

  // Time off — associate view
  'timeoff.title': 'Time off',
  'timeoff.subtitle': 'Submit a request, see your balance, track approvals.',
  'timeoff.request': 'Request time off',
  'timeoff.myRequests': 'My requests',
  'timeoff.mostRecentFirst': 'Most recent first',
  'timeoff.noRequests': 'No requests yet',
  'timeoff.noRequestsDesc': 'Submit one with the button above. HR will be notified.',
  'timeoff.withdraw': 'Withdraw',
  'timeoff.noteFrom': 'Note from {who}:',
  'timeoff.hr': 'HR',
  'timeoff.noBalance': 'No accrued balance yet',
  'timeoff.noBalanceDesc':
    'Sick-leave hours accrue automatically as you work. Other categories start at 0 and are added by HR.',
  'timeoff.available': 'available',
  'timeoff.status.PENDING': 'Pending',
  'timeoff.status.APPROVED': 'Approved',
  'timeoff.status.DENIED': 'Denied',
  'timeoff.status.CANCELLED': 'Withdrawn',
  'timeoff.cat.SICK': 'Sick',
  'timeoff.cat.VACATION': 'Vacation',
  'timeoff.cat.PTO': 'PTO',
  'timeoff.cat.BEREAVEMENT': 'Bereavement',
  'timeoff.cat.JURY_DUTY': 'Jury duty',
  'timeoff.cat.OTHER': 'Other',
  'timeoff.loadFailed': 'Could not load time-off data',
  'timeoff.withdrawnToast': 'Request withdrawn',
  'timeoff.cancelFailed': 'Could not cancel',
  'timeoff.submittedToast': 'Request submitted',
  'timeoff.submitFailed': 'Could not submit',
  'timeoff.pickDates': 'Pick a start and end date',
  'timeoff.hoursPositive': 'Hours must be greater than 0',
  'timeoff.dialogDesc':
    "HR will see your request immediately. You'll be notified when it's reviewed.",
  'timeoff.category': 'Category',
  'timeoff.startDate': 'Start date',
  'timeoff.endDate': 'End date',
  'timeoff.totalHours': 'Total hours',
  'timeoff.totalHoursHint': 'Half-hour granularity. 8 = a full work day.',
  'timeoff.reasonOptional': 'Reason (optional)',
  'timeoff.reasonPlaceholder': 'Family event, doctor visit, etc.',
  'timeoff.submit': 'Submit',

  // Pay — associate paystub list
  'pay.title': 'My pay',
  'pay.subtitle': 'Recent paystubs with year-to-date totals.',
  'pay.loadFailed': 'Failed to load.',
  'pay.noPaystubs': 'No paystubs yet',
  'pay.noPaystubsDesc':
    'Your first paystub will appear here after payroll runs for a period you worked.',
  'pay.pendingCount': 'Pending ({count})',
  'pay.paystubWord': '{count} paystub',
  'pay.paystubWordPlural': '{count} paystubs',
  'pay.hrsAtRate': '{hours} hrs · {rate}/hr',
  'pay.gross': 'Gross',
  'pay.taxes': 'Taxes',
  'pay.taxPlusPostTax': 'Tax + post-tax',
  'pay.net': 'Net',
  'pay.netPay': 'Net pay',
  'pay.ytdNet': 'YTD net {amount}',
  'pay.earnings': 'Earnings',
  'pay.deductions': 'Deductions',
  'pay.employerContrib': 'Employer contributions (informational)',
  'pay.colHours': 'Hours',
  'pay.colRate': 'Rate',
  'pay.colCurrent': 'Current',
  'pay.colYtd': 'YTD',
  'pay.grossPay': 'Gross pay',
  'pay.fedIncomeTax': 'Federal income tax',
  'pay.socialSecurity': 'Social Security (FICA)',
  'pay.medicare': 'Medicare',
  'pay.stateIncomeTax': 'State income tax',
  'pay.garnishments': 'Garnishments / post-tax',
  'pay.totalDeductions': 'Total deductions',
  'pay.employerFica': 'Employer FICA match',
  'pay.employerMedicare': 'Employer Medicare match',
  'pay.futa': 'Federal unemployment (FUTA)',
  'pay.suta': 'State unemployment (SUTA)',
  'pay.disbursementRef': 'Disbursement ref: {ref}',
  'pay.downloadPdf': 'Download PDF',
  'pay.downloadFailed': 'Download failed.',
  'pay.status.PENDING': 'Pending',
  'pay.status.DISBURSED': 'Paid',
  'pay.status.FAILED': 'Failed',
  'pay.status.HELD': 'Held',
  'pay.status.VOIDED': 'Voided',
  'pay.kind.REGULAR': 'Regular',
  'pay.kind.OVERTIME': 'Overtime',
  'pay.kind.DOUBLE_TIME': 'Double time',
  'pay.kind.HOLIDAY': 'Holiday',
  'pay.kind.SICK': 'Sick',
  'pay.kind.VACATION': 'Vacation',
  'pay.kind.BONUS': 'Bonus',
  'pay.kind.COMMISSION': 'Commission',
  'pay.kind.TIPS': 'Tips',
  'pay.kind.REIMBURSEMENT': 'Reimbursement (non-taxable)',

  // Login
  'login.title': 'Sign in',
  'login.subtitle': 'Use your Alto HR credentials.',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.forgot': 'Forgot password?',
  'login.minChars': 'Minimum 12 characters.',
  'login.signIn': 'Sign in',
  'login.signingIn': 'Signing in…',
  'login.errInvalid': 'Invalid email or password.',
  'login.errNetwork': 'Network error — check your connection and try again.',
  'login.errRateLimited': 'Too many login attempts. Please wait a minute and try again.',
  'login.errServer': "We're having trouble signing you in. Please try again in a moment.",
  'login.securedBy': 'Secured by Alto HR',
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
  'common.undo': 'Deshacer',
  'common.from': 'Desde',
  'common.to': 'Hasta',
  'nav.pinned': 'Fijados',

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
  'sched.offline': 'Sin conexión — mostrando tu horario de {time}.',

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

  'time.title': 'Tiempo y asistencia',
  'time.subtitle': 'Marca tu entrada en el quiosco del sitio de trabajo.',
  'time.kioskHeading': 'Usa la tableta de marcaje en tu sitio de trabajo',
  'time.kioskBody':
    'Los asociados por hora marcan entrada y salida en la tableta del quiosco instalada en su sitio, no desde un teléfono personal. Ingresa tu PIN de 4 dígitos, tómate la selfie y quedas registrado. Pregunta a tu gerente si aún no conoces tu PIN.',
  'time.myTimesheet': 'Mi hoja de horas',
  'time.myTimesheetDesc':
    'Cada marcaje del quiosco con tus horas y su estado de aprobación.',
  'time.approvedTotal': '{hours} aprobadas',
  'time.pendingTotal': '{hours} por revisar',
  'time.stillOn': 'aún en turno',
  'time.breakMinutes': '{minutes}m de descanso',
  'time.noEntries': 'No hay marcajes en este rango',
  'time.noEntriesDesc':
    'Los marcajes del quiosco de tu sitio aparecerán aquí en cuanto marques entrada.',
  'time.loadFailed': 'No se pudo cargar tu hoja de horas.',
  'time.status.ACTIVE': 'En turno',
  'time.status.COMPLETED': 'Por revisar',
  'time.status.APPROVED': 'Aprobado',
  'time.status.REJECTED': 'Rechazado',
  'time.lastWeek': 'Semana pasada',
  'time.last14': 'Últimos 14 días',
  'time.rangeAria': 'Rangos rápidos de fechas',
  'time.weekOf': 'Semana del {date}',
  'time.weekOvertime': 'incluye {hours} extra',
  'time.scheduled': 'Programado {range}',
  'time.grossEstimate': '≈ {amount} bruto (aprobado)',
  'time.grossLabel': '≈ Bruto est.',
  'time.grossDisclaimer':
    'Estimación antes de impuestos y deducciones — no es un comprobante de pago.',
  'time.reportIssue': 'Reportar un problema',
  'time.reportIssueDesc':
    'Cuéntale a RR. HH. qué está mal con este registro. La fecha y las horas se adjuntan automáticamente, y puedes seguir el caso en Casos de RR. HH.',
  'time.whatsWrong': '¿Qué está mal?',
  'time.reportPlaceholder': 'p. ej. Marqué salida a las 5:00, no a las 4:30',
  'time.send': 'Enviar a RR. HH.',
  'time.reportSent': 'Enviado — RR. HH. te responderá.',
  'time.reportFailed': 'No se pudo enviar',

  'timeoff.title': 'Ausencias',
  'timeoff.subtitle': 'Envía una solicitud, consulta tu saldo y sigue las aprobaciones.',
  'timeoff.request': 'Solicitar ausencia',
  'timeoff.myRequests': 'Mis solicitudes',
  'timeoff.mostRecentFirst': 'Las más recientes primero',
  'timeoff.noRequests': 'Aún no hay solicitudes',
  'timeoff.noRequestsDesc': 'Envía una con el botón de arriba. Se notificará a RR. HH.',
  'timeoff.withdraw': 'Retirar',
  'timeoff.noteFrom': 'Nota de {who}:',
  'timeoff.hr': 'RR. HH.',
  'timeoff.noBalance': 'Aún sin saldo acumulado',
  'timeoff.noBalanceDesc':
    'Las horas por enfermedad se acumulan automáticamente al trabajar. Las demás categorías empiezan en 0 y las agrega RR. HH.',
  'timeoff.available': 'disponible',
  'timeoff.status.PENDING': 'Pendiente',
  'timeoff.status.APPROVED': 'Aprobada',
  'timeoff.status.DENIED': 'Denegada',
  'timeoff.status.CANCELLED': 'Retirada',
  'timeoff.cat.SICK': 'Enfermedad',
  'timeoff.cat.VACATION': 'Vacaciones',
  'timeoff.cat.PTO': 'PTO',
  'timeoff.cat.BEREAVEMENT': 'Duelo',
  'timeoff.cat.JURY_DUTY': 'Deber de jurado',
  'timeoff.cat.OTHER': 'Otro',
  'timeoff.loadFailed': 'No se pudieron cargar los datos de ausencias',
  'timeoff.withdrawnToast': 'Solicitud retirada',
  'timeoff.cancelFailed': 'No se pudo cancelar',
  'timeoff.submittedToast': 'Solicitud enviada',
  'timeoff.submitFailed': 'No se pudo enviar',
  'timeoff.pickDates': 'Elige una fecha de inicio y una de fin',
  'timeoff.hoursPositive': 'Las horas deben ser mayores que 0',
  'timeoff.dialogDesc':
    'RR. HH. verá tu solicitud de inmediato. Te avisaremos cuando sea revisada.',
  'timeoff.category': 'Categoría',
  'timeoff.startDate': 'Fecha de inicio',
  'timeoff.endDate': 'Fecha de fin',
  'timeoff.totalHours': 'Horas totales',
  'timeoff.totalHoursHint': 'En incrementos de media hora. 8 = un día completo de trabajo.',
  'timeoff.reasonOptional': 'Motivo (opcional)',
  'timeoff.reasonPlaceholder': 'Evento familiar, cita médica, etc.',
  'timeoff.submit': 'Enviar',

  'pay.title': 'Mi pago',
  'pay.subtitle': 'Recibos de pago recientes con totales acumulados del año.',
  'pay.loadFailed': 'No se pudo cargar.',
  'pay.noPaystubs': 'Aún no hay recibos',
  'pay.noPaystubsDesc':
    'Tu primer recibo aparecerá aquí cuando se procese la nómina de un período que trabajaste.',
  'pay.pendingCount': 'Pendientes ({count})',
  'pay.paystubWord': '{count} recibo',
  'pay.paystubWordPlural': '{count} recibos',
  'pay.hrsAtRate': '{hours} h · {rate}/h',
  'pay.gross': 'Bruto',
  'pay.taxes': 'Impuestos',
  'pay.taxPlusPostTax': 'Impuestos + post-impuestos',
  'pay.net': 'Neto',
  'pay.netPay': 'Pago neto',
  'pay.ytdNet': 'Neto acumulado {amount}',
  'pay.earnings': 'Ingresos',
  'pay.deductions': 'Deducciones',
  'pay.employerContrib': 'Aportes del empleador (informativo)',
  'pay.colHours': 'Horas',
  'pay.colRate': 'Tarifa',
  'pay.colCurrent': 'Actual',
  'pay.colYtd': 'Acum.',
  'pay.grossPay': 'Pago bruto',
  'pay.fedIncomeTax': 'Impuesto federal sobre la renta',
  'pay.socialSecurity': 'Seguro Social (FICA)',
  'pay.medicare': 'Medicare',
  'pay.stateIncomeTax': 'Impuesto estatal sobre la renta',
  'pay.garnishments': 'Embargos / post-impuestos',
  'pay.totalDeductions': 'Total de deducciones',
  'pay.employerFica': 'Aporte FICA del empleador',
  'pay.employerMedicare': 'Aporte Medicare del empleador',
  'pay.futa': 'Desempleo federal (FUTA)',
  'pay.suta': 'Desempleo estatal (SUTA)',
  'pay.disbursementRef': 'Ref. de desembolso: {ref}',
  'pay.downloadPdf': 'Descargar PDF',
  'pay.downloadFailed': 'Error al descargar.',
  'pay.status.PENDING': 'Pendiente',
  'pay.status.DISBURSED': 'Pagado',
  'pay.status.FAILED': 'Fallido',
  'pay.status.HELD': 'Retenido',
  'pay.status.VOIDED': 'Anulado',
  'pay.kind.REGULAR': 'Regular',
  'pay.kind.OVERTIME': 'Horas extra',
  'pay.kind.DOUBLE_TIME': 'Tiempo doble',
  'pay.kind.HOLIDAY': 'Festivo',
  'pay.kind.SICK': 'Enfermedad',
  'pay.kind.VACATION': 'Vacaciones',
  'pay.kind.BONUS': 'Bono',
  'pay.kind.COMMISSION': 'Comisión',
  'pay.kind.TIPS': 'Propinas',
  'pay.kind.REIMBURSEMENT': 'Reembolso (no gravable)',

  'login.title': 'Iniciar sesión',
  'login.subtitle': 'Usa tus credenciales de Alto HR.',
  'login.email': 'Correo electrónico',
  'login.password': 'Contraseña',
  'login.forgot': '¿Olvidaste tu contraseña?',
  'login.minChars': 'Mínimo 12 caracteres.',
  'login.signIn': 'Iniciar sesión',
  'login.signingIn': 'Iniciando sesión…',
  'login.errInvalid': 'Correo o contraseña incorrectos.',
  'login.errNetwork': 'Error de red — revisa tu conexión e inténtalo de nuevo.',
  'login.errRateLimited':
    'Demasiados intentos de inicio de sesión. Espera un minuto e inténtalo de nuevo.',
  'login.errServer':
    'Tenemos problemas para iniciar tu sesión. Inténtalo de nuevo en un momento.',
  'login.securedBy': 'Protegido por Alto HR',
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
