// Spanish for 'schedHome.*' — a staff desk's words, registered with its English (en/schedHome.ts
// imports this file), so it rides in that desk's own chunk: a Spanish-reading associate
// never downloads it, and es.ts stays the associate's pack. Add 'schedHome.*' Spanish HERE.
import { registerTranslations } from '../english';
import type { enSchedHome } from '../en/schedHome';

export const esSchedHome: Record<keyof typeof enSchedHome, string> = {
  'schedHome.title': 'Horarios',
  'schedHome.subManage': 'Planifica turnos, asigna {workersLc} y sigue la cobertura.',
  'schedHome.subReadOnly': 'Vista de solo lectura de los turnos programados.',
  'schedHome.export': 'Exportar',
  'schedHome.printView': 'Imprimir esta vista',
  'schedHome.downloadCsv': 'Descargar CSV',
  'schedHome.schedule': 'Horario',
  'schedHome.noMatch': 'Ningún turno coincide con este filtro',
  'schedHome.noMatchManage': 'Prueba otro filtro o crea un turno nuevo para empezar a dotar.',
  'schedHome.noMatchRead': 'Prueba otro filtro para ver otros turnos.',
  'schedHome.sheetEnded': 'Terminado',
  'schedHome.sheetCheckingPunch': 'Revisando sus marcajes…',
  'schedHome.sheetPunchUnknown': 'No se pudieron leer sus marcajes',
  'schedHome.sheetWorked': 'Trabajó {span}',
  'schedHome.sheetNoPunch': 'Sin marcaje registrado',
  'schedHome.sheetWentUnfilled': 'Quedó sin cubrir',
  'schedHome.sheetCancelled': 'Cancelado',
  'schedHome.sheetViewTime': 'Ver sus horas',
  'schedHome.sheetCloseOut': 'Cerrar',
  'schedHome.sheetEdit': 'Editar',
  'schedHome.sheetAssign': 'Asignar',
  'schedHome.sheetReassign': 'Reasignar',
  'schedHome.sheetUnassign': 'Quitar asignación',
  'schedHome.sheetPublish': 'Publicar',
  'schedHome.sheetToDraft': 'Pasar a borrador',
  'schedHome.sheetDuplicate': 'Duplicar',
  'schedHome.sheetCopyNextWeek': 'Copiar a la próxima semana',
  'schedHome.sheetCancelShift': 'Cancelar turno',
  'schedHome.sheetDelete': 'Eliminar',
  'schedHome.riskShowing': 'Mostrando los {count} turnos a cargo de personas de alto riesgo (faltas, ausencias avisadas o retrasos en los últimos 90 días).',
  'schedHome.riskShowingOne': 'Mostrando el turno a cargo de una persona de alto riesgo (faltas, ausencias avisadas o retrasos en los últimos 90 días).',
  'schedHome.riskNone': 'Ahora mismo ninguno de estos turnos está a cargo de una persona de alto riesgo.',
  'schedHome.riskLoading': 'Buscando los turnos a cargo de personas de alto riesgo…',
  'schedHome.riskFailed': 'No se pudo cargar la lista de alto riesgo: se muestran todos los turnos.',
  'schedHome.riskShowAll': 'Ver todos los turnos',
};

registerTranslations('es', esSchedHome);
