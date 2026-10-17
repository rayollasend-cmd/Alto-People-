/**
 * IRS Modernized e-File (MeF) return XML for Forms 941 and 940.
 *
 * MeF wraps every return in a ReturnHeader (tax period, filer EIN and
 * name, the return type) and a ReturnData holding the form's own
 * elements. This builds that document from a TaxForm row's amounts and
 * the submitter profile, element names as the IRS publishes them for the
 * 94x family. Transmission needs an Authorized e-file Provider (or the
 * payroll filing partner) with an EFIN/ETIN and the IRS-issued
 * submission manifest — Alto renders and packages; it does not transmit.
 */

export interface MefFiler {
  ein: string;
  name: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

export interface Mef941Input {
  taxYear: number;
  quarter: number;
  filer: MefFiler;
  amounts: Record<string, unknown>;
  generatedAt: Date;
}

export interface Mef940Input {
  taxYear: number;
  filer: MefFiler;
  amounts: Record<string, unknown>;
  generatedAt: Date;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}
function amt(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}
function int(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return String(Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));
}
function el(name: string, value: string | null | undefined, indent = '    '): string {
  if (value === null || value === undefined || value === '') return '';
  return `${indent}<${name}>${esc(value)}</${name}>\n`;
}

function header(input: { taxYear: number; periodBegin: string; periodEnd: string; returnType: '941' | '940'; filer: MefFiler; generatedAt: Date }): string {
  const f = input.filer;
  return (
    `  <ReturnHeader binaryAttachmentCnt="0">\n` +
    el('ReturnTs', input.generatedAt.toISOString(), '    ') +
    el('TaxPeriodBeginDt', input.periodBegin, '    ') +
    el('TaxPeriodEndDt', input.periodEnd, '    ') +
    el('TaxYr', String(input.taxYear), '    ') +
    el('ReturnTypeCd', input.returnType, '    ') +
    `    <Filer>\n` +
    el('EIN', digits(f.ein), '      ') +
    `      <BusinessName>\n${el('BusinessNameLine1Txt', f.name, '        ')}      </BusinessName>\n` +
    el('BusinessNameControlTxt', f.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase(), '      ') +
    `      <USAddress>\n` +
    el('AddressLine1Txt', f.addressLine1, '        ') +
    el('CityNm', f.city, '        ') +
    el('StateAbbreviationCd', f.state, '        ') +
    el('ZIPCd', digits(f.zip).slice(0, 5), '        ') +
    `      </USAddress>\n` +
    `    </Filer>\n` +
    `    <BusinessOfficerGrp>\n` +
    el('PersonNm', f.contactName, '      ') +
    el('PersonTitleTxt', 'Payroll', '      ') +
    el('PhoneNum', digits(f.contactPhone), '      ') +
    el('SignatureDt', input.generatedAt.toISOString().slice(0, 10), '      ') +
    `    </BusinessOfficerGrp>\n` +
    `  </ReturnHeader>\n`
  );
}

/** Form 941 for one quarter. */
export function build941Xml(input: Mef941Input): string {
  const q = input.quarter;
  const begin = `${input.taxYear}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  const endMonth = q * 3;
  const endDay = new Date(Date.UTC(input.taxYear, endMonth, 0)).getUTCDate();
  const end = `${input.taxYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  const a = input.amounts;
  const wages = Number(a.totalWages ?? 0);
  const ssMed = Number(a.ficaMedicareWages ?? wages);
  const ssTax = Math.round(ssMed * 0.124 * 100) / 100;
  const medTax = Math.round(ssMed * 0.029 * 100) / 100;
  const fit = Number(a.totalFederalWithheld ?? 0);
  const total = Math.round((fit + ssTax + medTax) * 100) / 100;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Return xmlns="http://www.irs.gov/efile" returnVersion="${input.taxYear}v1.0">\n` +
    header({ taxYear: input.taxYear, periodBegin: begin, periodEnd: end, returnType: '941', filer: input.filer, generatedAt: input.generatedAt }) +
    `  <ReturnData documentCnt="1">\n` +
    `    <IRS941 documentId="IRS941-1">\n` +
    el('QuarterCd', String(q), '      ') +
    el('EmployeeCnt', int(a.employeeCount), '      ') +
    el('WagesAmt', amt(wages), '      ') +
    el('FederalIncomeTaxWithheldAmt', amt(fit), '      ') +
    el('SocialSecurityTaxCashWagesAmt', amt(ssMed), '      ') +
    el('SocialSecurityTaxAmt', amt(ssTax), '      ') +
    el('TaxOnMedicareWagesTipsAmt', amt(ssMed), '      ') +
    el('MedicareTaxAmt', amt(medTax), '      ') +
    el('TotalSSMdcrTaxAmt', amt(ssTax + medTax), '      ') +
    el('TotalTaxBeforeAdjustmentAmt', amt(total), '      ') +
    el('TotalTaxAfterAdjustmentAmt', amt(total), '      ') +
    el('TotalTaxAmt', amt(total), '      ') +
    el('TotalTaxDepositAmt', amt(a.depositsMade ?? total), '      ') +
    el('BalanceDueAmt', amt(Math.max(0, total - Number(a.depositsMade ?? total))), '      ') +
    `    </IRS941>\n` +
    `  </ReturnData>\n` +
    `</Return>\n`
  );
}

/** Form 940 for one year. */
export function build940Xml(input: Mef940Input): string {
  const a = input.amounts;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Return xmlns="http://www.irs.gov/efile" returnVersion="${input.taxYear}v1.0">\n` +
    header({ taxYear: input.taxYear, periodBegin: `${input.taxYear}-01-01`, periodEnd: `${input.taxYear}-12-31`, returnType: '940', filer: input.filer, generatedAt: input.generatedAt }) +
    `  <ReturnData documentCnt="1">\n` +
    `    <IRS940 documentId="IRS940-1">\n` +
    el('TotalWagesAmt', amt(a.totalPayments), '      ') +
    el('ExemptWagesAmt', amt(a.exemptPayments), '      ') +
    el('WagesOverLimitAmt', amt(a.excessPayments), '      ') +
    el('TotalExemptWagesAmt', amt(Number(a.exemptPayments ?? 0) + Number(a.excessPayments ?? 0)), '      ') +
    el('TotalTaxableWagesAmt', amt(a.futaTaxableWages), '      ') +
    el('FUTATaxBeforeAdjustmentsAmt', amt(a.futaTaxNet), '      ') +
    el('TotalFUTATaxAfterAdjustmentsAmt', amt(a.futaTaxNet), '      ') +
    el('FUTATaxDepositedAmt', amt(a.depositsMade), '      ') +
    el('BalanceDueAmt', amt(a.balanceDue), '      ') +
    `    </IRS940>\n` +
    `  </ReturnData>\n` +
    `</Return>\n`
  );
}
