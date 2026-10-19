import { COLOR, SIZE, createDoc, fmt, type Tone } from './docKit/index.js';
import { currentBrand } from './docKit/brand.js';
import type { ExternalPayrollSheetResult } from './externalPayrollSheet.js';
import { describeGaps } from './externalPayrollSheetXlsx.js';

/**
 * External payroll sheet PDF.
 *
 * The spreadsheet is the machine handoff; this is the human/archival copy.
 * Sixteen columns will not fit legibly across a landscape page, so instead of
 * shrinking type to 5pt this renders one bordered CARD per employee with the
 * fields in labelled pairs. That keeps every value readable when the file is
 * printed — which, being a payroll document, it will be.
 *
 * Every page carries a CONFIDENTIAL rule and the page number, because a
 * printed page of this file separated from its cover sheet is still a stack
 * of SSNs and bank accounts.
 */

export interface PacketRenderOpts {
  /** "Downloaded by Dana Ortiz · Sep 24, 2026 10:14 AM ET · PKT-…" — on every page. */
  watermark: string;
}

function fmtWhen(d: Date): string {
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function renderExternalPayrollSheetPdf(
  data: ExternalPayrollSheetResult,
  generatedAt: Date,
  opts: PacketRenderOpts = { watermark: `Generated ${fmtWhen(generatedAt)}` },
): Promise<Buffer> {
  const range = fmt.dateRange(data.from, new Date(data.to.getTime() - 1));
  const { k } = createDoc({ title: `External payroll sheet · ${range}` });
  let y = k.masthead({
    title: 'External payroll sheet',
    subtitle: 'For your payroll bureau · approved time only',
    brand: currentBrand(),
    meta: [
      { label: 'Employer', value: data.clientName ?? 'All clients' },
      { label: 'Pay period', value: range },
      { label: 'Employees', value: String(data.rows.length) },
      { label: 'Prepared', value: fmtWhen(generatedAt) },
    ],
  });
  y = k.callout({ tone: 'bad', title: 'Confidential', body: `Contains Social Security numbers and bank account details. Handle per your data-protection policy. ${opts.watermark}.` }, y);
  const gapNote = describeGaps(data);
  if (gapNote) y = k.callout({ tone: 'warn', body: gapNote }, y);
  if (data.truncated) y = k.callout({ tone: 'bad', title: 'Incomplete', body: 'The time-entry scan hit its cap. Narrow the range and regenerate before sending.' }, y);

  // Every bank, pay-card, W-4, name, SSN and address change since the last
  // download, with who made it and whether Finance verified it. The bureau
  // reads this before the roster.
  y = k.section('Changes since the last packet', y, data.sinceLastPacket ? `Since ${fmtWhen(data.sinceLastPacket)}` : 'Since the period start');
  if (!data.changes.length) {
    k.text('No financial changes.', k.L, y, { size: SIZE.body, color: COLOR.ink3 });
    y += 22;
  }
  for (const c of data.changes) {
    const tone: Tone = c.status === 'VERIFIED' ? 'good' : c.status === 'REJECTED' ? 'neutral' : 'bad';
    const state =
      c.status === 'VERIFIED'
        ? `Verified by ${c.verifiedBy ?? 'Finance'} on ${c.verifiedAt ? fmtWhen(c.verifiedAt) : '—'}`
        : c.status === 'REJECTED'
          ? 'Rejected — previous account restored'
          : c.status === 'HELD'
            ? 'Held — not verified; do not pay to the new account'
            : 'Unverified — acknowledged by the downloader; verify before paying';
    y = k.callout(
      {
        tone,
        title: `${c.associateName}${c.inPacket ? '' : ' (not in this packet)'} · ${c.kindLabel}${c.highRisk ? ' · High risk' : ''}`,
        body: `${c.oldSummary}  ›  ${c.newSummary}\nBy ${c.by}${c.onBehalf ? ' (on behalf)' : ''} on ${fmtWhen(c.at)} · ${state}${c.riskFlags.length ? ` · Flags: ${c.riskFlags.join(', ')}` : ''}`,
      },
      y,
    );
  }

  // One card per employee, every field labelled.
  y = k.section('Employees', y, `${data.rows.length} on this sheet`);
  if (!data.rows.length) {
    k.text('No approved time in this range.', k.L, y, { size: SIZE.body, color: COLOR.ink3 });
    y += 22;
  }
  for (const r of data.rows) {
    const pairs = [
      { label: 'Date of birth', value: r.dob ? fmt.date(r.dob) : '—' },
      { label: 'SSN', value: r.ssn || 'Missing', strong: !r.ssn },
      { label: 'W-4 filing status', value: r.w4FilingStatus || '—' },
      { label: 'Email', value: r.email || '—' },
      { label: 'Phone', value: r.phone || '—' },
      { label: 'Client', value: r.clientName || '—' },
      { label: 'Payment method', value: r.paymentMethod || '—' },
      { label: 'Bank', value: [r.bankName, r.accountType].filter(Boolean).join(' · ') || '—' },
      { label: 'Routing / account', value: `${r.routingNumber || 'missing'} / ${r.accountNumber || 'missing'}`, strong: !r.routingNumber || !r.accountNumber },
      { label: 'Pay rate', value: r.payRate == null ? '—' : `${fmt.money(r.payRate)}${r.payType ? ` · ${r.payType.toLowerCase()}` : ''}` },
      { label: 'Hours (regular / overtime)', value: `${fmt.hours(r.regularHours)} / ${fmt.hours(r.overtimeHours)}` },
      { label: 'Van ride charges', value: r.rideCharges == null ? '—' : fmt.money(r.rideCharges) },
    ];
    const flagsH = r.flags ? k.para(r.flags, 0, 0, k.width() - 24, { size: SIZE.small }, false) + 18 : 0;
    const cardH = 30 + 4 * 26 + 14 + flagsH;
    y = k.ensure(y, cardH + 10);
    k.outline(k.L, y, k.width(), cardH);
    k.text(r.fullName || '—', k.L + 12, y + 10, { size: SIZE.lead, weight: 'semibold', width: k.width() * 0.6 });
    k.text(r.fullAddress || '', k.L + k.width() * 0.4, y + 11.5, { size: SIZE.small, color: COLOR.ink3, width: k.width() * 0.6 - 12, align: 'right' });
    const fy = k.facts(pairs, y + 30, { x: k.L + 12, w: k.width() - 24, cols: 3 });
    if (r.flags) {
      const urgent = /HOLD|UNVERIFIED|HELD|HIGH RISK/i.test(r.flags);
      k.text('Flags', k.L + 12, fy, { size: SIZE.label, caps: true, color: urgent ? COLOR.bad : COLOR.ink3 });
      k.para(r.flags, k.L + 12, fy + 10, k.width() - 24, { size: SIZE.small, weight: urgent ? 'semibold' : 'regular', color: urgent ? COLOR.bad : COLOR.ink });
    }
    y += cardH + 10;
  }
  return k.finish({ confidentialLabel: 'Confidential — contains SSN and bank account data', note: opts.watermark, stamp: opts.watermark });
}
