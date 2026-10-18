import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildNachaFile,
  interpretNoc,
  isValidRouting,
  NachaError,
  parseReturnFile,
  transactionCode,
  validateNachaFile,
  type NachaBatch,
  type NachaFileHeader,
} from '../../lib/banking/nacha.js';
import {
  achTimeline,
  addBankingDays,
  adjustPayDate,
  easternInstant,
  federalReserveHolidays,
  isBankingDay,
  setHolidayOverrides,
} from '../../lib/banking/holidays.js';
import { splitNet } from '../../lib/banking/directDeposit.js';
import { increaseProvider, inHouseProvider, modernTreasuryProvider, originationProviderFor } from '../../lib/banking/origination.js';
import type { ProviderContext } from '../../lib/providers/connections.js';

const sp = (n: number) => ' '.repeat(n);

const HEADER: NachaFileHeader = {
  immediateDestination: '091000019',
  immediateDestinationName: 'Wells Fargo',
  immediateOrigin: '1234567890',
  immediateOriginName: 'Alto HR',
  fileIdModifier: 'A',
  createdAt: new Date('2026-10-15T14:30:00Z'),
};

const PAYROLL: NachaBatch = {
  sec: 'PPD',
  companyName: 'Alto HR',
  companyId: '1234567890',
  entryDescription: 'PAYROLL',
  effectiveDate: '2026-10-16',
  originatingDfi: '091000019',
  entries: [
    { transactionCode: '22', routingNumber: '011000015', accountNumber: '123456789', amountCents: 125050, individualId: 'EMP001', individualName: 'Jane Doe' },
    { transactionCode: '32', routingNumber: '091000019', accountNumber: '987654321', amountCents: 50000, individualId: 'EMP002', individualName: 'José Núñez' },
  ],
};

describe('NACHA: a known-good PPD credit file, record by record', () => {
  const built = buildNachaFile(HEADER, [PAYROLL]);
  const expected = [
    '1' + '01' + ' 091000019' + '1234567890' + '261015' + '1430' + 'A' + '094' + '10' + '1' + 'WELLS FARGO' + sp(12) + 'ALTO HR' + sp(16) + sp(8),
    '5' + '220' + 'ALTO HR' + sp(9) + sp(20) + '1234567890' + 'PPD' + 'PAYROLL' + sp(3) + sp(6) + '261016' + sp(3) + '1' + '09100001' + '0000001',
    '6' + '22' + '01100001' + '5' + '123456789' + sp(8) + '0000125050' + 'EMP001' + sp(9) + 'JANE DOE' + sp(14) + sp(2) + '0' + '091000010000001',
    '6' + '32' + '09100001' + '9' + '987654321' + sp(8) + '0000050000' + 'EMP002' + sp(9) + 'JOSE NUNEZ' + sp(12) + sp(2) + '0' + '091000010000002',
    '8' + '220' + '000002' + '0010200002' + '000000000000' + '000000175050' + '1234567890' + sp(19) + sp(6) + '09100001' + '0000001',
    '9' + '000001' + '000001' + '00000002' + '0010200002' + '000000000000' + '000000175050' + sp(39),
    '9'.repeat(94),
    '9'.repeat(94),
    '9'.repeat(94),
    '9'.repeat(94),
  ];

  it('writes every record exactly', () => {
    expect(built.lines).toEqual(expected);
  });
  it('every record is 94 characters and the file is whole blocks of 10', () => {
    for (const l of built.lines) expect(l).toHaveLength(94);
    expect(built.lines.length % 10).toBe(0);
    expect(built.content.endsWith('\n')).toBe(true);
  });
  it('totals, entry hash and trace numbers', () => {
    expect(built.totals).toMatchObject({ creditCents: 175050, debitCents: 0, entryCount: 2, batchCount: 1, blockCount: 1, entryHash: '0010200002' });
    expect(built.entries.map((e) => e.traceNumber)).toEqual(['091000010000001', '091000010000002']);
  });
  it('validates clean, and catches a tampered total', () => {
    expect(validateNachaFile(built.content)).toEqual({ ok: true });
    const bad = built.content.replace('000000175050' + sp(39), '000000175051' + sp(39));
    const r = validateNachaFile(bad);
    expect(r.ok).toBe(false);
  });
  it('continues trace numbers from where the tenant left off', () => {
    const next = buildNachaFile(HEADER, [PAYROLL], { firstTraceSequence: 41 });
    expect(next.entries.map((e) => e.traceNumber)).toEqual(['091000010000041', '091000010000042']);
  });
});

describe('NACHA: CCD funding debit, prenotes, same-day, addenda', () => {
  it('a CCD debit batch is service class 225 with the debit in the debit total', () => {
    const f = buildNachaFile(HEADER, [
      { ...PAYROLL, sec: 'CCD', entryDescription: 'PAYROLL', entries: [{ transactionCode: '27', routingNumber: '011000015', accountNumber: '55501', amountCents: 4821055, individualId: 'RUN1', individualName: 'Alto HR' }] },
    ]);
    expect(f.lines[1]!.slice(0, 4)).toBe('5225');
    expect(f.lines[1]!.slice(50, 53)).toBe('CCD');
    expect(f.lines[3]!.slice(20, 32)).toBe('000004821055'); // batch control debit total
    expect(f.totals.debitCents).toBe(4821055);
  });
  it('credits and debits together are service class 200', () => {
    const f = buildNachaFile(HEADER, [{ ...PAYROLL, entries: [...PAYROLL.entries, { transactionCode: '27', routingNumber: '011000015', accountNumber: '1', amountCents: 100, individualId: 'X', individualName: 'X' }] }]);
    expect(f.lines[1]!.slice(1, 4)).toBe('200');
  });
  it('prenote codes are 23/33 (credit) and 28/38 (debit), and carry no money', () => {
    expect(transactionCode('CHECKING', 'credit', true)).toBe('23');
    expect(transactionCode('SAVINGS', 'credit', true)).toBe('33');
    expect(transactionCode('CHECKING', 'debit', true)).toBe('28');
    expect(transactionCode('SAVINGS', 'debit')).toBe('37');
    expect(() => buildNachaFile(HEADER, [{ ...PAYROLL, entries: [{ ...PAYROLL.entries[0]!, transactionCode: '23' }] }])).toThrow(NachaError);
    const ok = buildNachaFile(HEADER, [{ ...PAYROLL, entries: [{ ...PAYROLL.entries[0]!, transactionCode: '23', amountCents: 0 }] }]);
    expect(ok.lines[2]!.slice(29, 39)).toBe('0000000000');
  });
  it('same-day puts SD + the window in the descriptive date and caps entries at $1,000,000', () => {
    const f = buildNachaFile(HEADER, [{ ...PAYROLL, sameDayWindow: '1300' }]);
    expect(f.lines[1]!.slice(63, 69)).toBe('SD1300');
    expect(() => buildNachaFile(HEADER, [{ ...PAYROLL, sameDayWindow: '1300', entries: [{ ...PAYROLL.entries[0]!, amountCents: 100_000_001 }] }])).toThrow(/1,000,000/);
  });
  it('an addenda record follows its entry and counts in the batch', () => {
    const f = buildNachaFile(HEADER, [{ ...PAYROLL, entries: [{ ...PAYROLL.entries[0]!, addenda: 'Pay period Oct 3 - Oct 16' }] }]);
    expect(f.lines[2]![78]).toBe('1');
    expect(f.lines[3]!.slice(0, 3)).toBe('705');
    expect(f.lines[3]!.slice(83, 87)).toBe('0001');
    expect(f.lines[3]!.slice(87)).toBe('0000001');
    expect(f.lines[4]!.slice(4, 10)).toBe('000002'); // entry + addenda
    expect(validateNachaFile(f.content)).toEqual({ ok: true });
  });
  it('refuses a routing number that fails its check digit', () => {
    expect(isValidRouting('011000015')).toBe(true);
    expect(isValidRouting('011000016')).toBe(false);
    expect(() => buildNachaFile(HEADER, [{ ...PAYROLL, entries: [{ ...PAYROLL.entries[0]!, routingNumber: '011000016' }] }])).toThrow(/check digit/);
  });
  it('fills a second block when there are more than ten records', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...PAYROLL.entries[0]!, individualId: `E${i}` }));
    const f = buildNachaFile(HEADER, [{ ...PAYROLL, entries: many }]);
    expect(f.lines).toHaveLength(20);
    expect(f.totals.blockCount).toBe(2);
    expect(validateNachaFile(f.content)).toEqual({ ok: true });
  });
});

describe('NACHA: reading returns and notifications of change', () => {
  const entry = (tc: string, trace: string) => '6' + tc + '01100001' + '5' + '123456789'.padEnd(17) + '0000125050' + 'EMP001'.padEnd(15) + 'JANE DOE'.padEnd(22) + '  ' + '1' + trace;
  const ret = '7' + '99' + 'R01' + '091000010000001' + sp(6) + '09100001' + sp(44) + '011000010000009';
  const noc = '7' + '98' + 'C01' + '091000010000002' + sp(6) + '09100001' + '000111222333'.padEnd(29) + sp(15) + '011000010000010';
  it('parses an R01 and a C01', () => {
    expect(ret).toHaveLength(94);
    expect(noc).toHaveLength(94);
    const out = parseReturnFile([entry('21', '011000010000009'), ret, entry('21', '011000010000010'), noc].join('\n'));
    expect(out).toEqual([
      { kind: 'RETURN', code: 'R01', originalTrace: '091000010000001', amountCents: 125050, transactionCode: '21', individualId: 'EMP001' },
      { kind: 'NOC', code: 'C01', originalTrace: '091000010000002', correctedData: '000111222333', transactionCode: '21', individualId: 'EMP001' },
    ]);
  });
  it('interprets the change codes', () => {
    expect(interpretNoc('C01', '000111222333')).toEqual({ accountNumber: '000111222333' });
    expect(interpretNoc('C02', '011000015')).toEqual({ routingNumber: '011000015' });
    expect(interpretNoc('C03', '011000015   000111222333')).toEqual({ routingNumber: '011000015', accountNumber: '000111222333' });
    expect(interpretNoc('C05', '32')).toEqual({ accountType: 'SAVINGS' });
    expect(interpretNoc('C06', '000111222333'.padEnd(20) + '32')).toEqual({ accountNumber: '000111222333', accountType: 'SAVINGS' });
    expect(interpretNoc('C07', '011000015' + '000111222333'.padEnd(17) + '22')).toEqual({ routingNumber: '011000015', accountNumber: '000111222333', accountType: 'CHECKING' });
    expect(interpretNoc('C09', 'x')).toBeNull();
  });
});

describe('banking days: the Federal Reserve calendar', () => {
  afterEach(() => setHolidayOverrides([]));

  it('2026 has ten observed holidays (July 4 is a Saturday, so none that week)', () => {
    const h = federalReserveHolidays(2026);
    expect(h.map((x) => x.date)).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    ]);
    expect(isBankingDay('2026-07-03')).toBe(true);
  });
  it('a Sunday holiday is observed Monday', () => {
    expect(federalReserveHolidays(2022).find((x) => x.name === 'Christmas Day')?.date).toBe('2022-12-26');
    expect(federalReserveHolidays(2023).find((x) => x.name === 'New Year’s Day')?.date).toBe('2023-01-02');
  });
  it('Christmas 2026 (a Friday) pays Thursday Dec 24', () => {
    expect(adjustPayDate('2026-12-25')).toEqual({ payDate: '2026-12-24', shifted: true, reason: 'Christmas Day' });
  });
  it('a Saturday pay date pays Friday; a Monday holiday pay date pays the Friday before', () => {
    expect(adjustPayDate('2026-07-04')).toEqual({ payDate: '2026-07-03', shifted: true, reason: 'Saturday' });
    expect(adjustPayDate('2026-09-07')).toEqual({ payDate: '2026-09-04', shifted: true, reason: 'Labor Day' });
    expect(adjustPayDate('2026-10-16')).toEqual({ payDate: '2026-10-16', shifted: false, reason: null });
  });
  it('counts banking days across a holiday weekend', () => {
    expect(addBankingDays('2026-10-13', -1)).toBe('2026-10-09'); // Columbus Day Mon Oct 12
    expect(addBankingDays('2026-12-23', 2)).toBe('2026-12-28');
  });
  it('a tenant override closes (or opens) a day', () => {
    setHolidayOverrides([{ date: '2026-10-14', name: 'Bank closed', closed: true }]);
    expect(isBankingDay('2026-10-14')).toBe(false);
    expect(adjustPayDate('2026-10-14').payDate).toBe('2026-10-13');
    setHolidayOverrides([{ date: '2026-11-11', name: 'Our bank is open', closed: false }]);
    expect(isBankingDay('2026-11-11')).toBe(true);
  });
});

describe('ACH timeline: when money has to move for a pay date', () => {
  it('next-day: credits sent Thursday for Friday; the debit settles Wednesday and is due Tuesday 4 pm ET', () => {
    const t = achTimeline('2026-10-16', 'NEXT_DAY', '16:00');
    expect(t).toMatchObject({ creditSubmitDate: '2026-10-15', debitEffectiveDate: '2026-10-14', debitSubmitDate: '2026-10-13' });
    expect(t.fundingDeadline.toISOString()).toBe('2026-10-13T20:00:00.000Z'); // EDT
  });
  it('steps over Columbus Day', () => {
    const t = achTimeline('2026-10-14', 'NEXT_DAY');
    expect(t).toMatchObject({ creditSubmitDate: '2026-10-13', debitEffectiveDate: '2026-10-09', debitSubmitDate: '2026-10-08' });
  });
  it('same-day and two-day', () => {
    expect(achTimeline('2026-10-16', 'SAME_DAY')).toMatchObject({ creditSubmitDate: '2026-10-16', debitEffectiveDate: '2026-10-15', debitSubmitDate: '2026-10-14' });
    expect(achTimeline('2026-10-16', 'TWO_DAY')).toMatchObject({ creditSubmitDate: '2026-10-14', debitEffectiveDate: '2026-10-13', debitSubmitDate: '2026-10-09' });
  });
  it('Eastern time follows daylight saving', () => {
    expect(easternInstant('2026-12-15', '16:00').toISOString()).toBe('2026-12-15T21:00:00.000Z');
    expect(easternInstant('2026-03-09', '10:30').toISOString()).toBe('2026-03-09T14:30:00.000Z');
  });
});

describe('split deposits', () => {
  it('fixed amounts, then percents of net, then the remainder', () => {
    expect(
      splitNet(100_000, [
        { id: 'pct', splitKind: 'PERCENT', splitAmountCents: null, splitPercent: 10, splitOrder: 2 },
        { id: 'amt', splitKind: 'AMOUNT', splitAmountCents: 20_000, splitPercent: null, splitOrder: 1 },
      ], 'main'),
    ).toEqual([{ id: 'amt', cents: 20_000 }, { id: 'pct', cents: 10_000 }, { id: 'main', cents: 70_000 }]);
  });
  it('never sends more than the net; a short check fills splits in order', () => {
    expect(splitNet(15_000, [{ id: 'a', splitKind: 'AMOUNT', splitAmountCents: 20_000, splitPercent: null, splitOrder: 0 }], 'main')).toEqual([{ id: 'a', cents: 15_000 }]);
  });
  it('percent rounds down to the cent; the remainder takes the odd cent', () => {
    expect(splitNet(10_001, [{ id: 'p', splitKind: 'PERCENT', splitAmountCents: null, splitPercent: 33.33, splitOrder: 0 }], 'm')).toEqual([{ id: 'p', cents: 3333 }, { id: 'm', cents: 6668 }]);
  });
});

describe('bank partner adapters (mocked HTTP)', () => {
  const ctx = (provider: string, extra: Partial<ProviderContext> = {}): ProviderContext =>
    ({
      connectionId: 'c1',
      tenantId: 't1',
      provider,
      environment: 'SANDBOX',
      baseUrl: provider === 'INCREASE' ? 'https://sandbox.increase.com' : 'https://app.moderntreasury.com',
      credentials: { apiKey: 'k', organizationId: 'org' },
      settings: { originatingAccountId: 'ia_1', accountId: 'acct_1' },
      webhookSecret: 'whsec',
      ...extra,
    }) as unknown as ProviderContext;
  const entry = { id: 'e1', direction: 'debit' as const, sec: 'CCD' as const, prenote: false, amountCents: 4821055, routingNumber: '011000015', accountNumber: '555', accountType: 'CHECKING' as const, name: 'Alto HR', descriptor: 'PAYROLL', effectiveDate: '2026-10-14', sameDay: false };
  afterEach(() => vi.unstubAllGlobals());

  it('no connection means the in-house file', () => {
    expect(originationProviderFor(null)).toBe(inHouseProvider);
  });
  it('Modern Treasury: a payment order with Basic auth and an idempotency key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'po_1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await modernTreasuryProvider(ctx('MODERN_TREASURY')).originate([entry]);
    expect(out).toEqual([{ entryId: 'e1', externalRef: 'po_1', accepted: true, error: null }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://app.moderntreasury.com/api/payment_orders');
    expect(init.headers.authorization).toBe('Basic ' + Buffer.from('org:k').toString('base64'));
    expect(init.headers['idempotency-key']).toBe('e1');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 'ach', direction: 'debit', amount: 4821055, subtype: 'CCD', priority: 'normal', originating_account_id: 'ia_1' });
  });
  it('Modern Treasury: a refused order is reported per entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: { message: 'Insufficient balance' } }), { status: 422 })));
    const [r] = await modernTreasuryProvider(ctx('MODERN_TREASURY')).originate([entry]);
    expect(r!.accepted).toBe(false);
  });
  it('Modern Treasury webhooks: signature checked, returns read', () => {
    const body = Buffer.from(JSON.stringify({ event: 'returned', data: { id: 'po_1', returns: [{ code: 'r01' }] } }));
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    const p = modernTreasuryProvider(ctx('MODERN_TREASURY'));
    expect(p.parseWebhook(body, { 'x-signature': sig, 'x-webhook-id': 'wh1' })).toEqual([{ kind: 'RETURNED', eventId: 'wh1', externalRef: 'po_1', code: 'R01' }]);
    expect(() => p.parseWebhook(body, { 'x-signature': 'bad' })).toThrow(/Signature/);
  });
  it('Increase: a negative amount pulls money in', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'ach_transfer_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await increaseProvider(ctx('INCREASE')).originate([entry]);
    expect(out[0]).toMatchObject({ accepted: true, externalRef: 'ach_transfer_1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://sandbox.increase.com/ach_transfers');
    expect(init.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(String(init.body))).toMatchObject({ account_id: 'acct_1', amount: -4821055, standard_entry_class_code: 'corporate_credit_or_debit' });
  });
  it('Increase webhooks: t=,v1= signature; a return and a NOC', () => {
    const body = JSON.stringify({ id: 'evt_1', associated_object_id: 'ach_transfer_1', associated_object: { status: 'returned', return: { return_reason_code: 'R02' }, notifications_of_change: [{ change_code: 'C01', corrected_data: '999' }] } });
    const t = '1760000000';
    const v1 = createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex');
    const events = increaseProvider(ctx('INCREASE')).parseWebhook(Buffer.from(body), { 'increase-webhook-signature': `t=${t},v1=${v1}` });
    expect(events).toEqual([
      { kind: 'RETURNED', eventId: 'evt_1', externalRef: 'ach_transfer_1', code: 'R02' },
      { kind: 'NOC', eventId: 'evt_1:noc:0', externalRef: 'ach_transfer_1', code: 'C01', correctedData: '999' },
    ]);
  });
});
