// Spanish for 'adminHome.*' — a staff desk's words, registered with its English (en/adminHome.ts
// imports this file), so it rides in that desk's own chunk: a Spanish-reading associate
// never downloads it, and es.ts stays the associate's pack. Add 'adminHome.*' Spanish HERE.
import { registerTranslations } from '../english';
import type { enAdminHome } from '../en/adminHome';

export const esAdminHome: Record<keyof typeof enAdminHome, string> = {
  'adminHome.subHr': 'Esto es lo que pasa hoy en tu plantilla.',
  'adminHome.subOps': 'El piso hoy: cada tienda, lo que está abierto y lo que te necesita.',
  'adminHome.subExec': 'Pulso de toda la empresa. Solo lectura en cada módulo.',
  'adminHome.subFinance': 'Pulso financiero: corridas de nómina, pagos y declaraciones fiscales pendientes.',
  'adminHome.subRecruiter': 'Pipeline de reclutamiento y solicitudes de incorporación abiertas.',
  'adminHome.subClient': 'El resumen de tu plantilla.',
  'adminHome.subManager': 'Tu equipo: aprobaciones y solicitudes de ausencia pendientes.',
  'adminHome.subShift': 'Tu sitio hoy: quién está, quién llega tarde, qué está abierto.',
  'adminHome.subFloor': 'Tu sitio ahora mismo: quién está en el piso.',
  'adminHome.loadFailed': 'No se pudieron cargar los datos del panel.',
  'adminHome.workforceSnapshot': 'Resumen de la plantilla',
  'adminHome.onboardingPipeline': 'Pipeline de incorporación',
  'adminHome.noApplications': 'Aún no hay solicitudes',
  'adminHome.noApplicationsBody': 'Las nuevas contrataciones aparecerán aquí a medida que RR. HH. las cree.',
  'adminHome.openOnboarding': 'Abrir incorporación',
  'adminHome.recentActivity': 'Actividad reciente',
  'adminHome.auditLog': 'Registro de auditoría',
  'adminHome.appToReview': 'Solicitud por revisar',
  'adminHome.appsToReview': 'Solicitudes por revisar',
  'adminHome.appsHint': 'Enviadas y esperando por ti.',
  'adminHome.incidentToReview': 'Incidente de seguridad pendiente de revisión',
  'adminHome.incidentsToReview': 'Incidentes de seguridad pendientes de revisión',
  'adminHome.incidentsHint': 'Reportados desde el campo. Resolver uno avisa al {managerLc} que lo registró.',
  'adminHome.openInjuryLog': 'Abrir el registro de lesiones',
  'adminHome.i9Due': 'Sección 2 del I-9 pendiente',
  'adminHome.i9Hint': 'Plazo federal: 3 días hábiles desde la contratación.',
  'adminHome.completeSection2': 'Completar la Sección 2',
  'adminHome.docToVerify': 'Documento pendiente de verificación',
  'adminHome.docsToVerify': 'Documentos pendientes de verificación',
  'adminHome.reviewDocuments': 'Revisar documentos',
  'adminHome.pendingPayroll': '{amount} de nómina pendiente',
  'adminHome.pendingPayrollHint': 'Corridas finalizadas en espera de pago.',
  'adminHome.openPayroll': 'Abrir nómina',
  'adminHome.ssnRecollect': 'Hay que volver a recoger un SSN',
  'adminHome.ssnsRecollect': 'Hay que volver a recoger SSN',
  'adminHome.ssnHint': 'SSN del W-4 que ya no se pueden leer, o fotos de la tarjeta que faltan: bloquea el reporte de nuevas contrataciones y los W-2.',
  'adminHome.openCampaign': 'Abrir campaña',
};

registerTranslations('es', esAdminHome);
