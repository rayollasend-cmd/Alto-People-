import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { lastCompleteWeeks } from '../../lib/execPeriods.js';
import { buildBoardPack } from '../../lib/executiveBoardPack.js';
import { computeExecutiveSummary } from '../../lib/executiveSummary.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { pdfText } from '../../../test/pdfText.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The board pack v2 (lib/executiveBoardPack): a designed document for a
 * period and a comparison — cover, scorecard, financials, clients,
 * workforce, risk register, appendix — with none of the old pack's
 * defects: no "?" where a glyph was missing, no ISO dates, no "UTC", no
 * "1 separations", no cents.
 */

const H = 3_600_000;
const DAY = 24 * H;
const app = createApp();

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

/** Bytes from a supertest binary response. */
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/** A small world: one client, two people working the last two weeks, one of them separated. */
async function seed(now: Date) {
  const client = await createClient('Coastal Resort');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const [prior, last] = lastCompleteWeeks(now, 2) as [Date, Date];
  for (const name of ['Ana', 'Ben']) {
    const a = await createAssociate({ firstName: name, lastName: 'Worker', email: `${name.toLowerCase()}@pack.example` });
    await prisma.associate.update({ where: { id: a.id }, data: { hireDate: new Date('2026-01-05') } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-01-05') } });
    for (const week of [prior, last]) {
      for (const i of [2, 3, 4, 5, 6]) {
        const at = new Date(week.getTime() + i * DAY + 13 * H);
        await prisma.timeEntry.create({ data: { associateId: a.id, clientId: client.id, locationId: site.id, clockInAt: at, clockOutAt: new Date(at.getTime() + 8.5 * H), status: 'APPROVED' } });
      }
    }
  }
  const gone = await createAssociate({ firstName: 'Cal', lastName: 'Left', email: 'cal@pack.example' });
  await prisma.associate.update({ where: { id: gone.id }, data: { hireDate: new Date('2026-01-05'), separatedAt: new Date(last.getTime() + 2 * DAY) } });
  return { client };
}

function assertClean(text: string) {
  expect(text).toContain('Scorecard');
  expect(text).toContain('Risk register');
  expect(text).toContain('Board pack');
  // No ISO dates, no "UTC", no missing-glyph question marks between figures.
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(text).not.toMatch(/\bUTC\b/);
  expect(text).not.toMatch(/\$[\d.,]+[kM]?\s*\?\s*\$?[\d]/);
  expect(text).not.toMatch(/\?/);
  // Plurals agree with their counts; no cents on money (an hourly rate keeps its cents).
  expect(text).not.toMatch(/\b1 (separations|days|hires|events|shifts|points)\b/);
  expect(text.match(/.{0,30}\$\d{1,3}(,\d{3})*\.\d{2}\b(?! an hour).{0,20}/)?.[0]).toBeUndefined();
  // No debug words from the old pack.
  expect(text).not.toMatch(/compliance system/i);
}

describe('GET /executive/board-pack.pdf', () => {
  it('is a designed pack of at least six pages for the frame asked for, with no ISO dates or missing glyphs', async () => {
    const now = pinMidweekNoon();
    await seed(now);
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const exec = await loginAs(user.email);

    const res = await exec.get('/executive/board-pack.pdf?period=week&compare=prior').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/board-pack-week-/);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(6);
    const text = pdfText(pdf);
    assertClean(text);
    for (const heading of ['Contents', 'How the company is doing', 'Revenue, margin and cash', 'Where the money went', 'Client portfolio', 'People', 'Risks the board should know', 'Trends, definitions and basis']) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/Page \d+ of \d+/);
    expect(text).toContain('Confidential');
    expect(text).toContain('Eastern time');

    // The default frame (the quarter against the prior quarter) builds too.
    const q = await exec.get('/executive/board-pack.pdf').buffer(true).parse(binary);
    expect(q.status).toBe(200);
    assertClean(pdfText(q.body as Buffer));
  });

  it('draws an empty company without failing, and the Saturday digest’s weekly summary still builds the pack', async () => {
    const now = pinMidweekNoon();
    const empty = await buildBoardPack({ tenantId: ALTO_TENANT_ID, now, period: 'year', compare: 'plan' }, 'REF-EMPTY');
    expect(pageCount(empty)).toBeGreaterThanOrEqual(6);
    const text = pdfText(empty);
    assertClean(text);
    expect(text).toContain('No plan is set for');

    await seed(now);
    const summary = await computeExecutiveSummary(prisma, now, { tenantId: ALTO_TENANT_ID });
    const weekly = await buildBoardPack(summary, 'REF-DIGEST');
    expect(pageCount(weekly)).toBeGreaterThanOrEqual(6);
    const wt = pdfText(weekly);
    assertClean(wt);
    expect(wt).toMatch(/Week of [A-Z][a-z]{2} \d{1,2}/);
  });
});
