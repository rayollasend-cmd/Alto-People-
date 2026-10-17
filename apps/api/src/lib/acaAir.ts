import { acaCode, type F1095cMonth } from './f1095cPdf.js';

/**
 * The IRS AIR (Affordable Care Act Information Returns) transmission: one
 * Form 1094-C transmittal carrying the year's 1095-C records, as XML in
 * the shape the AIR schemas use (Form109495CTransmittalUpstream →
 * Form1094CUpstreamDetail → Form1095CUpstreamDetail). This builds the
 * file; the transmission itself happens through the AIR UI/A2A channel
 * with the transmitter's TCC, which is the filing partner's or the
 * employer's own — Alto does not transmit.
 *
 * Shaped to the published element names so the file validates against
 * the schema with the manifest the transmitter adds; it is not a
 * substitute for the IRS AATS test cycle, which every transmitter runs
 * before production.
 */

export interface AirEmployer {
  name: string;
  ein: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

export interface AirEmployee {
  recordId: number;
  firstName: string;
  lastName: string;
  ssn: string | null;
  dob: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  months: Array<F1095cMonth | null>;
}

export interface AirFile {
  taxYear: number;
  employer: AirEmployer;
  employees: AirEmployee[];
  /** Full-time employee count per month, 12 entries. */
  fullTimeByMonth: number[];
  /** Total employee count per month, 12 entries. */
  totalByMonth: number[];
  generatedAt: Date;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}
function el(name: string, value: string | null | undefined, indent: string): string {
  if (value === null || value === undefined || value === '') return '';
  return `${indent}<${name}>${esc(value)}</${name}>\n`;
}

function addressXml(a: { addressLine1: string | null; city: string | null; state: string | null; zip: string | null }, indent: string): string {
  return (
    `${indent}<MailingAddressGrp>\n` +
    `${indent}  <USAddressGrp>\n` +
    el('AddressLine1Txt', a.addressLine1, `${indent}    `) +
    el('CityNm', a.city, `${indent}    `) +
    el('USStateCd', a.state, `${indent}    `) +
    el('USZIPCd', digits(a.zip).slice(0, 5), `${indent}    `) +
    `${indent}  </USAddressGrp>\n` +
    `${indent}</MailingAddressGrp>\n`
  );
}

function monthlyGrp(name: string, values: Array<string | null>, indent: string): string {
  // The "annual" shortcut applies when all twelve agree and are set.
  if (values.every((v) => v === values[0]) && values[0]) {
    return `${indent}<${name}>\n${el('AnnualOfferOfCoverageCd', values[0], `${indent}  `)}${indent}</${name}>\n`;
  }
  let out = `${indent}<${name}>\n`;
  values.forEach((v, i) => {
    out += el(`${MONTH_NAMES[i]}OfferCd`, v || '', `${indent}  `);
  });
  return out + `${indent}</${name}>\n`;
}

function monthlyAmt(name: string, values: Array<number | null>, indent: string): string {
  const money = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));
  if (values.every((v) => v === values[0]) && values[0] !== null) {
    return `${indent}<${name}>\n${el('AnnualContributionAmt', money(values[0]), `${indent}  `)}${indent}</${name}>\n`;
  }
  let out = `${indent}<${name}>\n`;
  values.forEach((v, i) => {
    out += el(`${MONTH_NAMES[i]}Amt`, money(v), `${indent}  `);
  });
  return out + `${indent}</${name}>\n`;
}

function monthlySafeHarbor(values: Array<string | null>, indent: string): string {
  if (values.every((v) => v === values[0]) && values[0]) {
    return `${indent}<AnnualSafeHarborCd>${esc(values[0])}</AnnualSafeHarborCd>\n`;
  }
  let out = `${indent}<MonthlySafeHarborGrp>\n`;
  values.forEach((v, i) => {
    out += el(`${MONTH_NAMES[i]}SafeHarborCd`, v || '', `${indent}  `);
  });
  return out + `${indent}</MonthlySafeHarborGrp>\n`;
}

export function buildAcaAirXml(file: AirFile): string {
  const e = file.employer;
  let x = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  x += `<n1:Form109495CTransmittalUpstream xmlns:n1="urn:us:gov:treasury:irs:msg:form1094-1095Ctransmitterupstreammessage" xmlns:irs="urn:us:gov:treasury:irs:common" xmlns="urn:us:gov:treasury:irs:ext:aca:air:ty${String(file.taxYear).slice(2)}">\n`;
  x += `  <Form1094CUpstreamDetail recordType="" lineNum="0">\n`;
  x += el('SubmissionId', '1', '    ');
  x += el('TaxYr', String(file.taxYear), '    ');
  x += el('CorrectedInd', '0', '    ');
  x += `    <EmployerInformationGrp>\n`;
  x += `      <BusinessName>\n${el('BusinessNameLine1Txt', e.name, '        ')}      </BusinessName>\n`;
  x += el('TINRequestTypeCd', 'BUSINESS_TIN', '      ');
  x += el('EmployerEIN', digits(e.ein), '      ');
  x += addressXml(e, '      ');
  x += `      <ContactNameGrp>\n`;
  const [first, ...rest] = (e.contactName ?? '').split(' ');
  x += el('PersonFirstNm', first || '', '        ');
  x += el('PersonLastNm', rest.join(' ') || '', '        ');
  x += `      </ContactNameGrp>\n`;
  x += el('ContactPhoneNum', digits(e.contactPhone), '      ');
  x += `    </EmployerInformationGrp>\n`;
  x += el('Form1095CAttachedCnt', String(file.employees.length), '    ');
  x += el('AuthoritativeTransmittalInd', '1', '    ');
  x += el('TotalForm1095CALEMemberCnt', String(file.employees.length), '    ');
  x += el('AggregatedGroupMemberCd', '0', '    ');
  x += `    <ALEMemberInformationGrp>\n`;
  x += `      <YearlyALEMemberDetail>\n`;
  x += el('MinEssentialCvrOffrCd', '1', '        ');
  x += el('ALEMemberFTECnt', String(Math.max(...file.fullTimeByMonth, 0)), '        ');
  x += el('TotalEmployeeCnt', String(Math.max(...file.totalByMonth, 0)), '        ');
  x += `      </YearlyALEMemberDetail>\n`;
  file.fullTimeByMonth.forEach((ft, i) => {
    x += `      <${MONTH_NAMES[i]}ALEMonthlyInfoGrp>\n`;
    x += el('MinEssentialCvrOffrCd', ft > 0 ? '1' : '0', '        ');
    x += el('ALEMemberFTECnt', String(ft), '        ');
    x += el('TotalEmployeeCnt', String(file.totalByMonth[i] ?? 0), '        ');
    x += `      </${MONTH_NAMES[i]}ALEMonthlyInfoGrp>\n`;
  });
  x += `    </ALEMemberInformationGrp>\n`;

  for (const emp of file.employees) {
    x += `    <Form1095CUpstreamDetail recordType="" lineNum="0">\n`;
    x += el('RecordId', String(emp.recordId), '      ');
    x += el('CorrectedInd', '0', '      ');
    x += el('TaxYr', String(file.taxYear), '      ');
    x += `      <EmployeeInfoGrp>\n`;
    x += `        <OtherCompletePersonName>\n${el('PersonFirstNm', emp.firstName, '          ')}${el('PersonLastNm', emp.lastName, '          ')}        </OtherCompletePersonName>\n`;
    x += el('PersonNameControlTxt', emp.lastName.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase(), '        ');
    x += el('TINRequestTypeCd', 'INDIVIDUAL_TIN', '        ');
    x += el('SSN', digits(emp.ssn), '        ');
    x += el('BirthDt', emp.dob, '        ');
    x += addressXml(emp, '        ');
    x += `      </EmployeeInfoGrp>\n`;
    x += `      <EmployeeOfferAndCoverageGrp>\n`;
    x += monthlyGrp('MonthlyOfferCoverageGrp', emp.months.map((m) => acaCode(m?.offerOfCoverage) || null), '        ');
    x += monthlyAmt('MonthlyShareOfLowestCostMonthlyPremGrp', emp.months.map((m) => m?.lowestPremiumCents ?? null), '        ');
    x += monthlySafeHarbor(emp.months.map((m) => m?.safeHarbor ?? null), '        ');
    x += `      </EmployeeOfferAndCoverageGrp>\n`;
    x += `    </Form1095CUpstreamDetail>\n`;
  }
  x += `  </Form1094CUpstreamDetail>\n`;
  x += `</n1:Form109495CTransmittalUpstream>\n`;
  return x;
}
