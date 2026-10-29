// Spanish for 'decisions.*' — a staff desk's words, registered with its English (en/decisions.ts
// imports this file), so it rides in that desk's own chunk: a Spanish-reading associate
// never downloads it, and es.ts stays the associate's pack. Add 'decisions.*' Spanish HERE.
import { registerTranslations } from '../english';
import type { enDecisions } from '../en/decisions';

export const esDecisions: Record<keyof typeof enDecisions, string> = {
  'decisions.title': 'Bandeja',
  'decisions.subtitle': 'Cada decisión que te espera, en un solo lugar.',
  'decisions.loadWhat': 'tu bandeja',
  'decisions.emptyTitle': 'Nada te espera.',
  'decisions.emptyBody': 'Cuando una decisión te necesite — una aprobación, una revisión, un fallo — aparecerá aquí.',
  'decisions.waitingAria': 'Decisiones que te esperan',
  'decisions.allClear': 'Todo al día',
  'decisions.allClearBody': 'Colas en las que puedes actuar y que ahora están vacías.',
  'decisions.quietAria': 'Colas sin nada pendiente',
  'decisions.nWaiting': '{n} pendientes',
  'decisions.open': 'Abrir',
  'decisions.openX': 'Abrir {label}',
  'decisions.backToInbox': 'Volver a la bandeja',
  'decisions.leftHere': '{label}: quedan {n}',
  'decisions.queueDone': '{label}: listo.',
  'decisions.next': 'Siguiente: {label} ({n})',
  'decisions.inboxClear': 'Tu bandeja está al día.',
  'decisions.hideReturn': 'Ocultar',
  'decisions.watchingFold': 'También a la vista · {n}',
  'decisions.watchingBody': 'Son de otro equipo. No cuentan en tu número.',
  'decisions.bandLegal': 'Plazos legales',
  'decisions.bandMoney': 'Dinero',
  'decisions.bandRoutine': 'Rutina',
  'decisions.bandQueues': '{count} colas',
  'decisions.bandQueues_one': '{count} cola',
  'decisions.bandItems': '{count} pendientes',
  'decisions.bandItems_one': '{count} pendiente',
  'decisions.nextDue': 'Próximo vence {date}',
  'decisions.overdue': 'Vencido · {date}',
  'decisions.quietFold': '{n} colas sin pendientes',
  'decisions.quietFoldOne': '1 cola sin pendientes',
  'decisions.subtitleN': '{count} elementos te esperan, en un solo lugar.',
  'decisions.subtitleN_one': '1 elemento te espera.',
  'decisions.unreadNotices': '{count} notificaciones sin leer: léelas en Notificaciones',
  'decisions.unreadNotices_one': '1 notificación sin leer: léela en Notificaciones',
};

registerTranslations('es', esDecisions);
