// Spanish for the organization's spend on the assistant ('hugoAdmin.*') — registered with its English
// (en/hugoAdmin imports this file), so it rides in that page's own chunk and es.ts stays the associate's pack.
import { registerTranslations } from '../english';
import type { enHugoAdmin } from '../en/hugoAdmin';

export const esHugoAdmin: Record<keyof typeof enHugoAdmin, string> = {
  'hugoAdmin.title': 'Tiempo para pensar de {name}',
  'hugoAdmin.description': 'Lo que costó el razonamiento de tu asistente este mes y quién lo usó más. Cada persona tiene su propio límite: {floor} cada 30 días para {workers}, conductores y supervisores de piso, {staff} al mes para la oficina. Al agotarse, lo básico sigue funcionando.',
  'hugoAdmin.off': 'No hay un modelo conectado, así que {name} responde solo con tus registros y no se gasta nada.',
  'hugoAdmin.total': 'Gastado este mes',
  'hugoAdmin.people': 'Personas que lo usaron',
  'hugoAdmin.usedUp': 'Agotado ahora',
  'hugoAdmin.usedUpHint': 'Responde lo básico hasta que se renueve',
  'hugoAdmin.noneUsedUp': 'Nadie lo ha agotado',
  'hugoAdmin.floor': 'En el piso',
  'hugoAdmin.office': 'En la oficina',
  'hugoAdmin.byPurpose': 'Para qué se usó',
  'hugoAdmin.purpose.chat': 'Preguntas en la app',
  'hugoAdmin.purpose.goal': 'Metas',
  'hugoAdmin.purpose.recurring': 'Resúmenes periódicos',
  'hugoAdmin.purpose.whatsapp': 'WhatsApp',
  'hugoAdmin.top': 'Quién lo usó más',
  'hugoAdmin.col.person': 'Persona',
  'hugoAdmin.col.used': 'Límite usado',
  'hugoAdmin.col.spent': 'Este mes',
  'hugoAdmin.usedUpBadge': 'Agotado',
  'hugoAdmin.empty': 'Nadie ha usado el razonamiento de {name} este mes.',
  'hugoAdmin.loadFailed': 'No se pudo cargar el gasto de este mes.',
  'hugoAdmin.retry': 'Reintentar',
};

registerTranslations('es', esHugoAdmin);
