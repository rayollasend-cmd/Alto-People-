import { localDateKey, zonedMinutes } from './timezone.js';
import { companyWorkweek } from './timeAnomalies.js';
/**
 * ASC X12 834 Benefit Enrollment and Maintenance, version 005010X220A1
 * (the HIPAA-mandated implementation guide for enrollment to a carrier).
 *
 *   ISA/GS            interchange and functional group envelopes (GS01 BE)
 *   ST/BGN            transaction set header; BGN08 action code
 *                       RX replace (a full file), 2 change (a change file)
 *   REF*38            master policy number
 *   DTP*007           effective date of the file
 *   QTY               totals: TO members, ET subscribers, DT dependents
 *   N1*P5 / N1*IN     sponsor (the employer) and payer (the carrier)
 *   loop 2000 member  INS (Y subscriber / N dependent, relationship,
 *                     maintenance type and reason, benefit status,
 *                     employment status), REF*0F subscriber id,
 *                     DTP*336 employment begin
 *   loop 2100A        NM1*IL name and SSN, PER, N3/N4 address, DMG birth date
 *   loop 2300         HD (maintenance type, insurance line, plan, coverage
 *                     level), DTP*348 benefit begin, DTP*349 benefit end
 *   SE/GE/IEA         trailers with segment and control counts
 *
 * Maintenance type codes (INS03 / HD01): 021 addition, 024 cancellation or
 * termination, 001 change, 030 audit or compare (every member of a full
 * file). Reason codes (INS04) map from the qualifying life event.
 *
 * Source: ASC X12 005010X220A1 Technical Report Type 3 (CMS adopted it
 * under 45 CFR 162.1502). Exact usage varies by carrier companion guide —
 * CONFIRM WITH each carrier's 834 companion guide (REF qualifiers, whether
 * full files use BGN08 RX or 4, and which DTP segments are required).
 */

export type MaintenanceType = '001' | '021' | '024' | '030';

export interface Edi834Envelope {
  senderQualifier: string;
  senderId: string;
  receiverQualifier: string;
  receiverId: string;
  usage: 'T' | 'P';
  controlNumber: number;
  createdAt: Date;
}

export interface Edi834Header {
  mode: 'FULL' | 'CHANGE';
  referenceId: string;
  policyNumber: string | null;
  effectiveDate: string;
  sponsorName: string;
  sponsorTaxId: string | null;
  carrierName: string;
  carrierTaxId?: string | null;
}

export interface Edi834Coverage {
  maintenance: MaintenanceType;
  insuranceLine: string;
  planCode: string | null;
  coverageLevel: string;
  begin: string;
  end: string | null;
}

export interface Edi834Member {
  subscriber: boolean;
  /** INS02: 18 self, 01 spouse, 19 child, 53 life partner, G8 other relative. */
  relationship: string;
  maintenance: MaintenanceType;
  /** INS04 reason: 28 initial enrollment, 32 marriage, 01 divorce, 02 birth, 05 adoption, 03 death, 07 termination of benefits, AI no reason given, XN notification only. */
  reason: string;
  /** INS08: FT, PT, TE (terminated). Subscribers only. */
  employmentStatus: string | null;
  /** The subscriber's identifier (REF*0F), the same on the subscriber and their dependents. */
  subscriberId: string;
  lastName: string;
  firstName: string;
  ssn: string | null;
  dob: string | null;
  gender: 'M' | 'F' | 'U';
  phone: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null } | null;
  hireDate: string | null;
  coverages: Edi834Coverage[];
}

/** INS02 relationship codes from our dependent relation. */
export const RELATIONSHIP_CODES: Record<string, string> = { SELF: '18', SPOUSE: '01', CHILD: '19', DOMESTIC_PARTNER: '53', OTHER: 'G8' };

/** HD03 insurance line codes from the plan kind (when the plan does not set one). */
export const INSURANCE_LINE_BY_KIND: Record<string, string | null> = {
  HEALTH_MEDICAL: 'HLT',
  DENTAL: 'DEN',
  VISION: 'VIS',
  LIFE_INSURANCE: 'LIF',
  DISABILITY: 'LTD',
  HSA: null,
  FSA_HEALTHCARE: null,
  FSA_DEPENDENT_CARE: null,
  RETIREMENT_401K: null,
  RETIREMENT_403B: null,
  TRUMP_ACCOUNT: null,
};

/** INS04 from a qualifying life event kind. CONFIRM WITH X12 code list 1203 / carrier companion guide. */
export const REASON_BY_QLE: Record<string, string> = {
  MARRIAGE: '32',
  DIVORCE: '01',
  BIRTH: '02',
  ADOPTION: '05',
  DEATH_OF_DEPENDENT: '03',
  LOSS_OF_COVERAGE: 'AI',
  GAIN_OF_COVERAGE: 'AI',
  RELOCATION: '43',
  OTHER: 'AI',
};

const ELEMENT = '*';
const SEGMENT = '~';
const COMPONENT = ':';
const REPETITION = '^';

/** X12 basic character set: upper-case, no delimiters inside a value. */
function v(s: string | number | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[*~:^\r\n]/g, ' ')
    .trim()
    .toUpperCase();
}
const pad = (s: string, n: number) => v(s).slice(0, n).padEnd(n, ' ');
const d8 = (iso: string) => iso.replace(/-/g, '').slice(0, 8);
const seg = (...els: Array<string | number | null | undefined>) => {
  // Trailing empty elements are dropped, as X12 requires.
  const parts = els.map((e) => (e == null ? '' : String(e)));
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.join(ELEMENT) + SEGMENT;
};

export interface Built834 {
  content: string;
  segmentCount: number;
  memberCount: number;
  subscriberCount: number;
}

export function build834(env: Edi834Envelope, header: Edi834Header, members: Edi834Member[]): Built834 {
  const now = env.createdAt;
  // X12 dates and times carry no zone: the envelope (ISA09/10, GS04/05, BGN03/04)
  // is stamped on the company's clock, all from the one instant.
  const tz = companyWorkweek().timezone;
  const ccyymmdd = localDateKey(now, tz).replace(/-/g, '');
  const yymmdd = ccyymmdd.slice(2);
  const minutes = zonedMinutes(now, tz);
  const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
  const ctl = String(env.controlNumber).padStart(9, '0');
  if (ctl.length > 9) throw new Error('Interchange control number exceeds nine digits.');
  const isa =
    [
      'ISA', '00', ' '.repeat(10), '00', ' '.repeat(10),
      pad(env.senderQualifier, 2), pad(env.senderId, 15),
      pad(env.receiverQualifier, 2), pad(env.receiverId, 15),
      yymmdd, hhmm, REPETITION, '00501', ctl, '0', env.usage, COMPONENT,
    ].join(ELEMENT) + SEGMENT;
  const gs = seg('GS', 'BE', v(env.senderId), v(env.receiverId), ccyymmdd, hhmm, env.controlNumber, 'X', '005010X220A1');

  const body: string[] = [];
  body.push(seg('ST', '834', '0001', '005010X220A1'));
  body.push(seg('BGN', '00', v(header.referenceId).slice(0, 50), ccyymmdd, hhmm, '', '', '', header.mode === 'FULL' ? 'RX' : '2'));
  if (header.policyNumber) body.push(seg('REF', '38', v(header.policyNumber).slice(0, 50)));
  body.push(seg('DTP', '007', 'D8', d8(header.effectiveDate)));
  const subscribers = members.filter((m) => m.subscriber).length;
  body.push(seg('QTY', 'TO', members.length));
  body.push(seg('QTY', 'ET', subscribers));
  body.push(seg('QTY', 'DT', members.length - subscribers));
  body.push(seg('N1', 'P5', v(header.sponsorName).slice(0, 60), header.sponsorTaxId ? 'FI' : '', header.sponsorTaxId ? header.sponsorTaxId.replace(/\D/g, '') : ''));
  body.push(seg('N1', 'IN', v(header.carrierName).slice(0, 60), header.carrierTaxId ? 'FI' : '', header.carrierTaxId ? header.carrierTaxId.replace(/\D/g, '') : ''));

  for (const m of members) {
    body.push(seg('INS', m.subscriber ? 'Y' : 'N', m.relationship, m.maintenance, m.reason, 'A', '', '', m.subscriber ? (m.employmentStatus ?? 'FT') : ''));
    body.push(seg('REF', '0F', v(m.subscriberId).slice(0, 50)));
    if (m.subscriber && m.hireDate) body.push(seg('DTP', '336', 'D8', d8(m.hireDate)));
    body.push(seg('NM1', 'IL', '1', v(m.lastName).slice(0, 60), v(m.firstName).slice(0, 35), '', '', '', m.ssn ? '34' : '', m.ssn ? m.ssn.replace(/\D/g, '') : ''));
    if (m.subscriber && m.phone) body.push(seg('PER', 'IP', '', 'TE', m.phone.replace(/\D/g, '').slice(0, 10)));
    if (m.address?.line1) {
      body.push(seg('N3', v(m.address.line1).slice(0, 55), m.address.line2 ? v(m.address.line2).slice(0, 55) : ''));
      body.push(seg('N4', v(m.address.city).slice(0, 30), v(m.address.state).slice(0, 2), (m.address.zip ?? '').replace(/\D/g, '').slice(0, 9)));
    }
    if (m.dob) body.push(seg('DMG', 'D8', d8(m.dob), m.gender));
    for (const c of m.coverages) {
      body.push(seg('HD', c.maintenance, '', v(c.insuranceLine), c.planCode ? v(c.planCode).slice(0, 50) : '', v(c.coverageLevel)));
      body.push(seg('DTP', '348', 'D8', d8(c.begin)));
      if (c.end) body.push(seg('DTP', '349', 'D8', d8(c.end)));
    }
  }
  const segmentCount = body.length + 1; // ST through SE inclusive
  body.push(seg('SE', segmentCount, '0001'));
  const ge = seg('GE', 1, env.controlNumber);
  const iea = seg('IEA', 1, ctl);
  return { content: [isa, gs, ...body, ge, iea].join('\n') + '\n', segmentCount, memberCount: members.length, subscriberCount: subscribers };
}

/** Parse an 834 back into segments (for checks and tests). */
export function segmentsOf(content: string): string[][] {
  return content
    .split(SEGMENT)
    .map((s) => s.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((s) => s.split(ELEMENT));
}

/** HD05 coverage level from who is covered. */
export function coverageLevelFor(dependents: Array<{ relation: string }>): string {
  const spouse = dependents.some((d) => d.relation === 'SPOUSE' || d.relation === 'DOMESTIC_PARTNER');
  const kids = dependents.filter((d) => d.relation === 'CHILD' || d.relation === 'OTHER').length;
  if (spouse && kids) return 'FAM';
  if (spouse) return 'ESP';
  if (kids === 1) return 'E1D';
  if (kids > 1) return 'ECH';
  return 'EMP';
}
