// Spanish for 'payrollHome.*' — a staff desk's words, registered with its English (en/payrollHome.ts
// imports this file), so it rides in that desk's own chunk: a Spanish-reading associate
// never downloads it, and es.ts stays the associate's pack. Add 'payrollHome.*' Spanish HERE.
import { registerTranslations } from '../english';
import type { enPayrollHome } from '../en/payrollHome';

export const esPayrollHome: Record<keyof typeof enPayrollHome, string> = {
  'payrollHome.title': 'Nómina',
  'payrollHome.subProcess': 'Paga a las personas por el tiempo aprobado: revisa, aprueba, paga.',
  'payrollHome.subReadOnly': 'Vista de solo lectura de las corridas de nómina.',
  'payrollHome.financialChanges': 'Cambios financieros',
  'payrollHome.morePages': 'Más páginas de nómina',
  'payrollHome.more': 'Más',
  'payrollHome.readiness': 'Preparación',
  'payrollHome.goLive': 'Lista de configuración de nómina',
  'payrollHome.ytd': 'Informe del año a la fecha',
  'payrollHome.taxForms': 'Formularios fiscales',
  'payrollHome.compliance': 'Cumplimiento',
  'payrollHome.laborRules': 'Reglas laborales',
  'payrollHome.yearEndClose': 'Fin de año',
  'payrollHome.newRun': 'Corrida extraordinaria',
  'payrollHome.tabRuns': 'Corridas',
  'payrollHome.tabSchedules': 'Calendarios de pago',
  'payrollHome.tabGarnishments': 'Embargos',
  'payrollHome.noRuns': 'Aún no hay corridas de nómina',
  'payrollHome.noRunsFiltered': 'No hay corridas en estado {status}',
  'payrollHome.noRunsBody': 'Ejecuta la nómina para hacer tus primeros cheques de pago. ¿Eres nuevo? Revisa primero la preparación para ver a quién le falta un W-4, un estado fiscal o un calendario de pago.',
  'payrollHome.noRunsFilteredBody': 'Cambia a otro estado o crea una corrida nueva.',
  'payrollHome.runPayroll': 'Ejecutar nómina',
  'payrollHome.checkReadiness': 'Revisar preparación',
  'payrollHome.statusDraft': 'Borrador',
  'payrollHome.statusFinalized': 'Finalizada',
  'payrollHome.statusDisbursed': 'Pagada',
  'payrollHome.statusCancelled': 'Cancelada',
  'payrollHome.statusAll': 'Todas',
  'payrollHome.statusOpen': 'Abiertas',
  'payrollHome.finalizeRun': '¿Finalizar esta corrida?',
};

registerTranslations('es', esPayrollHome);
