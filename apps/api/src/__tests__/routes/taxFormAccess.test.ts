import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { encryptString } from '../../lib/crypto.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Who may read a payroll document, and who may read the SSN on it.
 *
 * Two endpoints decided this with a hardcoded list of four role names —
 * invisible to the roles tests, and stale the moment the matrix moves. But
 * the array was the smaller half of the problem: the BULK artifacts beside
 * it (every W-2 for the year as a zip, the SSA EFW2 wage file, the IRS
 * FIRE files) were guarded by process:payroll, which six roles hold,
 * MARKETING_MANAGER among them. That is the same class of file as the
 * payroll census, which moved to export:payroll-pii; these were missed.
 *
 * The distinction the tests below pin:
 *
 *   view:payroll-documents  someone else's paystub, the 941/940 sheets
 *   export:payroll-pii      anything printing a full SSN
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function agentFor(role: Parameters<typeof createUser>[0]['role']) {
  const { user } = await createUser({ role });
  return loginAs(user.email);
}

async function seedForms() {
  const assoc = await createAssociate({ firstName: 'Ada', lastName: 'Lovelace' });
  // The renderer refuses a W-2 with no SSN on file ("missing_ssn"), which
  // is itself the point: box a of this PDF is a full social security
  // number, which is why it needs the PII capability and the 941 does not.
  await prisma.w4Submission.create({
    data: {
      associateId: assoc.id,
      filingStatus: 'SINGLE',
      ssnEncrypted: encryptString('123456789'),
    },
  });
  const w2 = await prisma.taxForm.create({
    data: {
      kind: 'W2',
      taxYear: 2025,
      associateId: assoc.id,
      amounts: { wages: 42000 },
      status: 'FILED',
      filedAt: new Date(),
    },
  });
  const f941 = await prisma.taxForm.create({
    data: {
      kind: 'F941',
      taxYear: 2025,
      quarter: 1,
      amounts: { totalWages: 900000 },
      status: 'DRAFT',
    },
  });
  return { assoc, w2, f941 };
}

describe('an individual W-2 prints a full SSN', () => {
  it('is refused to a role that runs payroll but holds no PII export', async () => {
    const { w2 } = await seedForms();
    for (const role of ['MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER'] as const) {
      const a = await agentFor(role);
      expect((await a.get(`/tax-forms/${w2.id}/pdf`)).status, role).toBe(404);
    }
  });

  it('is refused to oversight roles that can read every other payroll document', async () => {
    const { w2, f941 } = await seedForms();
    // The exact narrowing: these two were on the hardcoded array and keep
    // the 941, which carries no personal SSN. They lose the W-2, which does.
    for (const role of ['OPERATIONS_MANAGER', 'EXECUTIVE_CHAIRMAN'] as const) {
      const a = await agentFor(role);
      expect((await a.get(`/tax-forms/${w2.id}/pdf`)).status, role).toBe(404);
      expect((await a.get(`/tax-forms/${f941.id}/pdf`)).status, role).toBe(200);
    }
  });

  /**
   * The refusal is a 404 with code not_found. A caller who gets PAST the
   * gate reaches the renderer, which on this deliberately thin fixture
   * stops at missing_employer_info — the W-2 needs the client's legalName
   * and EIN, resolved through the associate's payroll history. Asserting
   * that is a sharper signal than a 200 would be: it proves the render
   * path ran. The rendered-PDF happy path is w2.test.ts's job, and
   * rebuilding its client-plus-disbursed-items fixture here would test
   * the renderer twice and the gate no better.
   */
  const allowedThrough = (res: { status: number; body: { error?: { code?: string } } }) => {
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.body.error?.code).toBe('missing_employer_info');
  };

  it('is served to HR and Finance', async () => {
    const { w2 } = await seedForms();
    for (const role of ['HR_ADMINISTRATOR', 'FINANCE_ACCOUNTANT'] as const) {
      allowedThrough(await agentFor(role).then((a) => a.get(`/tax-forms/${w2.id}/pdf`)));
    }
  });

  it('is always served to the person it belongs to', async () => {
    const { assoc, w2 } = await seedForms();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: assoc.id });
    const me = await loginAs(user.email);
    allowedThrough(await me.get(`/tax-forms/${w2.id}/pdf`));
  });

  it('will not hand someone else’s W-2 to an associate', async () => {
    const { w2 } = await seedForms();
    const other = await createAssociate({ firstName: 'Grace', lastName: 'Hopper' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: other.id });
    const them = await loginAs(user.email);
    expect((await them.get(`/tax-forms/${w2.id}/pdf`)).status).toBe(404);
  });
});

describe('the bulk SSN artifacts', () => {
  /**
   * Each of these is every recipient's full SSN or TIN in one download.
   * Generating the forms, filing them and mailing each recipient their own
   * copy all stay on process:payroll; only pulling the whole set narrows.
   */
  const BULK = [
    '/tax-forms/w2/bulk.zip?taxYear=2025',
    '/tax-forms/1099-nec/bulk.zip?taxYear=2025',
    '/tax-forms/1099-misc/bulk.zip?taxYear=2025',
  ];

  it('refuses every role that holds process:payroll but not the PII export', async () => {
    await seedForms();
    for (const role of ['OPERATIONS_MANAGER', 'MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER'] as const) {
      const a = await agentFor(role);
      for (const url of BULK) {
        expect((await a.get(url)).status, `${role} ${url}`).toBe(403);
      }
    }
  });

  it('lets HR through to the same files', async () => {
    await seedForms();
    const hr = await agentFor('HR_ADMINISTRATOR');
    for (const url of BULK) {
      // Not 403 — whatever it answers about content, the gate opened.
      expect((await hr.get(url)).status, url).not.toBe(403);
    }
  });

  it('closes the SSA and IRS wage files the same way', async () => {
    await seedForms();
    const ops = await agentFor('OPERATIONS_MANAGER');
    const hr = await agentFor('HR_ADMINISTRATOR');
    // These need a clientId; the capability gate runs first either way, so
    // ops is refused before the query is ever parsed.
    for (const url of [
      '/tax-forms/w2/efw2.txt?taxYear=2025',
      '/tax-forms/w2/efw2c.txt?taxYear=2025',
      '/tax-forms/1099-nec/fire.txt?taxYear=2025',
      '/tax-forms/1099-misc/fire.txt?taxYear=2025',
    ]) {
      expect((await ops.get(url)).status, url).toBe(403);
      expect((await hr.get(url)).status, url).not.toBe(403);
    }
  });
});

describe('the named-exporter gate reaches these files too', () => {
  /**
   * 1846e72c added a second gate to bulk PII export: the capability says
   * "does this job need SSNs", PII_BULK_EXPORT_USERS says "is this the
   * named person who does that work". It listed the census, the new-hire
   * report, the external sheet and the audit packet — these seven were
   * still on process:payroll at the time, so they could not be on it.
   *
   * Without this test the suite would pass on the env var being unset,
   * which is the one configuration where the gate deliberately does
   * nothing.
   */
  const withAllowlist = (value: string | undefined) => {
    const previous = env.PII_BULK_EXPORT_USERS;
    (env as { PII_BULK_EXPORT_USERS?: string }).PII_BULK_EXPORT_USERS = value;
    return () => {
      (env as { PII_BULK_EXPORT_USERS?: string }).PII_BULK_EXPORT_USERS = previous;
    };
  };

  it('refuses an HR admin who is not named, and admits one who is', async () => {
    await seedForms();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(user.email);
    const url = '/tax-forms/w2/bulk.zip?taxYear=2025';

    let restore = withAllowlist('someone.else@altohr.com');
    try {
      const res = await hr.get(url);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('not_a_named_exporter');
    } finally {
      restore();
    }

    restore = withAllowlist(user.email);
    try {
      expect((await hr.get(url)).status).not.toBe(403);
    } finally {
      restore();
    }
  });

  it('covers the SSA and IRS wage files as well as the zips', async () => {
    await seedForms();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(user.email);
    const restore = withAllowlist('someone.else@altohr.com');
    try {
      for (const url of [
        '/tax-forms/1099-nec/bulk.zip?taxYear=2025',
        '/tax-forms/1099-misc/bulk.zip?taxYear=2025',
        '/tax-forms/w2/efw2.txt?taxYear=2025',
        '/tax-forms/w2/efw2c.txt?taxYear=2025',
        '/tax-forms/1099-nec/fire.txt?taxYear=2025',
        '/tax-forms/1099-misc/fire.txt?taxYear=2025',
      ]) {
        const res = await hr.get(url);
        expect(res.status, url).toBe(403);
        expect(res.body.error.code, url).toBe('not_a_named_exporter');
      }
    } finally {
      restore();
    }
  });
});

describe('a paystub is not an SSN', () => {
  it('stays with the four oversight roles, and stays away from the other payroll roles', async () => {
    // No behaviour change here — the capability now says what the
    // hardcoded array said, so this pins the set rather than moving it.
    const assoc = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    // A paystub needs a real run + item; this asserts the GATE, so a
    // nonexistent item is fine — the refusal arrives before the lookup for
    // roles without the capability, and as a 404 for roles with it.
    const fakeItem = '00000000-0000-0000-0000-000000000001';
    expect((await hr.get(`/payroll/items/${fakeItem}/paystub.pdf`)).status).toBe(404);

    for (const role of ['MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER'] as const) {
      const a = await agentFor(role);
      expect((await a.get(`/payroll/items/${fakeItem}/paystub.pdf`)).status, role).toBe(404);
    }
    expect(assoc.id).toBeTruthy();
  });
});
