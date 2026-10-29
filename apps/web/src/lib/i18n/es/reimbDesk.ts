// Spanish for 'reimbDesk.*' — a staff desk's words, registered with its English (en/reimbDesk.ts
// imports this file), so it rides in that desk's own chunk: a Spanish-reading associate
// never downloads it, and es.ts stays the associate's pack. Add 'reimbDesk.*' Spanish HERE.
import { registerTranslations } from '../english';
import type { enReimbDesk } from '../en/reimbDesk';

export const esReimbDesk: Record<keyof typeof enReimbDesk, string> = {
  'reimbDesk.newest200': 'Los 200 informes más recientes. Busca o elige un estado para ver los anteriores.',
  'reimbDesk.filter.ready': 'Listos para liquidar',
  'reimbDesk.filter.waitingOnFinance': 'Esperando a finanzas',
  'reimbDesk.filter.approve': 'Por aprobar',
  'reimbDesk.filter.queued': 'En cola para la nómina',
  'reimbDesk.filter.paid': 'Pagados',
  'reimbDesk.filter.all': 'Todos',
  'reimbDesk.approveOne': 'Aprobar 1 informe · {amount}',
  'reimbDesk.approveMany': 'Aprobar {count} informes · {amount}',
  'reimbDesk.settleOne': 'Liquidar 1 informe · {amount}',
  'reimbDesk.settleMany': 'Liquidar {count} informes · {amount}',
  'reimbDesk.settledOne': '1 informe liquidado: {amount} en cola para la próxima nómina.',
  'reimbDesk.settledMany': '{count} informes liquidados: {amount} en cola para la próxima nómina.',
  'reimbDesk.skippedOne': '1 sin liquidar: {reason}',
  'reimbDesk.skippedMany': '{count} sin liquidar. El primero: {reason}',
  'reimbDesk.selectApprovable': 'Seleccionar todos los informes que puedes aprobar',
  'reimbDesk.selectSettleable': 'Seleccionar todos los informes listos para liquidar',
  'reimbDesk.reportOne': '1 informe',
  'reimbDesk.reportMany': '{count} informes',
  'reimbDesk.stripLabel': 'Informes de gastos de un vistazo',
  'reimbDesk.tile.ready': 'Listos para liquidar',
  'reimbDesk.tile.readyNone': 'Nada por liquidar',
  'reimbDesk.tile.approve': 'Por aprobar',
  'reimbDesk.tile.approveNone': 'Nada por aprobar',
  'reimbDesk.tile.waitingOnFinance': 'Esperando a finanzas',
  'reimbDesk.tile.waitingOnFinanceNone': 'Nada esperando a finanzas',
  'reimbDesk.tile.queued': 'En cola para la próxima nómina',
  'reimbDesk.tile.queuedNone': 'Nada en cola',
  'reimbDesk.tile.paid': 'Pagado este mes',
  'reimbDesk.tile.paidNone': 'Nada pagado aún este mes',
  'reimbDesk.empty.readyTitle': 'Nada listo para liquidar',
  'reimbDesk.empty.readyDesc': 'Los informes que aprueba un gerente llegan aquí para que finanzas los liquide en la próxima nómina.',
  'reimbDesk.empty.approveTitle': 'Nada por aprobar',
  'reimbDesk.empty.approveDesc': 'Los informes que envían las personas llegan aquí para su gerente.',
  'reimbDesk.empty.queuedTitle': 'Nada en cola para la nómina',
  'reimbDesk.empty.queuedDesc': 'Los informes liquidados esperan aquí hasta que los pague la próxima nómina regular.',
  'reimbDesk.empty.paidTitle': 'Aún no hay informes pagados',
  'reimbDesk.empty.paidDesc': 'Aquí aparecen los informes que pagó la nómina.',
  'reimbDesk.empty.allTitle': 'Aún no hay informes de gastos',
  'reimbDesk.empty.allDesc': 'Cuando las personas envían gastos, sus informes aparecen aquí.',
};

registerTranslations('es', esReimbDesk);
