import type { GarnishmentKind } from '@prisma/client';
import type { PayFrequency } from './garnishmentEngine.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * Electronic Income Withholding Orders (e-IWO).
 *
 * The federal Office of Child Support Services (OCSS, formerly OCSE) runs
 * the e-IWO exchange: a state child-support agency sends the employer the
 * federal Income Withholding for Support form (OMB 0970-0154) as data, and
 * the employer answers each document with an acknowledgment — accepted or
 * rejected with a reason — and later with the employment-termination and
 * lump-sum notices the form's page 3 asks for.
 *
 *   inbound   one file, one or more IWO documents. Each carries a
 *             Document Action Code: ORG (original order), AMD (amended),
 *             TRM (terminate withholding), LUM (lump-sum payment
 *             instruction).
 *   outbound  an acknowledgment per document; termination and lump-sum
 *             notices per order.
 *
 * Source: OCSS "e-IWO Employer Specifications" and the IWO form
 * instructions (acf.gov/css/resource/income-withholding-for-support-form).
 * The tag names below follow the e-IWO XML element names as best we have
 * them, with the common variants accepted, because states and portals
 * differ in spelling. Every place we are not certain of the exact element
 * or code value carries "CONFIRM WITH OCSS e-IWO Employer Specification".
 *
 * No external XML library is a declared dependency of the API, so a small
 * tokenizer reads the file. It handles the declaration, comments, CDATA,
 * attributes, self-closing tags and the five XML entities — what the
 * e-IWO files use.
 */

/* ----- a tolerant XML reader ------------------------------------------- */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export class EiwoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EiwoParseError';
  }
}

/** Parse XML into a tree. Namespace prefixes are dropped from names. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const local = (n: string) => (n.includes(':') ? n.slice(n.indexOf(':') + 1) : n);
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1]!.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end === -1) throw new EiwoParseError('An XML comment is never closed.');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (end === -1) throw new EiwoParseError('A CDATA section is never closed.');
      stack[stack.length - 1]!.text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt);
      if (end === -1) throw new EiwoParseError('A declaration is never closed.');
      i = end + 1;
    } else if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt);
      if (end === -1) throw new EiwoParseError('A closing tag is never finished.');
      const name = local(xml.slice(lt + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) throw new EiwoParseError(`The file closes <${name}> where <${open?.name ?? 'nothing'}> was open.`);
      i = end + 1;
    } else {
      const end = xml.indexOf('>', lt);
      if (end === -1) throw new EiwoParseError('A tag is never finished.');
      let body = xml.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
      if (!m) throw new EiwoParseError('A tag has no name.');
      const attrs: Record<string, string> = {};
      for (const a of m[2]!.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        attrs[local(a[1]!)] = decodeEntities(a[3] ?? a[4] ?? '');
      }
      const node: XmlNode = { name: local(m[1]!), attrs, children: [], text: '' };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw new EiwoParseError(`<${stack[stack.length - 1]!.name}> is never closed.`);
  if (root.children.length === 0) throw new EiwoParseError('The file has no XML elements.');
  return root;
}

function walk(node: XmlNode, visit: (n: XmlNode) => void): void {
  visit(node);
  for (const c of node.children) walk(c, visit);
}

/** Every leaf element's text, keyed by lower-case name (first one wins). */
function leaves(node: XmlNode): Map<string, string> {
  const out = new Map<string, string>();
  walk(node, (n) => {
    if (n.children.length === 0) {
      const key = n.name.toLowerCase();
      const v = n.text.trim();
      if (v && !out.has(key)) out.set(key, v);
    }
  });
  return out;
}

/* ----- the document ---------------------------------------------------- */

export type EiwoActionCode = 'ORG' | 'AMD' | 'TRM' | 'LUM';

export interface ParsedEiwo {
  documentActionCode: EiwoActionCode;
  /** The sender's tracking number for this document, echoed in the acknowledgment. */
  documentTrackingNumber: string | null;
  caseIdentifier: string | null;
  orderIdentifier: string | null;
  remittanceIdentifier: string | null;
  issuingState: string | null;
  fipsCode: string | null;
  issuingAgency: string | null;
  employeeFirstName: string | null;
  employeeLastName: string | null;
  /** Full SSN when the document carries it; used to match, never stored in the clear. */
  employeeSsn: string | null;
  employeeDob: string | null;
  employerEin: string | null;
  orderFrequency: PayFrequency | null;
  currentSupport: number | null;
  pastDueSupport: number | null;
  medicalSupport: number | null;
  otherAmount: number | null;
  /** The total the order states per `orderFrequency`. */
  totalPerPeriod: number | null;
  arrearsOver12Weeks: boolean;
  /** The state's CCPA limit as the form states it (e.g. 50 or 60). */
  withholdLimitPercent: number | null;
  lumpSumAmount: number | null;
  payeeName: string | null;
  payeeAddress: string | null;
  payeeFips: string | null;
  documentDate: string | null;
  /** Begin withholding no later than … (the form says the first pay period after 7 business days). */
  beginWithholdingBy: string | null;
  /** Mapped from the order type; e-IWO is support only, so this is CHILD_SUPPORT. */
  kind: GarnishmentKind;
}

/** Every element name we accept per field, lower-case. CONFIRM WITH OCSS e-IWO Employer Specification (XML element names). */
const FIELDS: Record<string, string[]> = {
  action: ['documentactioncode', 'actioncode', 'iwoactioncode'],
  tracking: ['documenttrackingnumber', 'documenttrackingid', 'trackingnumber', 'documentid', 'iwoid'],
  caseId: ['caseidentifier', 'caseid', 'casenumber', 'iv-dcaseidentifier', 'ivdcaseid'],
  orderId: ['orderidentifier', 'orderid', 'ordernumber', 'courtordernumber'],
  remitId: ['remittanceidentifier', 'remittanceid', 'remittancenumber'],
  state: ['issuingstatetribeterritory', 'issuingstate', 'statetribeterritorycode', 'statecode', 'state'],
  fips: ['issuingjurisdictionfipscode', 'fipscode', 'issuingfips', 'fips'],
  agency: ['issuingagencyname', 'issuingjurisdictionname', 'agencyname', 'issuingagency'],
  first: ['employeefirstname', 'obligorfirstname', 'firstname'],
  last: ['employeelastname', 'obligorlastname', 'lastname'],
  ssn: ['employeessn', 'obligorssn', 'ssn', 'socialsecuritynumber'],
  dob: ['employeebirthdate', 'obligorbirthdate', 'employeedob', 'dateofbirth', 'birthdate'],
  ein: ['employerfein', 'employerein', 'fein', 'ein'],
  freq: ['currentsupportfrequency', 'supportfrequency', 'orderfrequency', 'frequencycode', 'frequency', 'perperiodfrequency'],
  current: ['currentchildsupportamount', 'currentsupportamount', 'currentsupport'],
  pastDue: ['pastduechildsupportamount', 'pastduesupportamount', 'pastduesupport', 'arrearsamount'],
  medical: ['currentcashmedicalsupportamount', 'cashmedicalsupportamount', 'currentmedicalsupportamount', 'medicalsupportamount', 'medicalsupport'],
  pastDueMedical: ['pastduecashmedicalsupportamount', 'pastduemedicalsupportamount'],
  spousal: ['currentspousalsupportamount', 'spousalsupportamount'],
  pastDueSpousal: ['pastduespousalsupportamount'],
  other: ['otheramount', 'othersupportamount'],
  total: ['totalamounttowithhold', 'totalwithholdingamount', 'totalamount'],
  arrears12: ['arrearsgreaterthan12weeksindicator', 'arrearsgreaterthan12weeks', 'arrears12weeksindicator', 'arrearsover12weeks'],
  limit: ['withholdlimitpercent', 'ccpalimitpercent', 'statewithholdinglimit', 'maximumwithholdingpercent'],
  lumpSum: ['lumpsumpaymentamount', 'lumpsumamount'],
  payee: ['sduname', 'payeename', 'remittancepayeename', 'disbursementunitname'],
  payeeLine1: ['sduaddressline1', 'payeeaddressline1', 'remittanceaddressline1'],
  payeeCity: ['sducity', 'payeecity', 'remittancecity'],
  payeeState: ['sdustate', 'payeestate', 'remittancestate'],
  payeeZip: ['sduzip', 'sduzipcode', 'payeezip', 'remittancezip'],
  payeeFips: ['sdufipscode', 'payeefipscode', 'remittancefipscode'],
  docDate: ['documentdate', 'orderdate', 'iwodate', 'issuedate'],
  begin: ['beginwithholdingdate', 'withholdingbegindate', 'startdate'],
};

function pick(map: Map<string, string>, field: keyof typeof FIELDS): string | null {
  for (const k of FIELDS[field]!) {
    const v = map.get(k);
    if (v) return v;
  }
  return null;
}

function money(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** e-IWO frequency codes. CONFIRM WITH OCSS e-IWO Employer Specification (frequency code list). */
export function parseFrequency(v: string | null): PayFrequency | null {
  if (!v) return null;
  const t = v.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (['W', 'WK', 'WEEKLY', 'PERWEEK'].includes(t)) return 'WEEKLY';
  if (['B', 'BW', 'BIWEEKLY', 'EVERYTWOWEEKS'].includes(t)) return 'BIWEEKLY';
  if (['S', 'SM', 'SEMIMONTHLY', 'TWICEAMONTH'].includes(t)) return 'SEMIMONTHLY';
  if (['M', 'MO', 'MONTHLY', 'PERMONTH'].includes(t)) return 'MONTHLY';
  return null;
}

function yesNo(v: string | null): boolean {
  if (!v) return false;
  return ['Y', 'YES', 'TRUE', '1'].includes(v.trim().toUpperCase());
}

function isoDate(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`; // CCYYMMDD
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return null;
}

/** The element names that wrap one IWO document. CONFIRM WITH OCSS e-IWO Employer Specification (document element). */
const DOCUMENT_ELEMENTS = new Set(['iwo', 'iwodocument', 'document', 'incomewithholdingorder', 'eiwodocument', 'iwodetail', 'withholdingorder']);

/** Split a file into its IWO documents and read each one. */
export function parseEiwoFile(xml: string): ParsedEiwo[] {
  const root = parseXml(xml);
  const docs: XmlNode[] = [];
  walk(root, (n) => {
    if (DOCUMENT_ELEMENTS.has(n.name.toLowerCase())) docs.push(n);
  });
  // A document nested in another document element counts once (outermost).
  const outer = docs.filter((d) => !docs.some((o) => o !== d && contains(o, d)));
  const blocks = outer.length > 0 ? outer : [root.children[0]!];
  return blocks.map(readDocument);
}

function contains(outer: XmlNode, inner: XmlNode): boolean {
  let found = false;
  walk(outer, (n) => {
    if (n === inner && n !== outer) found = true;
  });
  return found;
}

function readDocument(node: XmlNode): ParsedEiwo {
  const map = leaves(node);
  const actionRaw = (pick(map, 'action') ?? 'ORG').trim().toUpperCase();
  if (!['ORG', 'AMD', 'TRM', 'LUM'].includes(actionRaw)) {
    throw new EiwoParseError(`Document action code "${actionRaw}" is not ORG, AMD, TRM or LUM.`);
  }
  const ssnRaw = pick(map, 'ssn');
  const ssn = ssnRaw ? ssnRaw.replace(/\D/g, '') : null;
  const sum = (...vals: Array<number | null>) => {
    const present = vals.filter((v): v is number => v != null);
    return present.length ? Math.round(present.reduce((s, v) => s + v, 0) * 100) / 100 : null;
  };
  const line1 = pick(map, 'payeeLine1');
  const city = pick(map, 'payeeCity');
  const st = pick(map, 'payeeState');
  const zip = pick(map, 'payeeZip');
  const cityLine = [city, [st, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const address = [line1, cityLine].filter(Boolean).join('\n') || null;
  const limit = pick(map, 'limit');
  return {
    documentActionCode: actionRaw as EiwoActionCode,
    documentTrackingNumber: pick(map, 'tracking'),
    caseIdentifier: pick(map, 'caseId'),
    orderIdentifier: pick(map, 'orderId'),
    remittanceIdentifier: pick(map, 'remitId'),
    issuingState: pick(map, 'state')?.slice(0, 2).toUpperCase() ?? null,
    fipsCode: pick(map, 'fips')?.replace(/\D/g, '').slice(0, 7) || null,
    issuingAgency: pick(map, 'agency'),
    employeeFirstName: pick(map, 'first'),
    employeeLastName: pick(map, 'last'),
    employeeSsn: ssn && ssn.length === 9 ? ssn : null,
    employeeDob: isoDate(pick(map, 'dob')),
    employerEin: pick(map, 'ein')?.replace(/\D/g, '') || null,
    orderFrequency: parseFrequency(pick(map, 'freq')),
    currentSupport: sum(money(pick(map, 'current')), money(pick(map, 'spousal'))),
    pastDueSupport: sum(money(pick(map, 'pastDue')), money(pick(map, 'pastDueMedical')), money(pick(map, 'pastDueSpousal'))),
    medicalSupport: money(pick(map, 'medical')),
    otherAmount: money(pick(map, 'other')),
    totalPerPeriod: money(pick(map, 'total')),
    arrearsOver12Weeks: yesNo(pick(map, 'arrears12')),
    withholdLimitPercent: limit ? Number(limit.replace(/[^\d.]/g, '')) || null : null,
    lumpSumAmount: money(pick(map, 'lumpSum')),
    payeeName: pick(map, 'payee'),
    payeeAddress: address,
    payeeFips: pick(map, 'payeeFips')?.replace(/\D/g, '').slice(0, 7) || null,
    documentDate: isoDate(pick(map, 'docDate')),
    beginWithholdingBy: isoDate(pick(map, 'begin')),
    kind: 'CHILD_SUPPORT',
  };
}

/** What a document is missing before it can become an order (empty when complete). */
export function eiwoProblems(d: ParsedEiwo): string[] {
  const out: string[] = [];
  if (!d.caseIdentifier) out.push('The document has no case identifier.');
  if (!d.employeeLastName) out.push('The document does not name the employee.');
  if (!d.employeeSsn) out.push('The document has no full Social Security number to match the employee.');
  if (d.documentActionCode === 'ORG' || d.documentActionCode === 'AMD') {
    if (!d.orderFrequency) out.push('The document does not say how often its amounts are owed.');
    if ((d.currentSupport ?? 0) + (d.pastDueSupport ?? 0) + (d.medicalSupport ?? 0) + (d.otherAmount ?? 0) + (d.totalPerPeriod ?? 0) <= 0) {
      out.push('The document has no amount to withhold.');
    }
  }
  if (d.documentActionCode === 'LUM' && !(d.lumpSumAmount && d.lumpSumAmount > 0)) out.push('The lump-sum instruction has no amount.');
  return out;
}

/** The copy of a parsed document we keep: the SSN reduced to its last four. */
export function redactParsed(d: ParsedEiwo): Omit<ParsedEiwo, 'employeeSsn'> & { employeeSsnLast4: string | null } {
  const { employeeSsn, ...rest } = d;
  return { ...rest, employeeSsnLast4: employeeSsn ? employeeSsn.slice(-4) : null };
}

/* ----- the employer's answers ------------------------------------------ */

/**
 * Disposition reason codes for a rejected document.
 * CONFIRM WITH OCSS e-IWO Employer Specification (Acknowledgment record,
 * Disposition Reason Code list) — the letters may differ from the spec's.
 */
export const REJECT_REASONS = {
  N: 'The person is not and has not been our employee.',
  T: 'The person no longer works here.',
  D: 'This order is a duplicate of one we already have.',
  U: 'We cannot process the order as sent: information is missing or wrong.',
  S: 'The person is on leave or not currently paid.',
  O: 'Another reason, explained in the text.',
} as const;
export type RejectReasonCode = keyof typeof REJECT_REASONS;

export interface EmployerFacts {
  ein: string;
  name: string;
  address?: string | null;
}

function x(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(name: string, value: string | number | null | undefined, indent = '    '): string {
  return value == null || value === '' ? '' : `${indent}<${name}>${x(value)}</${name}>\n`;
}

function header(employer: EmployerFacts, now: Date, controlNumber: string): string {
  return (
    '  <Header>\n' +
    el('EmployerFEIN', employer.ein.replace(/\D/g, '')) +
    el('EmployerName', employer.name) +
    el('EmployerAddress', employer.address ?? null) +
    el('CreatedDateTime', now.toISOString()) +
    el('ControlNumber', controlNumber) +
    '  </Header>\n'
  );
}

export interface AckInput {
  doc: ParsedEiwo | (Omit<ParsedEiwo, 'employeeSsn'> & { employeeSsn?: string | null });
  /** The employee's full SSN, from our records when the document lacked it. */
  ssn: string | null;
  accepted: boolean;
  reasonCode?: RejectReasonCode | null;
  reasonText?: string | null;
  /** Rejections for termination give the date and, when known, the new employer. */
  terminationDate?: string | null;
  newEmployerName?: string | null;
  newEmployerAddress?: string | null;
}

/**
 * The acknowledgment file for one or more documents. Status A (accepted) or
 * R (rejected) with a reason code. CONFIRM WITH OCSS e-IWO Employer
 * Specification (Acknowledgment XML element names).
 */
export function buildAcknowledgment(employer: EmployerFacts, acks: AckInput[], now = new Date(), controlNumber = String(now.getTime())): string {
  const body = acks
    .map((a) => {
      const d = a.doc;
      return (
        '  <Acknowledgment>\n' +
        el('DocumentActionCode', d.documentActionCode) +
        el('DocumentTrackingNumber', d.documentTrackingNumber) +
        el('CaseIdentifier', d.caseIdentifier) +
        el('OrderIdentifier', d.orderIdentifier) +
        el('RemittanceIdentifier', d.remittanceIdentifier) +
        el('IssuingJurisdictionFIPSCode', d.fipsCode) +
        el('EmployeeSSN', a.ssn) +
        el('EmployeeLastName', d.employeeLastName) +
        el('EmployeeFirstName', d.employeeFirstName) +
        el('DispositionStatusCode', a.accepted ? 'A' : 'R') +
        el('DispositionReasonCode', a.accepted ? null : (a.reasonCode ?? 'O')) +
        el('DispositionReasonText', a.accepted ? null : (a.reasonText ?? REJECT_REASONS[a.reasonCode ?? 'O'])) +
        el('TerminationDate', a.terminationDate ?? null) +
        el('NewEmployerName', a.newEmployerName ?? null) +
        el('NewEmployerAddress', a.newEmployerAddress ?? null) +
        el('EmployerSentDate', orgDateKey(now)) +
        '  </Acknowledgment>\n'
      );
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<EIWOAcknowledgmentFile>\n${header(employer, now, controlNumber)}${body}</EIWOAcknowledgmentFile>\n`;
}

export interface OrderRef {
  caseIdentifier: string | null;
  orderIdentifier: string | null;
  remittanceIdentifier: string | null;
  fipsCode: string | null;
  employeeFirstName: string;
  employeeLastName: string;
  ssn: string | null;
}

export interface TerminationNotice {
  order: OrderRef;
  terminationDate: string;
  lastPayDate: string | null;
  finalPaymentAmount: number | null;
  employeeLastKnownAddress: string | null;
  employeePhone?: string | null;
  newEmployerName?: string | null;
  newEmployerAddress?: string | null;
}

/** The IWO page-3 termination notice, in the acknowledgment format. CONFIRM WITH OCSS e-IWO Employer Specification. */
export function buildTerminationNotice(employer: EmployerFacts, n: TerminationNotice, now = new Date(), controlNumber = String(now.getTime())): string {
  const o = n.order;
  const body =
    '  <EmploymentTerminationNotice>\n' +
    el('DocumentActionCode', 'TRM') +
    el('CaseIdentifier', o.caseIdentifier) +
    el('OrderIdentifier', o.orderIdentifier) +
    el('RemittanceIdentifier', o.remittanceIdentifier) +
    el('IssuingJurisdictionFIPSCode', o.fipsCode) +
    el('EmployeeSSN', o.ssn) +
    el('EmployeeLastName', o.employeeLastName) +
    el('EmployeeFirstName', o.employeeFirstName) +
    el('TerminationDate', n.terminationDate) +
    el('LastPaymentDate', n.lastPayDate) +
    el('FinalPaymentAmount', n.finalPaymentAmount?.toFixed(2) ?? null) +
    el('EmployeeLastKnownAddress', n.employeeLastKnownAddress) +
    el('EmployeeLastKnownPhone', n.employeePhone ?? null) +
    el('NewEmployerName', n.newEmployerName ?? null) +
    el('NewEmployerAddress', n.newEmployerAddress ?? null) +
    el('EmployerSentDate', orgDateKey(now)) +
    '  </EmploymentTerminationNotice>\n';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<EIWOAcknowledgmentFile>\n${header(employer, now, controlNumber)}${body}</EIWOAcknowledgmentFile>\n`;
}

export type LumpSumType = 'BONUS' | 'COMMISSION' | 'SEVERANCE' | 'INSURANCE' | 'OTHER';

export interface LumpSumNotice {
  order: OrderRef;
  paymentType: LumpSumType;
  amount: number;
  expectedPaymentDate: string;
}

/** The lump-sum payment notice, sent before the money is paid so the agency can claim it. CONFIRM WITH OCSS e-IWO Employer Specification. */
export function buildLumpSumNotice(employer: EmployerFacts, n: LumpSumNotice, now = new Date(), controlNumber = String(now.getTime())): string {
  const o = n.order;
  const body =
    '  <LumpSumPaymentNotice>\n' +
    el('DocumentActionCode', 'LUM') +
    el('CaseIdentifier', o.caseIdentifier) +
    el('OrderIdentifier', o.orderIdentifier) +
    el('RemittanceIdentifier', o.remittanceIdentifier) +
    el('IssuingJurisdictionFIPSCode', o.fipsCode) +
    el('EmployeeSSN', o.ssn) +
    el('EmployeeLastName', o.employeeLastName) +
    el('EmployeeFirstName', o.employeeFirstName) +
    el('LumpSumPaymentType', n.paymentType) +
    el('LumpSumPaymentAmount', n.amount.toFixed(2)) +
    el('LumpSumPaymentDate', n.expectedPaymentDate) +
    el('EmployerSentDate', orgDateKey(now)) +
    '  </LumpSumPaymentNotice>\n';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<EIWOAcknowledgmentFile>\n${header(employer, now, controlNumber)}${body}</EIWOAcknowledgmentFile>\n`;
}

/** The withholding fields an accepted document sets on its order. */
export function orderFieldsFrom(d: ParsedEiwo): {
  currentSupport: number | null;
  pastDueSupport: number | null;
  medicalSupport: number | null;
  orderFrequency: PayFrequency | null;
  arrearsOver12Weeks: boolean;
  amountPerRun: number | null;
} {
  // When a document gives only a total (no breakdown), the total is current support.
  const parts = (d.currentSupport ?? 0) + (d.pastDueSupport ?? 0) + (d.medicalSupport ?? 0);
  const current = (parts > 0 ? (d.currentSupport ?? 0) : (d.totalPerPeriod ?? 0)) + (d.otherAmount ?? 0);
  return {
    currentSupport: current > 0 ? Math.round(current * 100) / 100 : null,
    pastDueSupport: d.pastDueSupport,
    medicalSupport: d.medicalSupport,
    orderFrequency: d.orderFrequency,
    arrearsOver12Weeks: d.arrearsOver12Weeks,
    amountPerRun: null,
  };
}
