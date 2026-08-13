import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';

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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

async function loginHr(): Promise<TestAgent<Test>> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(user.email);
}

/** CRLF-joined CSV buffer, matching what Excel/Sheets export. */
function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

function preview(agent: TestAgent<Test>, file: Buffer, name = 'import.csv'): Test {
  return agent.post('/onboarding/admin/import/preview').attach('file', file, name);
}

function commit(agent: TestAgent<Test>, file: Buffer, mode: string, name = 'import.csv'): Test {
  return agent
    .post('/onboarding/admin/import/commit')
    .field('mode', mode)
    .attach('file', file, name);
}

describe('POST /onboarding/admin/import/preview', () => {
  it('flags bad email, unknown client, existing + intra-file duplicates with line numbers — and writes nothing', async () => {
    await createClient('Acme Grocery');
    await createAssociate({ email: 'bob@example.com' });
    const a = await loginHr();

    // Case-insensitive, punctuation-tolerant headers, order-free.
    const file = csv([
      'First Name,Last Name,EMAIL,Phone,Hire Date,Client Name,Position',
      'Alice,Hart,alice@example.com,555-0100,2026-08-01,Acme Grocery,Cashier', // line 2 ok
      'Bad,Mail,not-an-email,,,Acme Grocery,', // line 3: bad email
      'Carl,Yu,carl@example.com,,,Nope Grocery,', // line 4: unknown client
      'Bob,Old,bob@example.com,,,Acme Grocery,', // line 5: already exists
      'Alice,Dupe,alice@example.com,,,Acme Grocery,', // line 6: duplicate in file
    ]);
    const beforeAssociates = await prisma.associate.count();

    const res = await preview(a, file);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      total: 5,
      valid: 1,
      invalid: 4,
      duplicateEmails: 2,
    });

    const byLine = new Map<number, { errors: string[]; data: { clientId: string | null } }>(
      res.body.rows.map((r: { line: number }) => [r.line, r]),
    );
    expect(byLine.get(2)!.errors).toEqual([]);
    expect(byLine.get(2)!.data.clientId).toBeTruthy(); // Acme resolved by name
    expect(byLine.get(3)!.errors.join(' ')).toContain('invalid email');
    expect(byLine.get(4)!.errors.join(' ')).toContain('unknown client "Nope Grocery"');
    expect(byLine.get(5)!.errors.join(' ')).toContain('already exists');
    expect(byLine.get(6)!.errors.join(' ')).toContain('first used on line 2');

    // Preview is a dry run — no writes.
    expect(await prisma.associate.count()).toBe(beforeAssociates);
    expect(await prisma.application.count()).toBe(0);
  });

  it('parses quoted commas, escaped quotes, CRLF, and a UTF-8 BOM', async () => {
    await createClient('Acme Grocery');
    const a = await loginHr();

    const file = Buffer.from(
      '\uFEFF' + // UTF-8 BOM, as Excel writes it
        'firstName,lastName,email,clientName,position\r\n' +
        '"Anne ""Annie""","Smith, Jr.",anne@example.com,"Acme Grocery","Deli, night shift"\r\n',
      'utf8',
    );
    const res = await preview(a, file);
    expect(res.status).toBe(200);
    expect(res.body.summary.valid).toBe(1);
    const row = res.body.rows[0];
    expect(row.line).toBe(2);
    expect(row.data.firstName).toBe('Anne "Annie"');
    expect(row.data.lastName).toBe('Smith, Jr.');
    expect(row.data.position).toBe('Deli, night shift');
    expect(row.data.clientId).toBeTruthy();
  });

  it('rejects a file with missing required columns (400 missing_columns)', async () => {
    const a = await loginHr();
    const res = await preview(a, csv(['firstName,email', 'Alice,alice@example.com']));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('missing_columns');
    expect(res.body.error.message).toContain('lastName');
    expect(res.body.error.message).toContain('clientName or clientId');
  });

  it('rejects a non-.csv filename and a binary payload', async () => {
    const a = await loginHr();
    const asTxt = await preview(a, csv(['firstName,lastName,email,clientName']), 'import.txt');
    expect(asTxt.status).toBe(400);
    expect(asTxt.body.error.code).toBe('invalid_file_type');

    const binary = await preview(a, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
    expect(binary.status).toBe(400);
    expect(binary.body.error.code).toBe('invalid_file_content');
  });

  it('rejects more than 2000 data rows (400 too_many_rows)', async () => {
    await createClient('Acme Grocery');
    const a = await loginHr();
    const lines = ['firstName,lastName,email,clientName'];
    for (let i = 0; i < 2001; i++) {
      lines.push(`P${i},Q${i},p${i}@example.com,Acme Grocery`);
    }
    const res = await preview(a, csv(lines));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('too_many_rows');
  });

  it('rejects an oversized file (413)', async () => {
    const a = await loginHr();
    // > 2 MB of padding — multer's fileSize limit trips before parsing.
    const big = Buffer.concat([
      Buffer.from('firstName,lastName,email,clientName\r\n', 'utf8'),
      Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61),
    ]);
    const res = await preview(a, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
  });

  it('is denied to associates (no invite:onboarding)', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    const a = await loginAs(user.email);
    const res = await preview(a, csv(['firstName,lastName,email,clientName']));
    expect(res.status).toBe(403);
  });
});

describe('POST /onboarding/admin/import/commit', () => {
  it("mode 'create' migrates Associate + APPROVED Application + open assignment (no users, no emails), skips invalid rows, audits counts", async () => {
    const client = await createClient('Acme Grocery');
    const a = await loginHr();

    const file = csv([
      'firstName,lastName,email,phone,hireDate,clientName,position',
      'Alice,Hart,alice@example.com,555-0100,2026-08-01,Acme Grocery,Cashier',
      'Dana,Lee,dana@example.com,,,Acme Grocery,',
      'Bad,Mail,not-an-email,,,Acme Grocery,',
    ]);
    const res = await commit(a, file, 'create');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 3, created: 2, invited: 0, skipped: 1 });

    const byLine = new Map<number, { status: string; reason: string | null }>(
      res.body.results.map((r: { line: number }) => [r.line, r]),
    );
    expect(byLine.get(2)!.status).toBe('created');
    expect(byLine.get(3)!.status).toBe('created');
    expect(byLine.get(4)!.status).toBe('skipped');
    expect(byLine.get(4)!.reason).toContain('invalid');

    const alice = await prisma.associate.findUniqueOrThrow({
      where: { email: 'alice@example.com' },
    });
    expect(alice.phone).toBe('555-0100');
    expect(alice.hireDate?.toISOString().slice(0, 10)).toBe('2026-08-01');
    const app2 = await prisma.application.findFirstOrThrow({
      where: { associateId: alice.id },
    });
    expect(app2.clientId).toBe(client.id);
    expect(app2.position).toBe('Cashier');
    expect(app2.startDate?.toISOString().slice(0, 10)).toBe('2026-08-01');
    // Single-site client → the site picked itself (createClient seeds one).
    expect(app2.locationId).not.toBeNull();
    // Migrated people were hired long before Alto People — the application
    // lands APPROVED so they pass the scheduling roster's employment gate.
    expect(app2.status).toBe('APPROVED');
    expect(app2.approvedAt).not.toBeNull();
    // …and the open assignment the normal approve flow would have created.
    const assignment = await prisma.associateAssignment.findFirstOrThrow({
      where: { associateId: alice.id, endedAt: null },
    });
    expect(assignment.locationId).toBe(app2.locationId);
    expect(assignment.startedAt.toISOString().slice(0, 10)).toBe('2026-08-01');

    // Silent migration: no user accounts, no emails of any kind.
    expect(await prisma.user.count({ where: { email: { in: ['alice@example.com', 'dana@example.com'] } } })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);

    // One audit row with counts + actor, no PII.
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'onboarding.csv_imported' },
    });
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.mode).toBe('create');
    expect(meta.created).toBe(2);
    expect(meta.skipped).toBe(1);
    expect(JSON.stringify(meta)).not.toContain('alice@example.com');
  });

  it('re-running the same file is idempotent — existing rows come back skipped/already_exists', async () => {
    await createClient('Acme Grocery');
    const a = await loginHr();
    const file = csv([
      'firstName,lastName,email,clientName',
      'Alice,Hart,alice@example.com,Acme Grocery',
      'Dana,Lee,dana@example.com,Acme Grocery',
    ]);

    const first = await commit(a, file, 'create');
    expect(first.status).toBe(200);
    expect(first.body.summary.created).toBe(2);

    const associatesAfterFirst = await prisma.associate.count();
    const applicationsAfterFirst = await prisma.application.count();

    const second = await commit(a, file, 'create');
    expect(second.status).toBe(200);
    expect(second.body.summary).toEqual({ total: 2, created: 0, invited: 0, skipped: 2 });
    for (const row of second.body.results) {
      expect(row.status).toBe('skipped');
      expect(row.reason).toBe('already_exists');
    }
    // Nothing duplicated.
    expect(await prisma.associate.count()).toBe(associatesAfterFirst);
    expect(await prisma.application.count()).toBe(applicationsAfterFirst);
  });

  it("mode 'invite' additionally creates INVITED users and queues the standard invite email (stubbed — nothing actually leaves)", async () => {
    await createClient('Acme Grocery');
    await createStandardTemplate(); // global STANDARD template
    const a = await loginHr();

    const file = csv([
      'firstName,lastName,email,phone,hireDate,clientName,position',
      'Alice,Hart,alice@example.com,555-0100,2026-08-01,Acme Grocery,Cashier',
    ]);
    const res = await commit(a, file, 'invite');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 1, created: 0, invited: 1, skipped: 0 });
    expect(res.body.results[0]).toMatchObject({ line: 2, status: 'invited' });

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.com' } });
    expect(user.status).toBe('INVITED');
    expect(user.passwordHash).toBeNull();
    expect(user.role).toBe('ASSOCIATE');
    const invite = await prisma.inviteToken.findFirstOrThrow({
      where: { userId: user.id, consumedAt: null },
    });
    expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The invite email was recorded — via the STUB sender (RESEND_API_KEY
    // is unset in tests), so no real email left the box.
    const notif = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: user.id, category: 'onboarding.invite' },
    });
    expect(notif.externalRef).toMatch(/^STUB-EMAIL-/);

    // Application got the standard checklist; associate got phone + hireDate.
    const application = await prisma.application.findFirstOrThrow({
      where: { associate: { email: 'alice@example.com' } },
      include: { checklist: { include: { tasks: true } } },
    });
    expect(application.checklist?.tasks.length).toBeGreaterThan(0);
    const associate = await prisma.associate.findUniqueOrThrow({
      where: { email: 'alice@example.com' },
    });
    expect(associate.phone).toBe('555-0100');
    expect(associate.hireDate?.toISOString().slice(0, 10)).toBe('2026-08-01');

    // Idempotency holds for invite mode too.
    const second = await commit(a, file, 'invite');
    expect(second.status).toBe(200);
    expect(second.body.results[0]).toMatchObject({ status: 'skipped', reason: 'already_exists' });
  });

  it("mode 'create' requires manage:onboarding — an invite-only role (SHIFT_SUPERVISOR) gets 403 and writes nothing", async () => {
    const client = await createClient('Acme Grocery');
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(user.email);
    const file = csv([
      'firstName,lastName,email,clientName',
      'Alice,Hart,alice@example.com,Acme Grocery',
    ]);

    // 'create' now stamps an HR approval, which invite:onboarding alone
    // must not be able to do.
    const res = await commit(a, file, 'create');
    expect(res.status).toBe(403);
    expect(await prisma.associate.count()).toBe(0);
    expect(await prisma.application.count()).toBe(0);
  });

  it('migrated workers are schedulable — the importing client\'s supervisor sees them in the roster', async () => {
    const client = await createClient('Acme Grocery');
    const hr = await loginHr();
    const res = await commit(
      hr,
      csv([
        'firstName,lastName,email,clientName,position',
        'Alice,Hart,alice@example.com,Acme Grocery,Cashier',
      ]),
      'create',
    );
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(1);

    // The original complaint: supervisors' rosters were empty because
    // migrated DRAFT applications never passed the APPROVED-or-assigned
    // schedulability gate.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(sup.email);
    const roster = await a.get('/scheduling/associates');
    expect(roster.status).toBe(200);
    expect(
      roster.body.associates.map((r: { email: string | null }) => r.email),
    ).toContain('alice@example.com');
  });

  it("rejects a bad mode (400) and an intra-file duplicate is skipped as 'duplicate_in_file'", async () => {
    await createClient('Acme Grocery');
    const a = await loginHr();
    const file = csv([
      'firstName,lastName,email,clientName',
      'Alice,Hart,alice@example.com,Acme Grocery',
      'Alice,Dupe,alice@example.com,Acme Grocery',
    ]);

    const badMode = await commit(a, file, 'yolo');
    expect(badMode.status).toBe(400);
    expect(badMode.body.error.code).toBe('invalid_mode');

    const res = await commit(a, file, 'create');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 2, created: 1, invited: 0, skipped: 1 });
    const dupe = res.body.results.find((r: { line: number }) => r.line === 3);
    expect(dupe).toMatchObject({ status: 'skipped', reason: 'duplicate_in_file' });
    expect(await prisma.associate.count({ where: { email: 'alice@example.com' } })).toBe(1);
  });
});
