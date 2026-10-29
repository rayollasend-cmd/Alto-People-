import type { EmailLang } from './emailLayout.js';
import { companyWorkweek } from './timeAnomalies.js';

/**
 * What an emergency says, in the three languages the platform speaks.
 *
 * The declarer's own words go out as written (or in the Spanish / Turkish
 * rendering they typed); everything around them — what happened to the
 * shifts, what to tap, whether a van is coming — is ours, and lives here
 * so the Spanish and Turkish are real sentences rather than a machine's
 * guess at the moment it matters most.
 */

export interface EmergencyWords {
  title: string;
  message: string;
  startsAt: Date;
  pickupAt: Date | null;
  timeZone?: string;
}

function when(d: Date, lang: EmailLang, timeZone: string): string {
  const locale = lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export function emergencySubject(lang: EmailLang, title: string): string {
  if (lang === 'es') return `EMERGENCIA: ${title}`;
  if (lang === 'tr') return `ACİL DURUM: ${title}`;
  return `EMERGENCY: ${title}`;
}

/** The declaration: the message, the shifts, the one tap, the van. */
export function emergencyDeclaredBody(lang: EmailLang, w: EmergencyWords): string {
  const tz = w.timeZone ?? companyWorkweek().timezone;
  const start = when(w.startsAt, lang, tz);
  const pickup = w.pickupAt ? when(w.pickupAt, lang, tz) : null;
  if (lang === 'es') {
    return [
      w.message,
      `Tus turnos a partir del ${start} quedan suspendidos. No cuentan como falta ni te afectan la asistencia.`,
      `Abre la app de Alto y toca "Estoy bien" para que sepamos que estás a salvo. Si necesitas ayuda, toca "Necesito ayuda".`,
      pickup
        ? `Si necesitas transporte, márcalo en la app: una van pasará por tu dirección alrededor de las ${pickup}.`
        : null,
      `Te avisaremos por aquí cuando puedas volver al trabajo.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (lang === 'tr') {
    return [
      w.message,
      `${start} itibarıyla vardiyaların askıya alındı. Bunlar devamsızlık sayılmaz ve puanını etkilemez.`,
      `Alto uygulamasını aç ve güvende olduğunu bilmemiz için "Güvendeyim"e dokun. Yardıma ihtiyacın varsa "Yardım lazım"a dokun.`,
      pickup
        ? `Ulaşım gerekiyorsa uygulamada işaretle: bir minibüs saat ${pickup} civarında kayıtlı adresinden alacak.`
        : null,
      `İşe ne zaman dönebileceğini buradan bildireceğiz.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return [
    w.message,
    `Your shifts from ${start} are suspended. They do not count as a missed shift and do not affect your attendance.`,
    `Open the Alto app and tap "I'm safe" so we know you are. If you need help, tap "I need help".`,
    pickup ? `If you need transport, say so in the app: a van will come to your address on file around ${pickup}.` : null,
    `We will tell you here when it is safe to return to work.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function standDownSubject(lang: EmailLang, title: string): string {
  if (lang === 'es') return `Fin de la emergencia: ${title}`;
  if (lang === 'tr') return `Acil durum sona erdi: ${title}`;
  return `All clear: ${title}`;
}

/** Stand down: the schedule is back from the next shift on. */
export function standDownBody(lang: EmailLang, title: string, from: Date, timeZone = companyWorkweek().timezone): string {
  const at = when(from, lang, timeZone);
  if (lang === 'es') {
    return `La emergencia "${title}" terminó. Tus turnos a partir del ${at} vuelven a estar en el horario; revisa la app para ver cuándo te toca. Gracias por avisarnos que estabas bien.`;
  }
  if (lang === 'tr') {
    return `"${title}" acil durumu sona erdi. ${at} itibarıyla vardiyaların programa geri eklendi; ne zaman çalışacağını görmek için uygulamaya bak. Güvende olduğunu bildirdiğin için teşekkürler.`;
  }
  return `The "${title}" emergency is over. Your shifts from ${at} are back on the schedule; check the app for when you work next. Thank you for letting us know you were safe.`;
}

/** The short line the bell and the push show. */
export function emergencyPushLine(lang: EmailLang, title: string): string {
  if (lang === 'es') return `EMERGENCIA: ${title}. Toca "Estoy bien" en la app.`;
  if (lang === 'tr') return `ACİL DURUM: ${title}. Uygulamada "Güvendeyim"e dokun.`;
  return `EMERGENCY: ${title}. Tap "I'm safe" in the app.`;
}
