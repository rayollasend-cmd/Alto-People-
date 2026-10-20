import type { Prisma, PrismaClient } from '@prisma/client';
import type { StatementSnapshot } from './clientStatement.js';
import { COLOR, SIZE, createDoc, fmt, loadBrand, type Brand } from './docKit/index.js';

/**
 * The client statement, as the invoice a customer's accounts-payable team
 * receives: who to pay and where (remit-to), the invoice number, date,
 * terms and due date, who it bills and under which PO, every billed
 * service, the adjustments payroll passed through, subtotal / tax / total,
 * payments received and the amount due, the account's aging, how to pay,
 * and a remittance stub to detach and return with a check.
 *
 * A DRAFT says so on every page (the figures recompute until finalized);
 * a paid invoice says PAID and shows the payment reference.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface Aging {
  current: number;
  d1to30: number;
  d31to60: number;
  d61to90: number;
  over90: number;
}

export interface StatementPdfInput {
  snapshot: StatementSnapshot;
  number: number | null;
  status: string;
  finalizedAt: Date | null;
  finalizedByEmail?: string | null;
  orgName?: string;
  billTo?: {
    legalName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  /** The rest is optional: statementContext() loads it for the routes. */
  brand?: Brand;
  remitTo?: { name: string; lines: string[] } | null;
  financeEmail?: string | null;
  poNumber?: string | null;
  termsDays?: number | null;
  dueDate?: Date | null;
  paidAt?: Date | null;
  paymentRef?: string | null;
  /** Open balance on the account by age, this invoice included. */
  aging?: Aging | null;
  /** The statement's own period, for snapshots that predate carrying it. */
  period?: { start: string; end: string } | null;
}

/** "Sep 26 – Oct 9, 2026" (one year), else both years. */
export function periodLabel(a: string, b: string): string {
  if (!a || !b) return fmt.dateRange(a, b);
  if (a.slice(0, 4) !== b.slice(0, 4)) return fmt.dateRange(a, b);
  const short = new Date(`${a}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${short} – ${fmt.date(b)}`;
}

export const invoiceLabel = (status: string, number: number | null): string =>
  status === 'FINAL' && number !== null ? `Invoice No. ${String(number).padStart(4, '0')}` : 'Draft statement';

/** What the remittance stub carries; pure, so the stub can be tested without a PDF. */
export function remittanceStub(input: StatementPdfInput): { payTo: string; customer: string; invoice: string; dueDate: string; amountDue: string; paid: boolean } {
  const s = completeStatementSnapshot(input.snapshot, input.billTo?.legalName ?? 'Client', input.period);
  const paid = !!input.paidAt;
  return {
    payTo: input.remitTo?.name ?? input.orgName ?? 'Alto People',
    customer: input.billTo?.legalName || s.clientName,
    invoice: invoiceLabel(input.status, input.number),
    dueDate: input.dueDate ? fmt.date(input.dueDate) : 'On receipt',
    amountDue: fmt.money(paid ? 0 : s.totals.amount),
    paid,
  };
}

/** Load the invoice's context for a statement: remit-to, terms, PO, due date, payment, aging, finance contact, brand. */
export async function statementContext(db: Db, o: { statementId: string; clientId: string; tenantId: string }): Promise<Partial<StatementPdfInput>> {
  const [row, client, employer, org, open, brand] = await Promise.all([
    db.clientStatement.findUnique({ where: { id: o.statementId }, select: { poNumber: true, dueAt: true, paidAt: true, paymentRef: true, periodStart: true, periodEnd: true } }),
    db.client.findUnique({ where: { id: o.clientId }, select: { poNumber: true, paymentTermsDays: true } }),
    db.employerOrganization.findFirst({ where: { tenantId: o.tenantId, clientId: null }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }], select: { legalName: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true, phone: true } }),
    db.orgSetting.findFirst({ where: { tenantId: o.tenantId }, select: { financeMailbox: true, supportEmail: true } }),
    db.clientStatement.findMany({ where: { clientId: o.clientId, status: 'FINAL', paidAt: null }, select: { dueAt: true, snapshot: true } }),
    loadBrand(db as never, o.tenantId),
  ]);
  const now = Date.now();
  const aging: Aging = { current: 0, d1to30: 0, d31to60: 0, d61to90: 0, over90: 0 };
  for (const st of open) {
    const amount = Number((st.snapshot as { totals?: { amount?: number } } | null)?.totals?.amount ?? 0);
    const late = st.dueAt ? Math.floor((now - st.dueAt.getTime()) / 86_400_000) : 0;
    if (late <= 0) aging.current += amount;
    else if (late <= 30) aging.d1to30 += amount;
    else if (late <= 60) aging.d31to60 += amount;
    else if (late <= 90) aging.d61to90 += amount;
    else aging.over90 += amount;
  }
  const remitLines = employer
    ? [employer.addressLine1, employer.addressLine2, [employer.city, employer.state].filter(Boolean).join(', ') + (employer.zip ? ` ${employer.zip}` : ''), employer.phone].filter((l): l is string => !!l && l.trim() !== '')
    : [];
  return {
    brand,
    remitTo: employer ? { name: employer.legalName, lines: remitLines } : null,
    financeEmail: org?.financeMailbox ?? org?.supportEmail ?? null,
    poNumber: row?.poNumber ?? client?.poNumber ?? null,
    termsDays: client?.paymentTermsDays ?? null,
    dueDate: row?.dueAt ?? null,
    paidAt: row?.paidAt ?? null,
    paymentRef: row?.paymentRef ?? null,
    aging,
    period: row ? { start: row.periodStart.toISOString().slice(0, 10), end: row.periodEnd.toISOString().slice(0, 10) } : null,
  };
}

/**
 * Older and seeded snapshots can lack fields (the SLA block, the split
 * totals); the invoice — and every screen — reads a complete one.
 */
export function completeStatementSnapshot(snap: StatementSnapshot, fallbackName: string, period?: { start: string; end: string } | null): StatementSnapshot {
  const s = (snap ?? {}) as Partial<StatementSnapshot>;
  const t = (s.totals ?? {}) as Partial<StatementSnapshot['totals']>;
  return {
    ...s,
    clientName: s.clientName ?? fallbackName,
    periodStart: s.periodStart ?? period?.start ?? '',
    periodEnd: s.periodEnd ?? period?.end ?? '',
    lines: s.lines ?? [],
    stores: s.stores ?? [],
    totals: { hours: t.hours ?? 0, regularHours: t.regularHours ?? t.hours ?? 0, otHours: t.otHours ?? 0, amount: t.amount ?? 0, hoursAmount: t.hoursAmount, adjustmentsAmount: t.adjustmentsAmount },
    sla: s.sla ?? { publishedShifts: 0, assignedShifts: 0, fillRatePct: null, punctualPct: null, noShows: 0, pendingEntries: 0 },
  };
}

export async function renderStatementPdf(raw: StatementPdfInput): Promise<Buffer> {
  const input: StatementPdfInput = { ...raw, snapshot: completeStatementSnapshot(raw.snapshot, raw.billTo?.legalName ?? 'Client', raw.period) };
  const s = input.snapshot;
  const orgName = input.orgName ?? input.brand?.name ?? 'Alto People';
  const brand: Brand = { ...(input.brand ?? { name: orgName }), name: orgName, lines: input.remitTo?.lines.length ? input.remitTo.lines : input.brand?.lines };
  const final = input.status === 'FINAL';
  const label = invoiceLabel(input.status, input.number);
  const paid = !!input.paidAt;
  const hoursAmount = s.totals.hoursAmount ?? s.totals.amount - (s.totals.adjustmentsAmount ?? 0);
  const adjustmentsAmount = s.totals.adjustmentsAmount ?? (s.adjustments ?? []).reduce((a, x) => a + x.amount, 0);
  const total = s.totals.amount;
  const amountDue = paid ? 0 : total;
  const { k } = createDoc({ title: `${label} — ${s.clientName} — ${s.periodStart} to ${s.periodEnd}`, author: orgName, subject: `Workforce services, ${s.periodStart} to ${s.periodEnd}` });
  const L = k.L;
  const Wd = k.width();

  let y = k.masthead({
    title: final ? 'Invoice' : 'Draft statement',
    subtitle: final ? label : 'Figures recompute until finalized',
    brand,
    meta: [
      { label: final ? 'Invoice no.' : 'Status', value: final && input.number !== null ? String(input.number).padStart(4, '0') : 'Draft' },
      { label: 'Invoice date', value: input.finalizedAt ? fmt.date(input.finalizedAt) : '—' },
      { label: 'Due date', value: paid ? 'Paid' : input.dueDate ? fmt.date(input.dueDate) : input.termsDays ? `Net ${input.termsDays}` : 'On receipt' },
      { label: paid ? 'Paid' : final ? 'Amount due' : 'Estimated total', value: paid ? fmt.money(total) : fmt.money(amountDue) },
    ],
  });

  // ---- Bill to / account ----------------------------------------------------
  {
    const half = (Wd - 24) / 2;
    const b = input.billTo;
    const lines = [b?.addressLine1, b?.addressLine2, [b?.city, b?.state].filter(Boolean).join(', ') + (b?.zip ? ` ${b.zip}` : '')].filter((l): l is string => !!l && l.trim() !== '');
    k.text('Bill to', L, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
    k.text(b?.legalName || s.clientName, L, y + 11, { size: SIZE.lead, weight: 'semibold', width: half });
    lines.forEach((l, i) => k.text(l, L, y + 27 + i * 12, { size: SIZE.small, color: COLOR.ink2, width: half }));
    const right = L + half + 24;
    k.facts(
      [
        { label: 'Service period', value: periodLabel(s.periodStart, s.periodEnd) },
        { label: 'Purchase order', value: input.poNumber || '—' },
        { label: 'Terms', value: input.termsDays ? `Net ${input.termsDays} days` : 'Due on receipt' },
        { label: 'Account', value: s.clientName },
      ],
      y,
      { x: right, w: half, cols: 2 },
    );
    y += Math.max(30 + lines.length * 12, 56) + 12;
  }

  if (!final) {
    y = k.callout({ tone: 'warn', title: 'Draft', body: 'Figures recompute as time approvals land and may change until this statement is finalized. Do not pay from a draft.' }, y);
    k.watermark('DRAFT', COLOR.warn, 0.06);
  } else if (paid) {
    y = k.callout({ tone: 'good', title: `Paid ${fmt.date(input.paidAt!)}`, body: `Thank you. Payment received${input.paymentRef ? ` (reference ${input.paymentRef})` : ''}. No balance is due on this invoice.` }, y);
  }

  // ---- Billed services ------------------------------------------------------
  y = k.section('Billed services', y, `${fmt.hours(s.totals.hours)} h · ${fmt.hours(s.totals.regularHours)} regular, ${fmt.hours(s.totals.otHours)} overtime`);
  y = k.table({
    y,
    rows: s.lines,
    empty: s.adjustmentsOnly ? 'This statement bills adjustments only; the hours for its period were billed earlier.' : 'No billable hours in this period.',
    columns: [
      { key: 'label', header: 'Service', width: 5, value: (l) => l.label },
      { key: 'hours', header: 'Hours', width: 1.1, align: 'right', value: (l) => fmt.hours(l.hours) },
      { key: 'rate', header: 'Rate', width: 1.2, align: 'right', value: (l) => fmt.money(l.rate) },
      { key: 'amount', header: 'Amount', width: 1.5, align: 'right', value: (l) => fmt.money(l.amount), strong: true },
    ],
    totals: { label: 'Services subtotal', hours: fmt.hours(s.totals.hours), amount: fmt.money(hoursAmount) },
  });

  if ((s.adjustments ?? []).length > 0) {
    y = k.section('Adjustments', y, 'retro pay rebilled and premiums billed by contract');
    y = k.table({
      y,
      rows: s.adjustments!,
      columns: [
        { key: 'label', header: 'Adjustment', width: 4, value: (a) => a.label },
        { key: 'basis', header: 'Basis', width: 2.6, value: (a) => a.basis ?? '—' },
        { key: 'hours', header: 'Hours', width: 1, align: 'right', value: (a) => (a.hours ? fmt.hours(a.hours) : '—') },
        { key: 'amount', header: 'Amount', width: 1.5, align: 'right', value: (a) => fmt.money(a.amount), strong: true },
      ],
      totals: { label: 'Adjustments subtotal', amount: fmt.money(adjustmentsAmount) },
    });
  }

  if (s.stores.length > 1) {
    y = k.section('By work site', y);
    y = k.table({
      y,
      rows: s.stores,
      columns: [
        { key: 'name', header: 'Work site', width: 5, value: (st) => st.locationName },
        { key: 'hours', header: 'Hours', width: 1.2, align: 'right', value: (st) => fmt.hours(st.hours) },
        { key: 'amount', header: 'Amount', width: 1.5, align: 'right', value: (st) => fmt.money(st.amount) },
      ],
    });
  }

  // ---- Totals --------------------------------------------------------------
  {
    const boxW = 250;
    const x = L + Wd - boxW;
    const rows: Array<[string, string, boolean?]> = [
      ['Services', fmt.money(hoursAmount)],
      ...(adjustmentsAmount ? ([['Adjustments', fmt.money(adjustmentsAmount)]] as Array<[string, string]>) : []),
      ['Subtotal', fmt.money(total)],
      ['Sales tax', fmt.money(0)],
      ['Total', fmt.money(total), true],
      ...(paid ? ([['Payments received', fmt.money(-total)]] as Array<[string, string]>) : []),
    ];
    const h = rows.length * 18 + 40;
    y = k.ensure(y, h + 10);
    let ry = y;
    rows.forEach(([lab, val, strong]) => {
      if (strong) k.hr(ry - 3, x, boxW, COLOR.ink, 0.8);
      k.text(lab, x, ry, { size: SIZE.body, weight: strong ? 'semibold' : 'regular', color: strong ? COLOR.ink : COLOR.ink2, width: boxW - 110 });
      k.text(val, x + boxW - 110, ry, { size: SIZE.body, weight: strong ? 'semibold' : 'regular', width: 110, align: 'right' });
      ry += 18;
    });
    k.box(x, ry + 2, boxW, 32, paid ? COLOR.goodWash : COLOR.band, 4);
    k.text(paid ? 'Balance due' : final ? 'Amount due' : 'Estimated total', x + 12, ry + 12, { size: SIZE.small, caps: true, weight: 'medium', color: paid ? COLOR.good : COLOR.bandSub });
    k.text(fmt.money(amountDue), x + boxW - 160, ry + 9, { size: SIZE.title + 2, weight: 'semibold', color: paid ? COLOR.good : COLOR.white, width: 148, align: 'right' });
    // Service levels sit beside the totals.
    const sla = s.sla;
    const lw = Wd - boxW - 24;
    k.text('Service levels this period', L, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
    const slaRows = [
      `Shifts published ${sla.publishedShifts} · filled ${sla.assignedShifts}${sla.fillRatePct !== null ? ` (${sla.fillRatePct}%)` : ''}`,
      sla.punctualPct !== null ? `On-time arrivals ${sla.punctualPct}% of shift-linked punches` : 'On-time arrivals: no shift-linked punches',
      `No-shows ${sla.noShows}`,
      ...(sla.pendingEntries > 0 ? [`${sla.pendingEntries} time ${sla.pendingEntries === 1 ? 'entry' : 'entries'} still in approval are not billed here`] : []),
    ];
    slaRows.forEach((r, i) => k.text(r, L, y + 14 + i * 14, { size: SIZE.small, color: i === 3 ? COLOR.warn : COLOR.ink2, width: lw }));
    y = Math.max(ry + 46, y + 14 + slaRows.length * 14 + 10);
  }

  // ---- Aging and how to pay -------------------------------------------------
  if (final && input.aging) {
    const a = input.aging;
    const open = a.current + a.d1to30 + a.d31to60 + a.d61to90 + a.over90;
    y = k.section('Account aging', y, 'open invoices on this account, by days past due');
    y = k.table({
      y,
      rows: [a],
      zebra: false,
      columns: [
        { key: 'c', header: 'Current', width: 1, align: 'right', value: (r) => fmt.money(r.current) },
        { key: 'a', header: '1–30 days', width: 1, align: 'right', value: (r) => fmt.money(r.d1to30), color: (r) => (r.d1to30 > 0 ? COLOR.warn : undefined) },
        { key: 'b', header: '31–60 days', width: 1, align: 'right', value: (r) => fmt.money(r.d31to60), color: (r) => (r.d31to60 > 0 ? COLOR.warn : undefined) },
        { key: 'd', header: '61–90 days', width: 1, align: 'right', value: (r) => fmt.money(r.d61to90), color: (r) => (r.d61to90 > 0 ? COLOR.bad : undefined) },
        { key: 'e', header: 'Over 90', width: 1, align: 'right', value: (r) => fmt.money(r.over90), color: (r) => (r.over90 > 0 ? COLOR.bad : undefined) },
        { key: 't', header: 'Open balance', width: 1.2, align: 'right', value: () => fmt.money(open), strong: true },
      ],
    });
  }

  if (final && !paid) {
    const payTo = input.remitTo?.name ?? orgName;
    y = k.callout(
      {
        tone: 'info',
        title: 'How to pay',
        body: `Pay by ACH or check payable to ${payTo.replace(/\.$/, '')}. Put ${label} on the payment so it applies to this invoice.${input.financeEmail ? ` Questions about this invoice: ${input.financeEmail}.` : ''} Hours are approved time net of unpaid breaks; overtime is the part of a person's week beyond 40 hours across all assignments${s.overtimeBilling === 'STRAIGHT' ? ', billed at straight time per the contract' : ', billed at 1.5× per the contract'}.`,
      },
      y,
    );
  } else {
    y = k.callout({ body: `Hours are approved time net of unpaid breaks. Overtime is the part of a person's week beyond 40 hours across all assignments${s.overtimeBilling === 'STRAIGHT' ? ', billed at straight time per the contract' : ', billed at 1.5× per the contract'}.${input.finalizedByEmail && input.finalizedAt ? ` Finalized ${fmt.date(input.finalizedAt)} by ${input.finalizedByEmail}.` : ''}` }, y);
  }

  // ---- Remittance stub ------------------------------------------------------
  if (final && !paid) {
    const stub = remittanceStub(input);
    const stubH = 118;
    const doc = k.doc;
    if (y + stubH + 20 > k.bottom()) {
      doc.addPage();
      y = k.top;
    } else {
      y = k.bottom() - stubH;
    }
    doc.save().lineWidth(0.8).strokeColor(COLOR.ruleStrong).dash(4, { space: 3 }).moveTo(L, y).lineTo(L + Wd, y).stroke().undash().restore();
    k.text('Detach and return this stub with your payment', L, y + 5, { size: SIZE.micro, caps: true, color: COLOR.ink3, width: Wd, align: 'center' });
    const sy = y + 22;
    k.text('Remittance', L, sy, { size: SIZE.title, weight: 'semibold' });
    k.text('Remit to', L, sy + 22, { size: SIZE.label, caps: true, color: COLOR.ink3 });
    k.text(stub.payTo, L, sy + 33, { size: SIZE.body, weight: 'semibold', width: Wd * 0.45 });
    (input.remitTo?.lines ?? []).slice(0, 3).forEach((l, i) => k.text(l, L, sy + 46 + i * 11, { size: SIZE.small, color: COLOR.ink2, width: Wd * 0.45 }));
    const gx = L + Wd * 0.5;
    const cell = (lab: string, val: string, cx: number, cy: number, w: number, strong = false) => {
      k.text(lab, cx, cy, { size: SIZE.label, caps: true, color: COLOR.ink3, width: w });
      k.text(val, cx, cy + 11, { size: strong ? SIZE.lead : SIZE.body, weight: strong ? 'semibold' : 'regular', width: w });
    };
    const cw = (Wd * 0.5) / 2;
    cell('Customer', stub.customer, gx, sy - 2, Wd * 0.5);
    cell('Invoice', stub.invoice, gx, sy + 28, cw - 8);
    cell('Due date', stub.dueDate, gx + cw, sy + 28, cw);
    cell('Amount due', stub.amountDue, gx, sy + 58, cw - 8, true);
    k.text('Amount enclosed', gx + cw, sy + 58, { size: SIZE.label, caps: true, color: COLOR.ink3 });
    k.outline(gx + cw, sy + 69, cw, 22, COLOR.ruleStrong, 3);
    k.text('$', gx + cw + 8, sy + 75, { size: SIZE.body, color: COLOR.ink3 });
  }

  return k.finish({ reference: `${label} · ${s.clientName} · ${periodLabel(s.periodStart, s.periodEnd)}`, note: orgName, confidential: false });
}
