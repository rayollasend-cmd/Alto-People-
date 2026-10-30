import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { billForMargin, marketPosition, oewsSeriesId, parseOewsCsv, percentileOf, recommend, setBlsFetchForTests } from '../../lib/marketWages.js';
import { suggestArea, suggestSoc } from '../../lib/marketCatalog.js';

/**
 * The market rates desk: BLS wage data by metro and occupation (the BLS
 * API mocked), each store-role priced against it with its fill record, a
 * recommendation and the bill rate that keeps the margin — inside the
 * caller's reach, money only for those who may see it.
 */

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => setBlsFetchForTests(null));

afterAll(async () => {
  await prisma.$disconnect();
});

/** A fake BLS answer: every requested series gets the figure for its data type. */
function fakeBls(figures: Record<string, number>, calls: string[][] = []) {
  setBlsFetchForTests(async (_url, init) => {
    const body = JSON.parse(init.body) as { seriesid: string[] };
    calls.push(body.seriesid);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'REQUEST_SUCCEEDED',
        Results: { series: body.seriesid.map((id) => ({ seriesID: id, data: [{ year: '2025', period: 'A01', value: String(figures[id.slice(-2)] ?? '-') }] })) },
      }),
    };
  });
}

const FIGURES = { '03': 16.8, '06': 12.5, '07': 14, '08': 16, '09': 18.5, '10': 21, '01': 4120 };

async function world() {
  const client = await createClient('Coastal Resorts');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: store.id }, data: { name: 'Front Beach', zip: '32541', city: 'Destin', state: 'FL' } });
  // effectiveFrom explicit: CURRENT_DATE is the database's (UTC) day — tomorrow on the company's calendar after 8 PM Eastern.
  await prisma.shiftRateDefault.create({ data: { clientId: client.id, position: 'Stocker', payRate: 14.5, billRate: 21, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') } });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
  const a = await loginAs(agent(), hr.email);
  return { client, store, hr, a };
}

describe('suggestions', () => {
  it('Destin is Crestview–Fort Walton Beach–Destin, not Pensacola, though both start 325', () => {
    expect(suggestArea({ zip: '32541', city: null, state: 'FL' })?.value.code).toBe('18880');
    expect(suggestArea({ zip: '32501', city: null, state: 'FL' })?.value.code).toBe('37860');
    expect(suggestArea({ zip: null, city: 'Panama City Beach', state: 'FL' })?.value.code).toBe('37460');
  });
  it('the longest matching word wins: “Shift lead” is a supervisor, “Overnight stocker” a stocker', () => {
    expect(suggestSoc('Shift Lead')?.value.code).toBe('41-1011');
    expect(suggestSoc('Overnight stocker')?.value.code).toBe('53-7065');
    expect(suggestSoc('Astronaut')).toBeNull();
  });
});

describe('the math', () => {
  it('series ids, percentiles, the bill rate for a margin, and a never-a-pay-cut recommendation', () => {
    expect(oewsSeriesId('18880', '53-7065', 'median')).toBe('OEUM001888000000053706508');
    const m = { areaCode: '18880', areaName: 'Crestview-Fort Walton Beach-Destin, FL', socCode: '53-7065', socTitle: 'Stockers', year: 2025, p10: 12.5, p25: 14, median: 16, p75: 18.5, p90: 21, source: 'BLS_OEWS', fetchedAt: '' };
    expect(percentileOf(14, m)).toBe(25);
    expect(percentileOf(15, m)).toBe(38);
    expect(percentileOf(30, m)).toBe(90);
    // 12% burden, no overhead (the env defaults): 16 × 1.12 ÷ 0.75.
    expect(billForMargin(16, 25)).toBe(23.89);
    const bands: Parameters<typeof recommend>[0]['bands'] = new Map([
      ['below', { band: 'below' as const, shifts: 100, filled: 78, fillRate: 0.78, noShowRate: 0.05 }],
      ['at', { band: 'at' as const, shifts: 120, filled: 112, fillRate: 0.93, noShowRate: 0.02 }],
    ]);
    const low = recommend({ payRate: 14.8, billRate: 21, market: m, fill: { shifts: 50, filled: 39, noShows: 2 }, bands, targetMarginPct: 25, positionLabel: 'Stocker' })!;
    expect(low.payRate).toBe(16);
    expect(low.billRate).toBe(23.89);
    expect(low.reason).toBe('Pay $1.20 below the Crestview-Fort Walton Beach-Destin, FL median for stocker. Fill here is 78% against 93% where you pay at the median.');
    expect(low.confidence).toBe('solid');
    const high = recommend({ payRate: 18, billRate: 26, market: m, fill: { shifts: 40, filled: 39, noShows: 0 }, bands: new Map(), targetMarginPct: null, positionLabel: 'Stocker' })!;
    expect(high.payRate).toBe(18);
    expect(high.confidence).toBe('thin');
    expect(high.marginSource).toBe('current');
  });

  it('reads the published OEWS table, leaving # and * empty', () => {
    const csv = 'AREA,AREA_TITLE,OCC_CODE,OCC_TITLE,TOT_EMP,H_MEAN,H_PCT10,H_PCT25,H_MEDIAN,H_PCT75,H_PCT90\n18880,"Crestview-Fort Walton Beach-Destin, FL",53-7065,Stockers and Order Fillers,"4,120",16.80,12.50,14.00,16.00,18.50,#\n18880,X,00-0000,All,1,1,1,1,1,1,1';
    const { rows, skipped } = parseOewsCsv(csv, 2025);
    expect(skipped).toBe(1);
    expect(rows[0]).toMatchObject({ areaCode: '18880', socCode: '53-7065', median: 16, p90: null, employment: 4120 });
  });
});

describe('the desk', () => {
  it('maps a store and a role, fetches BLS once for what is used, and prices the role with a recommendation', async () => {
    const { a, store, client } = await world();
    const map = await a.get('/market-rates/mapping');
    expect(map.status).toBe(200);
    expect(map.body.sites.find((s: { id: string }) => s.id === store.id).suggestion).toMatchObject({ code: '18880' });
    expect(map.body.positions.find((p: { name: string }) => p.name === 'Stocker').suggestion).toMatchObject({ code: '53-7065' });

    expect((await a.put('/market-rates/site-area').send({ siteId: store.id, areaCode: '18880' })).status).toBe(200);
    expect((await a.put('/market-rates/position-soc').send({ position: 'Stocker', socCode: '53-7065' })).status).toBe(200);

    const calls: string[][] = [];
    fakeBls(FIGURES, calls);
    const refresh = await a.post('/market-rates/refresh').send({});
    expect(refresh.status).toBe(200);
    expect(refresh.body).toMatchObject({ pairs: 1, fetched: 1, saved: 1 });
    expect(calls.flat()).toContain('OEUM001888000000053706508');
    // Fresh data isn't fetched again within the week.
    expect((await a.post('/market-rates/refresh').send({})).body.fetched).toBe(0);

    await a.put('/market-rates/client-margin').send({ clientId: client.id, targetMarginPct: 25 });
    const res = await a.get('/market-rates');
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row).toMatchObject({ siteName: 'Front Beach', position: 'Stocker', payRate: 14.5, billRate: 21, gapToMedian: 1.5, percentile: 31 });
    expect(row.market).toMatchObject({ median: 16, p25: 14, p75: 18.5, year: 2025 });
    expect(row.recommendation).toMatchObject({ payRate: 16, billRate: 23.89, marginPct: 25, marginSource: 'target' });
    expect(res.body.summary).toMatchObject({ rows: 1, priced: 1, belowMedian: 1 });

    const data = await a.get('/market-rates/data');
    expect(data.body).toMatchObject({ pairs: 1, covered: 1, latestYear: 2025 });

    const pdf = await a.get(`/market-rates/clients/${client.id}/brief.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('imports an OEWS table, and the helper says where a person’s pay sits', async () => {
    const { a, store, client } = await world();
    await a.put('/market-rates/site-area').send({ siteId: store.id, areaCode: '18880' });
    await a.put('/market-rates/position-soc').send({ position: 'Stocker', socCode: '53-7065' });
    const csv = 'AREA,OCC_CODE,H_PCT10,H_PCT25,H_MEDIAN,H_PCT75,H_PCT90\n18880,53-7065,12.50,14.00,16.00,18.50,21.00';
    const imp = await a.post('/market-rates/import').send({ year: 2025, csv });
    expect(imp.body).toMatchObject({ rows: 1, saved: 1 });

    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: store.id, startedAt: new Date() } });
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Stocker', startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000), status: 'ASSIGNED', assignedAssociateId: ana.id } });
    const pos = await marketPosition({ associateId: ana.id });
    expect(pos).toMatchObject({ position: 'Stocker', payRate: 14.5, median: 16, ratioToMedian: 0.906, gapToMedian: 1.5 });
    expect(await marketPosition({ siteId: store.id, position: 'Cashier' })).toBeNull();
  });

  it('money stays with those who may see it, and a store-bound office account sees only its stores', async () => {
    const { store } = await world();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'sup@example.com' });
    const s = await loginAs(agent(), sup.email);
    expect((await s.get('/market-rates')).status).toBe(403);
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT', email: 'fin@example.com' });
    const f = await loginAs(agent(), fin.email);
    expect((await f.get('/market-rates')).status).toBe(200);
    // Finance may set the data, not only read it.
    expect((await f.put('/market-rates/position-soc').send({ position: 'Stocker', socCode: '53-7065' })).status).toBe(200);

    const other = await createClient('North Co');
    const otherStore = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    await prisma.shiftRateDefault.create({ data: { clientId: other.id, position: 'Stocker', payRate: 15, billRate: 22, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [store.id] } });
    const o = await loginAs(agent(), ops.email);
    const rows = (await o.get('/market-rates')).body.rows as Array<{ siteId: string }>;
    expect(rows.map((r) => r.siteId)).toEqual([store.id]);
    expect((await o.put('/market-rates/site-area').send({ siteId: otherStore.id, areaCode: '18880' })).status).toBe(404);
  });
});
