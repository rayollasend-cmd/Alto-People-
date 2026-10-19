import { createHash } from 'node:crypto';
import { COLOR, SIZE, createDoc, fmt } from './docKit/index.js';
import type { Prisma, PrismaClient, WagePayNotice } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { employerFor } from './employment.js';
import { payScheduleFor } from './associatePayday.js';
import { notifyAssociate } from './notify.js';
import { logger } from './logger.js';

/**
 * State pay notices — the written notice of pay rate, basis and payday a
 * worker gets at hire and when the rate changes — and their signed
 * acknowledgment.
 *
 *   NY  Labor Law §195(1) (Wage Theft Prevention Act). At hire, in English
 *       and in the worker's primary language when the Department of Labor
 *       publishes a template in it; signed acknowledgment kept six years.
 *       Forms by pay basis: LS 54 hourly, LS 56 weekly rate or salary for
 *       fixed hours, LS 59 exempt from overtime. The DOL publishes the
 *       templates in English, Spanish, Chinese, Haitian Creole, Korean,
 *       Polish and Russian (dol.ny.gov "Pay Notice" forms). §195(2): notice
 *       of a change before it takes effect — issued here on every rate change.
 *   CA  Labor Code §2810.5. At hire, non-exempt employees; within 7 calendar
 *       days of a change not shown on the next wage statement. Must state the
 *       workers' compensation carrier — not kept here, so the notice lists it
 *       as missing for HR to add before sending.
 *   IL  820 ILCS 115/10. At hire, the rate of pay and the time and place of
 *       payment; changes in writing before they take effect.
 *   WA  WAC 296-128-760. At hire, the paid sick leave entitlement, accrual
 *       and use, with the rate and payday.
 *
 * Text below follows the statutory elements; it is not a copy of the
 * agencies' forms. Translations are provided for English, Spanish and
 * Haitian Creole; a primary language without a translation here gets the
 * English notice and HR sees it flagged.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type NoticeForm = 'NY_LS54' | 'NY_LS56' | 'NY_LS59' | 'CA_2810_5' | 'IL_115_10' | 'WA_PSL';
export type NoticeTrigger = 'HIRE' | 'RATE_CHANGE' | 'MANUAL';
export type NoticeLanguage = 'en' | 'es' | 'ht';

export interface NoticeRule {
  state: string;
  citation: string;
  triggers: NoticeTrigger[];
  /** Languages the state publishes the notice in (ISO 639-1). */
  stateLanguages: string[];
  /** Exempt employees covered? (CA 2810.5 covers non-exempt only.) */
  coversExempt: boolean;
}

export const NOTICE_RULES: Record<string, NoticeRule> = {
  NY: { state: 'NY', citation: 'N.Y. Labor Law §195(1)–(2)', triggers: ['HIRE', 'RATE_CHANGE'], stateLanguages: ['en', 'es', 'zh', 'ht', 'ko', 'pl', 'ru'], coversExempt: true },
  CA: { state: 'CA', citation: 'Cal. Labor Code §2810.5', triggers: ['HIRE', 'RATE_CHANGE'], stateLanguages: ['en', 'es', 'zh', 'ko', 'tl', 'vi'], coversExempt: false },
  IL: { state: 'IL', citation: '820 ILCS 115/10', triggers: ['HIRE', 'RATE_CHANGE'], stateLanguages: ['en'], coversExempt: true },
  WA: { state: 'WA', citation: 'WAC 296-128-760', triggers: ['HIRE'], stateLanguages: ['en'], coversExempt: true },
};

export const FORM_TITLE: Record<NoticeForm, string> = {
  NY_LS54: 'NY LS 54 — Pay notice, hourly rate',
  NY_LS56: 'NY LS 56 — Pay notice, weekly rate or salary',
  NY_LS59: 'NY LS 59 — Pay notice, exempt employee',
  CA_2810_5: 'CA Labor Code 2810.5 notice to employee',
  IL_115_10: 'IL notice of pay rate and payday',
  WA_PSL: 'WA paid sick leave and pay notice',
};

export function formFor(state: string, facts: { payType: 'HOURLY' | 'SALARY'; exempt: boolean }): NoticeForm | null {
  switch (state) {
    case 'NY':
      return facts.exempt ? 'NY_LS59' : facts.payType === 'HOURLY' ? 'NY_LS54' : 'NY_LS56';
    case 'CA':
      return facts.exempt ? null : 'CA_2810_5';
    case 'IL':
      return 'IL_115_10';
    case 'WA':
      return 'WA_PSL';
    default:
      return null;
  }
}

/** The notice's language: the worker's, when the state publishes it AND we have the text. */
export function noticeLanguage(state: string, preferred: string | null | undefined): { language: NoticeLanguage; untranslated: string | null } {
  const rule = NOTICE_RULES[state];
  const p = (preferred ?? 'en').toLowerCase();
  if (p === 'en' || !rule) return { language: 'en', untranslated: null };
  if (!rule.stateLanguages.includes(p)) return { language: 'en', untranslated: null };
  if (p === 'es' || p === 'ht') return { language: p, untranslated: null };
  return { language: 'en', untranslated: p };
}

export interface NoticeFacts {
  employer: { legalName: string; addressLine1: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; ein: string | null };
  /** CA §2810.5: the workers' comp carrier, when the state's notice names it. */
  workersComp?: { carrier: string; address: string | null; phone: string | null; policyNumber: string | null } | null;
  employee: { name: string };
  payType: 'HOURLY' | 'SALARY';
  rate: number;
  /** "hour", "year". */
  basis: 'hour' | 'year';
  overtimeRate: number | null;
  exempt: boolean;
  payFrequency: string | null;
  regularPayday: string | null;
  allowances: string;
  effectiveDate: string;
  sickLeave: string | null;
  /** Facts the statute asks for that are not on file. */
  missing: string[];
  /** A primary language the state publishes but this notice is not translated into. */
  untranslatedLanguage: string | null;
}

const FREQ_LABEL: Record<string, string> = { WEEKLY: 'Weekly', BIWEEKLY: 'Every two weeks', SEMIMONTHLY: 'Twice a month', MONTHLY: 'Monthly', DAILY: 'Daily' };
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The facts a notice states, read from the records on file. */
export async function gatherNoticeFacts(db: Db, associateId: string, state: string, effectiveDate: Date): Promise<NoticeFacts | null> {
  const a = await db.associate.findUnique({
    where: { id: associateId },
    select: { firstName: true, lastName: true, jobProfile: { select: { isExempt: true } } },
  });
  if (!a) return null;
  const comp = await db.compensationRecord.findFirst({
    where: { associateId, effectiveFrom: { lte: new Date(effectiveDate.getTime() + 86_400_000) } },
    orderBy: { effectiveFrom: 'desc' },
    select: { payType: true, amount: true },
  });
  if (!comp) return null;
  const employer = await employerFor(db, associateId, effectiveDate);
  const schedule = await payScheduleFor(associateId);
  const exempt = a.jobProfile?.isExempt === true;
  const rate = Number(comp.amount);
  const missing: string[] = [];
  if (!employer.addressLine1 || !employer.city || !employer.zip) missing.push('Employer address');
  if (!employer.phone && (state === 'NY' || state === 'CA')) missing.push('Employer phone');
  if (state === 'CA' && !(employer.wcCarrierName && employer.wcCarrierAddress && employer.wcCarrierPhone && employer.wcPolicyNumber)) {
    missing.push("Workers' compensation carrier, address, phone and policy number");
  }
  let regularPayday: string | null = null;
  if (schedule) {
    const anchor = new Date(schedule.anchorDate);
    const payday = new Date(anchor.getTime() + (schedule.payDateOffsetDays + periodDays(schedule.frequency) - 1) * 86_400_000);
    regularPayday = periodDays(schedule.frequency) % 7 === 0 ? WEEKDAY[payday.getUTCDay()]! : null;
  }
  return {
    employer: { legalName: employer.legalName, addressLine1: employer.addressLine1, city: employer.city, state: employer.state, zip: employer.zip, phone: employer.phone, ein: employer.ein },
    workersComp:
      state === 'CA' && employer.wcCarrierName
        ? { carrier: employer.wcCarrierName, address: employer.wcCarrierAddress, phone: employer.wcCarrierPhone, policyNumber: employer.wcPolicyNumber }
        : null,
    employee: { name: `${a.firstName} ${a.lastName}`.trim() },
    payType: comp.payType,
    rate,
    basis: comp.payType === 'HOURLY' ? 'hour' : 'year',
    overtimeRate: exempt ? null : comp.payType === 'HOURLY' ? Math.round(rate * 1.5 * 100) / 100 : null,
    exempt,
    payFrequency: schedule ? FREQ_LABEL[schedule.frequency] ?? schedule.frequency : null,
    regularPayday,
    allowances: 'None',
    effectiveDate: effectiveDate.toISOString().slice(0, 10),
    sickLeave:
      state === 'CA'
        ? 'At least 40 hours or 5 days of paid sick leave a year (Labor Code §246).'
        : state === 'WA'
          ? 'At least 1 hour of paid sick leave for every 40 hours worked, usable after 90 days (RCW 49.46.210).'
          : null,
    missing,
    untranslatedLanguage: null,
  };
}

function periodDays(freq: string): number {
  return freq === 'WEEKLY' ? 7 : freq === 'BIWEEKLY' ? 14 : freq === 'DAILY' ? 1 : 15;
}

/** Where the person works: the open assignment's site, else their address state. */
export async function workStateOf(db: Db, associateId: string): Promise<string | null> {
  const open = await db.associateAssignment.findFirst({
    where: { associateId, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: { location: { select: { state: true } } },
  });
  if (open?.location?.state) return open.location.state.toUpperCase();
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { state: true } });
  return a?.state?.toUpperCase() ?? null;
}

export function documentHash(n: Pick<WagePayNotice, 'form' | 'language' | 'facts'> & { sentAt: Date | string }): string {
  const sentAt = typeof n.sentAt === 'string' ? n.sentAt : n.sentAt.toISOString();
  return createHash('sha256').update(JSON.stringify({ form: n.form, language: n.language, facts: n.facts, sentAt })).digest('hex');
}

/**
 * Issue the notice the person's work state requires for this trigger, if
 * any. Idempotent per (person, form, trigger, effective date). Returns the
 * notice, or null when no state rule applies.
 */
export async function issuePayNotice(
  db: Db,
  input: { associateId: string; trigger: NoticeTrigger; effectiveDate?: Date; actorUserId?: string | null; notify?: boolean },
): Promise<WagePayNotice | null> {
  const state = await workStateOf(db, input.associateId);
  if (!state) return null;
  const rule = NOTICE_RULES[state];
  if (!rule) return null;
  if (input.trigger !== 'MANUAL' && !rule.triggers.includes(input.trigger)) return null;
  const effective = input.effectiveDate ?? new Date();
  const facts = await gatherNoticeFacts(db, input.associateId, state, effective);
  if (!facts) return null;
  if (facts.exempt && !rule.coversExempt) return null;
  const form = formFor(state, facts);
  if (!form) return null;
  const user = await db.user.findFirst({ where: { associateId: input.associateId }, select: { language: true } });
  const lang = noticeLanguage(state, user?.language);
  facts.untranslatedLanguage = lang.untranslated;

  const existing = await db.wagePayNotice.findFirst({
    where: { associateId: input.associateId, form, trigger: input.trigger, facts: { path: ['effectiveDate'], equals: facts.effectiveDate } },
  });
  if (existing && input.trigger !== 'MANUAL') return existing;

  const sentAt = new Date();
  const tenant = await db.associate.findUnique({ where: { id: input.associateId }, select: { tenantId: true } });
  const created = await db.wagePayNotice.create({
    data: {
      associateId: input.associateId,
      ...(tenant?.tenantId ? { tenantId: tenant.tenantId } : {}),
      state,
      form,
      trigger: input.trigger,
      language: lang.language,
      facts: facts as unknown as Prisma.InputJsonValue,
      status: 'SENT',
      sentAt,
      createdById: input.actorUserId ?? null,
    },
  });
  if (input.notify !== false) {
    void notifyAssociate(input.associateId, {
      subject: 'Please sign your pay notice',
      body: `${state} law requires a written notice of your pay rate and payday. Open it, check it and sign.`,
      category: 'compensation',
      linkUrl: `/me/pay-notices/${created.id}`,
      emailFallback: true,
    });
  }
  return created;
}

/** Fire-and-forget wrapper for hooks (hire, rate change): never throws. */
export function issuePayNoticeInBackground(input: Parameters<typeof issuePayNotice>[1]): void {
  void issuePayNotice(defaultPrisma, input).catch((err) => {
    logger.warn({ err, associateId: input.associateId, trigger: input.trigger }, 'pay notice not issued');
  });
}

// ----- Text ---------------------------------------------------------------

type Strings = {
  heading: string;
  intro: (state: string) => string;
  employer: string;
  employee: string;
  rate: string;
  perHour: string;
  perYear: string;
  overtime: string;
  exempt: string;
  frequency: string;
  payday: string;
  allowances: string;
  effective: string;
  sick: string;
  workersComp: string;
  ack: string;
  signedBy: string;
  notSigned: string;
};

export const NOTICE_TEXT: Record<NoticeLanguage, Strings> = {
  en: {
    heading: 'Notice of pay rate and payday',
    intro: (s) => `${s} law requires your employer to tell you in writing how you are paid. Please check the details below and sign.`,
    employer: 'Employer',
    employee: 'Employee',
    rate: 'Pay rate',
    perHour: 'per hour',
    perYear: 'per year',
    overtime: 'Overtime rate',
    exempt: 'Exempt from overtime',
    frequency: 'How often you are paid',
    payday: 'Regular payday',
    allowances: 'Allowances taken (tips, meals, lodging)',
    effective: 'Effective',
    sick: 'Paid sick leave',
    workersComp: "Workers' compensation insurance",
    ack: 'I received this notice of my pay rate, overtime rate (if eligible), allowances and payday. I told my employer my primary language.',
    signedBy: 'Signed by',
    notSigned: 'Not signed yet',
  },
  es: {
    heading: 'Aviso de tarifa de pago y día de pago',
    intro: (s) => `La ley de ${s} exige que su empleador le informe por escrito cómo se le paga. Revise los datos y firme.`,
    employer: 'Empleador',
    employee: 'Empleado',
    rate: 'Tarifa de pago',
    perHour: 'por hora',
    perYear: 'por año',
    overtime: 'Tarifa de horas extra',
    exempt: 'Exento de horas extra',
    frequency: 'Frecuencia de pago',
    payday: 'Día de pago habitual',
    allowances: 'Créditos aplicados (propinas, comidas, alojamiento)',
    effective: 'Vigente desde',
    sick: 'Licencia por enfermedad pagada',
    workersComp: "Seguro de compensación para trabajadores",
    ack: 'Recibí este aviso de mi tarifa de pago, tarifa de horas extra (si corresponde), créditos y día de pago. Le dije a mi empleador cuál es mi idioma principal.',
    signedBy: 'Firmado por',
    notSigned: 'Aún sin firmar',
  },
  ht: {
    heading: 'Avi sou to salè ak jou peman',
    intro: (s) => `Lalwa ${s} mande pou anplwayè w di w alekri kijan yo peye w. Tanpri tcheke detay yo epi siyen.`,
    employer: 'Anplwayè',
    employee: 'Anplwaye',
    rate: 'To salè',
    perHour: 'pa èdtan',
    perYear: 'pa ane',
    overtime: 'To lè siplemantè',
    exempt: 'Egzante de lè siplemantè',
    frequency: 'Konbyen fwa yo peye w',
    payday: 'Jou peman regilye',
    allowances: 'Alokasyon yo pran (tip, manje, lojman)',
    effective: 'Kòmanse',
    sick: 'Konje maladi peye',
    workersComp: "Asirans konpansasyon travayè",
    ack: 'Mwen resevwa avi sa a sou to salè m, to lè siplemantè (si m kalifye), alokasyon ak jou peman. Mwen te di anplwayè m ki lang prensipal mwen.',
    signedBy: 'Siyen pa',
    notSigned: 'Poko siyen',
  },
};

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The notice's lines in one language — the page and the PDF read the same list. */
export function noticeLines(facts: NoticeFacts, lang: NoticeLanguage): Array<{ label: string; value: string }> {
  const t = NOTICE_TEXT[lang];
  const addr = [facts.employer.addressLine1, [facts.employer.city, facts.employer.state, facts.employer.zip].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const lines = [
    { label: t.employer, value: [facts.employer.legalName, addr, facts.employer.phone].filter(Boolean).join(' · ') },
    { label: t.employee, value: facts.employee.name },
    { label: t.rate, value: `${usd(facts.rate)} ${facts.basis === 'hour' ? t.perHour : t.perYear}` },
    { label: t.overtime, value: facts.exempt ? t.exempt : facts.overtimeRate != null ? `${usd(facts.overtimeRate)} ${t.perHour}` : '—' },
    { label: t.frequency, value: facts.payFrequency ?? '—' },
    { label: t.payday, value: facts.regularPayday ?? '—' },
    { label: t.allowances, value: facts.allowances },
    { label: t.effective, value: facts.effectiveDate },
  ];
  if (facts.sickLeave) lines.push({ label: t.sick, value: facts.sickLeave });
  if (facts.workersComp) {
    const w = facts.workersComp;
    lines.push({ label: t.workersComp, value: [w.carrier, w.address, w.phone, w.policyNumber ? `Policy ${w.policyNumber}` : null].filter(Boolean).join(' · ') });
  }
  return lines;
}

/** The notice as a PDF: the worker's language first, then English (NY §195(1)). */
export async function renderPayNoticePdf(n: WagePayNotice): Promise<Buffer> {
  const facts = n.facts as unknown as NoticeFacts;
  const langs: NoticeLanguage[] = n.language !== 'en' ? [n.language as NoticeLanguage, 'en'] : ['en'];
  const first = langs[0];
  const { k } = createDoc({ title: `${NOTICE_TEXT[first].heading} · ${facts.employee.name}`, author: facts.employer.legalName });
  const FOOT: Record<NoticeLanguage, { conf: string; page: (a: number, b: number) => string }> = {
    en: { conf: 'Confidential', page: (a, b) => `Page ${a} of ${b}` },
    es: { conf: 'Confidencial', page: (a, b) => `Página ${a} de ${b}` },
    ht: { conf: 'Konfidansyèl', page: (a, b) => `Paj ${a} sou ${b}` },
  };
  langs.forEach((lang, i) => {
    if (i > 0) k.doc.addPage();
    const t = NOTICE_TEXT[lang];
    const e = facts.employer;
    let y = k.masthead({
      title: t.heading,
      subtitle: `${FORM_TITLE[n.form as NoticeForm] ?? n.form} · ${NOTICE_RULES[n.state]?.citation ?? ''}`,
      brand: { name: e.legalName, lines: [[e.addressLine1, [[e.city, e.state].filter(Boolean).join(', '), e.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), e.phone ?? ''].filter(Boolean) },
    });
    y += k.para(t.intro(n.state), k.L, y, k.width(), { size: SIZE.lead, color: COLOR.ink2 }) + 14;
    // Each fact on its own line, values allowed to wrap: a legal notice never truncates.
    for (const l of noticeLines(facts, lang)) {
      const value = /^\d{4}-\d{2}-\d{2}$/.test(l.value) ? fmt.date(l.value) : l.value;
      const lw = k.width() * 0.32;
      const vw = k.width() * 0.64;
      const lh = k.para(l.label, 0, 0, lw, { size: SIZE.label, caps: true }, false);
      const vh = k.para(value, 0, 0, vw, { size: SIZE.body }, false);
      const h = Math.max(lh, vh, 12);
      y = k.ensure(y, h + 14);
      k.para(l.label, k.L, y + 1.5, lw, { size: SIZE.label, caps: true, color: COLOR.ink3 });
      k.para(value, k.L + k.width() * 0.36, y, vw, { size: SIZE.body, weight: 'medium' });
      y += h + 8;
      k.hr(y - 4);
    }
    y += 10;
    // The acknowledgment.
    const ackH = k.para(t.ack, 0, 0, k.width() - 28, { size: SIZE.body }, false);
    y = k.ensure(y, ackH + 90);
    k.box(k.L, y, k.width(), ackH + 24, COLOR.wash, 4);
    k.para(t.ack, k.L + 14, y + 12, k.width() - 28, { size: SIZE.body, color: COLOR.ink });
    y += ackH + 40;
    if (n.acknowledgedAt) {
      k.callout({ tone: 'good', title: `${t.signedBy} ${n.signedName ?? ''}`.trim(), body: `${fmt.dateTime(n.acknowledgedAt)}${n.documentHash ? `  ·  SHA-256 ${n.documentHash.slice(0, 16)}…` : ''}` }, y);
    } else {
      y += 18;
      k.signatureLine(k.L, y, 260, t.signedBy);
      k.signatureLine(k.L + 290, y, 150, ({ en: 'Date', es: 'Fecha', ht: 'Dat' } as const)[lang]);
      k.text(t.notSigned, k.L, y + 22, { size: SIZE.small, color: COLOR.ink3 });
    }
  });
  return k.finish({ reference: n.documentHash ? `SHA-256 ${n.documentHash}` : 'Pay notice', confidentialLabel: FOOT[first].conf, pageLabel: FOOT[first].page });
}

/** The worker signs: typed name, the document's hash, where it was signed from. */
export async function acknowledgePayNotice(
  db: Db,
  n: WagePayNotice,
  input: { signedName: string; ip: string | null; userAgent: string | null },
): Promise<WagePayNotice> {
  return db.wagePayNotice.update({
    where: { id: n.id },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: new Date(),
      signedName: input.signedName.slice(0, 200),
      signatureIp: input.ip?.slice(0, 64) ?? null,
      signatureUserAgent: input.userAgent?.slice(0, 300) ?? null,
      documentHash: documentHash(n),
    },
  });
}

/** Notices unsigned this long show on HR's Inbox. */
export const UNSIGNED_AFTER_DAYS = 7;
