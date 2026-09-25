import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

// Invites go out by email with an .ics attached; capture them.
const sent = vi.hoisted(
  () =>
    [] as Array<{
      to: string | null;
      subject: string | null;
      ics: string | null;
      contentType: string | null;
    }>,
);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      const a = input.attachments?.[0];
      sent.push({
        to: input.recipient.email,
        subject: input.subject,
        // Unfolded, as a calendar reads it: RFC 5545 wraps long lines at
        // 75 octets with CRLF + space, which splits an attendee's address.
        ics: a ? a.content.toString('utf8').replace(/\r\n /g, '') : null,
        contentType: a?.contentType ?? null,
      });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Interviews that land in a calendar, and scorecards that can be compared.
 *
 * Scheduling used to store a time and tell no one; scoring was free text
 * per question, readable one interview at a time and never side by side.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
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

async function setup() {
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const { user: interviewer } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(rec.email);
  const c = await a.post('/recruiting/candidates').send({
    firstName: 'Kim', lastName: 'Phan', email: 'kim.phan@example.com', position: 'Cashier',
  });
  return { a, rec, interviewer, candidateId: c.body.id as string };
}

const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000);

describe('calendar invites', () => {
  it('scheduling emails the candidate and the interviewer an invite their calendar can add', async () => {
    const { a, rec, interviewer, candidateId } = await setup();
    const at = inTwoDays();
    at.setUTCMinutes(0, 0, 0);
    const r = await a.post('/interviews').send({
      candidateId,
      interviewerUserId: interviewer.id,
      scheduledFor: at.toISOString(),
      durationMinutes: 45,
      location: 'Destin #1234, 15017 Emerald Coast Pkwy',
    });
    expect(r.status).toBe(201);
    expect(r.body.invited).toEqual({ candidate: true, interviewer: true });

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const toCandidate = sent.find((m) => m.to === 'kim.phan@example.com')!;
    const toInterviewer = sent.find((m) => m.to === interviewer.email)!;
    expect(toCandidate.subject).toMatch(/^Your interview with Alto:/);
    expect(toInterviewer.subject).toMatch(/^Interview with Kim Phan/);
    expect(toCandidate.contentType).toBe('text/calendar; method=REQUEST; charset=UTF-8');

    const ics = toCandidate.ics!;
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain(`UID:interview-${r.body.id}@alto-people`);
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain(`DTSTART:${stamp(at)}`);
    expect(ics).toContain(`DTEND:${stamp(new Date(at.getTime() + 45 * 60_000))}`);
    expect(ics).toContain('mailto:kim.phan@example.com');
    expect(ics).toContain(`mailto:${interviewer.email}`);
    expect(ics).toContain(`ORGANIZER;CN=`);
    expect(ics).toContain(`:mailto:${rec.email}`);
    // RFC 5545: CRLF line endings.
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
  });

  it('can be scheduled without telling anyone', async () => {
    const { a, candidateId } = await setup();
    const r = await a.post('/interviews').send({ candidateId, scheduledFor: inTwoDays().toISOString(), notify: false });
    expect(r.body.invited).toEqual({ candidate: false, interviewer: false });
    await new Promise((res) => setTimeout(res, 50));
    expect(sent).toHaveLength(0);
  });

  it('a reschedule replaces the invite, and a swapped-out interviewer loses the slot', async () => {
    const { a, interviewer, candidateId } = await setup();
    const { user: second } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const iv = await a.post('/interviews').send({
      candidateId, interviewerUserId: interviewer.id, scheduledFor: inTwoDays().toISOString(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    sent.length = 0;

    const later = new Date(Date.now() + 3 * 86_400_000);
    const r = await a.patch(`/interviews/${iv.body.id}`).send({
      scheduledFor: later.toISOString(),
      interviewerUserId: second.id,
    });
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    const toCandidate = sent.find((m) => m.to === 'kim.phan@example.com')!;
    expect(toCandidate.subject).toMatch(/has moved/);
    // Same UID, higher SEQUENCE: calendars update rather than duplicate.
    expect(toCandidate.ics).toContain(`UID:interview-${iv.body.id}@alto-people`);
    expect(toCandidate.ics).toContain('SEQUENCE:1');
    expect(sent.find((m) => m.to === second.email)!.ics).toContain('METHOD:REQUEST');
    const dropped = sent.find((m) => m.to === interviewer.email)!;
    expect(dropped.ics).toContain('METHOD:CANCEL');

    const events = (await a.get(`/recruiting/candidates/${candidateId}/events`)).body.events;
    expect(events[0]).toMatchObject({ kind: 'INTERVIEW_RESCHEDULED', body: later.toISOString() });
  });

  it('cancelling takes it back out of both calendars', async () => {
    const { a, interviewer, candidateId } = await setup();
    const iv = await a.post('/interviews').send({
      candidateId, interviewerUserId: interviewer.id, scheduledFor: inTwoDays().toISOString(),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    sent.length = 0;
    expect((await a.delete(`/interviews/${iv.body.id}`)).status).toBe(204);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    for (const m of sent) {
      expect(m.contentType).toBe('text/calendar; method=CANCEL; charset=UTF-8');
      expect(m.ics).toContain('STATUS:CANCELLED');
      expect(m.ics).toContain('SEQUENCE:1');
    }
  });

  it('a scored interview is history — it can\'t be moved', async () => {
    const { a, candidateId } = await setup();
    const iv = await a.post('/interviews').send({ candidateId, scheduledFor: new Date(Date.now() - 3_600_000).toISOString(), notify: false });
    await a.post(`/interviews/${iv.body.id}/score`).send({ scorecard: null, rating: 1 });
    const r = await a.patch(`/interviews/${iv.body.id}`).send({ scheduledFor: inTwoDays().toISOString() });
    expect(r.status).toBe(409);
  });
});

describe('structured scorecards', () => {
  it('takes a rating per question on one scale, and refuses anything off it', async () => {
    const { a, candidateId } = await setup();
    const iv = await a.post('/interviews').send({ candidateId, scheduledFor: new Date(Date.now() - 3_600_000).toISOString(), notify: false });
    const bad = await a.post(`/interviews/${iv.body.id}/score`).send({
      rating: 1,
      scorecard: { answers: [{ prompt: 'Upset customer?', rating: 5, notes: '' }], summary: '' },
    });
    expect(bad.status).toBe(400);

    const ok = await a.post(`/interviews/${iv.body.id}/score`).send({
      rating: 1,
      scorecard: {
        answers: [
          { prompt: 'Upset customer?', rating: 4, notes: 'Calm, apologised, got a manager.' },
          { prompt: 'Which shifts can you work?', rating: 2, notes: 'Mornings only.' },
        ],
        summary: 'Good fit for opening shifts.',
      },
    });
    expect(ok.status).toBe(200);
    const [row] = (await a.get(`/interviews?candidateId=${candidateId}`)).body.interviews;
    expect(row.scorecard.answers.map((x: { rating: number }) => x.rating)).toEqual([4, 2]);
    expect(row.rating).toBe(1);
    expect(row.durationMinutes).toBe(30);
  });
});
