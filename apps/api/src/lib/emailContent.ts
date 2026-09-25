import type { AgreementKind } from '@prisma/client';
import {
  appLink,
  greetingFor,
  renderBrandedEmail,
  toEmailLang,
  type EmailLang,
  type RenderedEmail,
} from './emailLayout.js';

/**
 * The new-generation templates: content in English, Spanish and Turkish,
 * rendered through the one shared layout. Each template is a function of
 * plain data and returns subject + html + text, so a route or sweep can
 * hand the result straight to send()/notify*.
 *
 * Rules every template here follows:
 *   - subjects are sentence case, specific, never a code or password
 *   - one headline, one or two sentences, one button
 *   - every link is an absolute URL on the public app host
 *   - dates are written out in the reader's language
 */

const LOCALE: Record<EmailLang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR' };
const TZ = 'America/New_York';

export function longDate(d: Date, lang: EmailLang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' }).format(d);
}

export function dateTime(d: Date, lang: EmailLang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/* ---- agreement kinds, in three languages ------------------------------- */

const AGREEMENT_LABEL: Record<EmailLang, Record<AgreementKind, string>> = {
  en: {
    NDA: 'non-disclosure agreement',
    NON_COMPETE: 'non-compete agreement',
    IP_ASSIGNMENT: 'intellectual property agreement',
    ARBITRATION: 'arbitration agreement',
    EMPLOYMENT_OFFER: 'employment offer',
    SEPARATION_AGREEMENT: 'separation agreement',
    EQUITY_GRANT: 'equity grant agreement',
    OTHER: 'agreement',
  },
  es: {
    NDA: 'acuerdo de confidencialidad',
    NON_COMPETE: 'acuerdo de no competencia',
    IP_ASSIGNMENT: 'acuerdo de propiedad intelectual',
    ARBITRATION: 'acuerdo de arbitraje',
    EMPLOYMENT_OFFER: 'oferta de empleo',
    SEPARATION_AGREEMENT: 'acuerdo de separación',
    EQUITY_GRANT: 'acuerdo de participación accionaria',
    OTHER: 'acuerdo',
  },
  tr: {
    NDA: 'gizlilik sözleşmesi',
    NON_COMPETE: 'rekabet yasağı sözleşmesi',
    IP_ASSIGNMENT: 'fikri mülkiyet sözleşmesi',
    ARBITRATION: 'tahkim sözleşmesi',
    EMPLOYMENT_OFFER: 'iş teklifi',
    SEPARATION_AGREEMENT: 'işten ayrılma sözleşmesi',
    EQUITY_GRANT: 'hisse sözleşmesi',
    OTHER: 'sözleşme',
  },
};

export function agreementLabel(kind: AgreementKind, customLabel: string | null | undefined, lang: EmailLang): string {
  if (kind === 'OTHER' && customLabel?.trim()) return customLabel.trim();
  return AGREEMENT_LABEL[lang][kind];
}

/* ---- "your employment offer is waiting for your signature" ------------- */

export interface AgreementReminderOpts {
  lang?: string | null;
  firstName: string | null;
  kind: AgreementKind;
  customLabel?: string | null;
  /** When the agreement was issued. */
  issuedAt: Date;
  /** The date it must be signed by, if there is one. */
  signBy?: Date | null;
  /** The employer named on the offer, when known. */
  employerName?: string | null;
  refId?: string;
}

const REMINDER = {
  en: {
    subject: (label: string) => `Your ${label} is waiting for your signature`,
    preheader: (date: string) => `It was sent on ${date}. Review and sign in a few minutes.`,
    heading: (label: string) => `Your ${label} is waiting for your signature`,
    intro: (label: string, date: string) =>
      `We sent you ${withArticle('en', label)} on ${date} and it has not been signed yet. Please review it and sign when you are ready.`,
    signBy: (date: string) => `It needs to be signed by ${date}.`,
    document: 'Document',
    sentOn: 'Sent on',
    signByLabel: 'Sign by',
    employer: 'Employer',
    cta: 'Review and sign',
    alreadySigned: 'If you have already signed it, you can ignore this message.',
    questions: 'If you have questions about the offer, reply to this email or call us at the number below.',
  },
  es: {
    subject: (label: string) => `Su ${label} está pendiente de firma`,
    preheader: (date: string) => `Se la enviamos el ${date}. Revísela y fírmela en unos minutos.`,
    heading: (label: string) => `Su ${label} está pendiente de firma`,
    intro: (label: string, date: string) =>
      `Le enviamos ${withArticle('es', label)} el ${date} y todavía no ha sido firmada. Por favor revísela y fírmela cuando esté listo.`,
    signBy: (date: string) => `Debe firmarse antes del ${date}.`,
    document: 'Documento',
    sentOn: 'Enviado el',
    signByLabel: 'Firmar antes del',
    employer: 'Empleador',
    cta: 'Revisar y firmar',
    alreadySigned: 'Si ya la firmó, puede ignorar este mensaje.',
    questions: 'Si tiene preguntas sobre la oferta, responda a este correo o llámenos al número que aparece abajo.',
  },
  tr: {
    subject: (label: string) => `${cap(label, 'tr')}niz imzanızı bekliyor`,
    preheader: (date: string) => `${date} tarihinde gönderildi. Birkaç dakikada inceleyip imzalayabilirsiniz.`,
    heading: (label: string) => `${cap(label, 'tr')}niz imzanızı bekliyor`,
    intro: (label: string, date: string) =>
      `${date} tarihinde size bir ${label} gönderdik ve henüz imzalanmadı. Lütfen inceleyin ve hazır olduğunuzda imzalayın.`,
    signBy: (date: string) => `${date} tarihine kadar imzalanması gerekiyor.`,
    document: 'Belge',
    sentOn: 'Gönderim tarihi',
    signByLabel: 'Son imza tarihi',
    employer: 'İşveren',
    cta: 'İncele ve imzala',
    alreadySigned: 'Zaten imzaladıysanız bu mesajı dikkate almayabilirsiniz.',
    questions: 'Teklifle ilgili sorularınız varsa bu e-postayı yanıtlayın veya aşağıdaki numaradan bizi arayın.',
  },
} as const;

function cap(s: string, lang: EmailLang = 'en'): string {
  // Turkish dots its capital I ("İş"), which the default upper-casing loses.
  return s.charAt(0).toLocaleUpperCase(LOCALE[lang]) + s.slice(1);
}

function withArticle(lang: 'en' | 'es', label: string): string {
  if (lang === 'en') return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`;
  // Spanish: the agreement nouns above are masculine except "oferta"; a
  // custom label defaults to the feminine reading "una", matching "firmada".
  return `${/^(acuerdo)/i.test(label) ? 'un' : 'una'} ${label}`;
}

export function agreementReminderEmail(o: AgreementReminderOpts): RenderedEmail {
  const lang = toEmailLang(o.lang);
  const s = REMINDER[lang];
  const label = agreementLabel(o.kind, o.customLabel, lang);
  const sent = longDate(o.issuedAt, lang);
  const signBy = o.signBy ? longDate(o.signBy, lang) : null;

  const summary = [
    { label: s.document, value: cap(label, lang) },
    { label: s.sentOn, value: sent },
    ...(signBy ? [{ label: s.signByLabel, value: signBy }] : []),
    ...(o.employerName ? [{ label: s.employer, value: o.employerName }] : []),
  ];

  return renderBrandedEmail({
    lang,
    subject: s.subject(label),
    preheader: s.preheader(sent),
    greeting: greetingFor(lang, o.firstName),
    heading: s.heading(label),
    paragraphs: [s.intro(label, sent), ...(signBy ? [s.signBy(signBy)] : [])],
    summary,
    cta: { label: s.cta, url: appLink('/agreements') },
    after: [s.alreadySigned, s.questions],
    refId: o.refId,
  });
}

/* ---- financial change: the associate's confirmation ------------------------ */

export type FinancialChangeKindKey =
  | 'BANK_ACCOUNT'
  | 'PAY_CARD'
  | 'PAY_METHOD'
  | 'W4'
  | 'LEGAL_NAME'
  | 'SSN'
  | 'HOME_ADDRESS';

const CHANGE_NOUN: Record<EmailLang, Record<FinancialChangeKindKey, string>> = {
  en: {
    BANK_ACCOUNT: 'direct deposit account',
    PAY_CARD: 'pay card',
    PAY_METHOD: 'payment method',
    W4: 'W-4 tax withholding',
    LEGAL_NAME: 'legal name',
    SSN: 'Social Security number on file',
    HOME_ADDRESS: 'home address',
  },
  es: {
    BANK_ACCOUNT: 'cuenta de depósito directo',
    PAY_CARD: 'tarjeta de pago',
    PAY_METHOD: 'método de pago',
    W4: 'retención de impuestos (W-4)',
    LEGAL_NAME: 'nombre legal',
    SSN: 'número de Seguro Social registrado',
    HOME_ADDRESS: 'dirección de casa',
  },
  tr: {
    BANK_ACCOUNT: 'maaş hesabınız',
    PAY_CARD: 'maaş kartınız',
    PAY_METHOD: 'ödeme yönteminiz',
    W4: 'W-4 vergi kesintiniz',
    LEGAL_NAME: 'yasal adınız',
    SSN: 'kayıtlı Sosyal Güvenlik numaranız',
    HOME_ADDRESS: 'ev adresiniz',
  },
};

const CONFIRM = {
  en: {
    subject: (noun: string) => `Your ${noun} was changed`,
    preheader: 'If you made this change, no action is needed.',
    intro: (noun: string, when: string, byAdmin: boolean) =>
      byAdmin
        ? `An Alto HR administrator changed your ${noun} on ${when}.`
        : `Your ${noun} was changed on ${when}.`,
    payHold: 'Finance will confirm the change with you by phone before it is used for a paycheck.',
    ok: 'If you made this change, no action is needed.',
    notYou: 'If you did not make this change, call us right away at the number below. Do not reply with account numbers or your Social Security number.',
    newValue: 'New',
    changedOn: 'Changed on',
    cta: 'Review my pay settings',
  },
  es: {
    subject: (noun: string) => `Se cambió su ${noun}`,
    preheader: 'Si usted hizo este cambio, no necesita hacer nada.',
    intro: (noun: string, when: string, byAdmin: boolean) =>
      byAdmin
        ? `Un administrador de Alto HR cambió su ${noun} el ${when}.`
        : `Su ${noun} se cambió el ${when}.`,
    payHold: 'Finanzas confirmará el cambio con usted por teléfono antes de usarlo para un pago.',
    ok: 'Si usted hizo este cambio, no necesita hacer nada.',
    notYou: 'Si usted no hizo este cambio, llámenos de inmediato al número que aparece abajo. No responda con números de cuenta ni con su número de Seguro Social.',
    newValue: 'Nuevo',
    changedOn: 'Fecha del cambio',
    cta: 'Revisar mi configuración de pago',
  },
  tr: {
    subject: (noun: string) => `${cap(noun, 'tr')} değiştirildi`,
    preheader: 'Bu değişikliği siz yaptıysanız bir şey yapmanız gerekmez.',
    intro: (noun: string, when: string, byAdmin: boolean) =>
      byAdmin
        ? `Bir Alto HR yöneticisi ${when} tarihinde ${noun} değiştirdi.`
        : `${cap(noun, 'tr')} ${when} tarihinde değiştirildi.`,
    payHold: 'Finans ekibi, bir ödemede kullanılmadan önce değişikliği sizinle telefonla teyit edecek.',
    ok: 'Bu değişikliği siz yaptıysanız bir şey yapmanız gerekmez.',
    notYou: 'Bu değişikliği siz yapmadıysanız aşağıdaki numaradan hemen bizi arayın. Hesap numaralarınızı veya Sosyal Güvenlik numaranızı e-postayla göndermeyin.',
    newValue: 'Yeni',
    changedOn: 'Değişiklik tarihi',
    cta: 'Ödeme ayarlarımı incele',
  },
} as const;

export interface FinancialChangeConfirmationOpts {
  lang?: string | null;
  firstName: string | null;
  kind: FinancialChangeKindKey;
  /** Masked: "Chase · checking · ending 4821". Never a full number. */
  newSummary: string | null;
  when: Date;
  byAdmin: boolean;
  refId?: string;
}

export function financialChangeConfirmationEmail(o: FinancialChangeConfirmationOpts): RenderedEmail {
  const lang = toEmailLang(o.lang);
  const s = CONFIRM[lang];
  const noun = CHANGE_NOUN[lang][o.kind];
  const when = dateTime(o.when, lang);
  const gatesPay = o.kind === 'BANK_ACCOUNT' || o.kind === 'PAY_CARD' || o.kind === 'PAY_METHOD';
  return renderBrandedEmail({
    lang,
    subject: s.subject(noun),
    preheader: s.preheader,
    greeting: greetingFor(lang, o.firstName),
    heading: s.subject(noun),
    paragraphs: [s.intro(noun, when, o.byAdmin), ...(gatesPay ? [s.payHold] : [])],
    summary: [
      ...(o.newSummary ? [{ label: s.newValue, value: o.newSummary }] : []),
      { label: s.changedOn, value: when },
    ],
    cta: { label: s.cta, url: appLink('/pay') },
    after: [s.ok, s.notYou],
    refId: o.refId,
  });
}

/* ---- financial change: the Finance alert (internal, English) ---------------- */

export interface FinancialChangeAlertOpts {
  change: {
    id: string;
    kind: FinancialChangeKindKey;
    source: string;
    onBehalf: boolean;
    oldSummary: string | null;
    newSummary: string | null;
    ip: string | null;
    userAgent: string | null;
    authStrength: string;
    riskFlags: string[];
    riskScore: number;
    highRisk: boolean;
    status: string;
    verifyPhoneLast4: string | null;
    createdAt: Date;
  };
  associateName: string;
  actorName: string;
}

const KIND_TITLE: Record<FinancialChangeKindKey, string> = {
  BANK_ACCOUNT: 'direct deposit account',
  PAY_CARD: 'pay card',
  PAY_METHOD: 'payment method',
  W4: 'W-4 withholding',
  LEGAL_NAME: 'legal name',
  SSN: 'SSN / TIN',
  HOME_ADDRESS: 'home address',
};

const FLAG_TEXT: Record<string, string> = {
  contact_changed_recently: 'email or phone changed in the last 14 days',
  near_payroll_cutoff: 'within 3 days of the payroll cutoff',
  admin_on_behalf: 'made by an administrator on their behalf',
  new_account: 'account less than 30 days old',
  shared_bank_account: 'same bank account on file for another associate',
  weak_sign_in: 'password-only sign-in',
};

export function financialChangeAlertEmail(o: FinancialChangeAlertOpts): RenderedEmail {
  const c = o.change;
  const title = KIND_TITLE[c.kind];
  const gatesPay = c.kind === 'BANK_ACCOUNT' || c.kind === 'PAY_CARD' || c.kind === 'PAY_METHOD';
  const held = c.status === 'HELD';
  const subject = held
    ? `Held for review: ${o.associateName} changed their ${title}`
    : `${o.associateName} changed their ${title}`;
  const device = [c.ip, c.userAgent ? shortAgent(c.userAgent) : null].filter(Boolean).join(' · ') || 'unknown';
  const flags = c.riskFlags.map((f) => FLAG_TEXT[f] ?? f);
  const paragraphs = [
    gatesPay
      ? `This change is not used for payroll until Finance verifies it by calling the associate on the phone number that was on file before the change${c.verifyPhoneLast4 ? ` (ending ${c.verifyPhoneLast4})` : ''}.`
      : 'Review it in the Finance queue and mark it verified once you have confirmed it with the associate.',
    ...(held ? [`It was held automatically: risk score ${c.riskScore}.`] : []),
  ];
  return renderBrandedEmail({
    lang: 'en',
    subject,
    preheader: `${c.oldSummary ?? 'none'} → ${c.newSummary ?? 'none'}. By ${o.actorName}.`,
    greeting: null,
    heading: subject,
    paragraphs,
    summary: [
      { label: 'Associate', value: o.associateName },
      { label: 'Change', value: title },
      { label: 'Before', value: c.oldSummary ?? 'none on file' },
      { label: 'After', value: c.newSummary ?? 'none on file' },
      { label: 'By', value: `${o.actorName}${c.onBehalf ? ' (on behalf)' : ''}` },
      { label: 'When', value: dateTime(c.createdAt, 'en') },
      { label: 'Device', value: device },
      { label: 'Sign-in', value: c.authStrength === 'MFA' || c.authStrength === 'PASSKEY' ? `${c.authStrength} (strong)` : c.authStrength },
      { label: 'Risk flags', value: flags.length ? flags.join('; ') : 'none' },
      { label: 'Status', value: held ? 'Held — needs Finance' : 'Pending verification' },
    ],
    cta: { label: 'Open the Finance queue', url: appLink(`/payroll/financial-changes?id=${c.id}`) },
    after: ['Full account numbers and Social Security numbers are never included in email. Open Alto to act on this change.'],
    securityLine: null,
  });
}

function shortAgent(ua: string): string {
  const m = /(iPhone|iPad|Android|Windows|Macintosh|Linux)/.exec(ua);
  const b = /(Edg|Chrome|Safari|Firefox)\//.exec(ua);
  return [m?.[1], b?.[1] === 'Edg' ? 'Edge' : b?.[1]].filter(Boolean).join(' ') || ua.slice(0, 40);
}
