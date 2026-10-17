import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent as http, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { disclosureLine, withDisclosure } from '../../lib/agentDisclosure.js';
import { builtInAgentId, ensureBuiltInAgents, inProcessAgent, postAgentMessage, resetAgentRateLimits } from '../../lib/agents.js';
import { askFrom, runAttendanceConfirm } from '../../lib/attendanceConfirm.js';
import { runDocumentChase, runSection2Clock } from '../../lib/complianceAgent.js';
import { addBusinessDays } from '../../lib/everifyReadiness.js';
import { runIncidentLoop } from '../../lib/incidentLoop.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';
import { handleInbound } from '../../lib/whatsappAssistant.js';

/**
 * AI disclosure by default (lib/agentDisclosure): every message an agent
 * causes ends with one line, in the person's language, saying an AI agent
 * sent it and who answers for it; the in-app record carries the agent
 * (byAgentId). One case per sender.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'America/Chicago';

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

describe('the line', () => {
  it('names the agent, says it is an AI agent and who answers for it, in English, Spanish and Turkish; once', () => {
    const en = withDisclosure('Your shift is covered.', { agentName: 'Workforce agent', ownerName: 'Jane Doe', lang: 'en' });
    expect(en).toBe('Your shift is covered.\n\nSent by Workforce agent, an AI agent — Jane Doe answers for it.');
    expect(disclosureLine({ agentName: 'Agente de cumplimiento', ownerName: 'Jane Doe', lang: 'es' })).toBe('Enviado por Agente de cumplimiento, un agente de IA — Jane Doe responde por él.');
    expect(disclosureLine({ agentName: 'Hugo', ownerName: 'Jane Doe', lang: 'tr' })).toBe('Hugo tarafından gönderildi; bir yapay zeka ajanıdır — ondan Jane Doe sorumludur.');
    // Nobody on file: the tenant's word for the manager answers.
    expect(disclosureLine({ agentName: 'Hugo', ownerName: null, lang: 'en', terms: { manager: 'Property manager' } })).toBe('Sent by Hugo, an AI agent — your property manager answers for it.');
    // Idempotent: a text that already ends with the line is left alone.
    expect(withDisclosure(en, { agentName: 'Workforce agent', ownerName: 'Jane Doe', lang: 'en' })).toBe(en);
  });
});

/** The oldest admin owns every built-in agent (ensureBuiltInAgents); with no associate record the owner reads as their email. */
async function builtIns() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workforce = (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
  const compliance = (await builtInAgentId(prisma, 'compliance-agent', ALTO_TENANT_ID))!;
  // They boot ONBOARDING; these cases exercise them as an owner would after certifying.
  await prisma.worker.updateMany({ where: { id: { in: [workforce, compliance] } }, data: { status: 'ACTIVE' } });
  return { hr, workforce, compliance, owner: hr.email };
}

function localMorning(days: number): Date {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * DAY));
  return new Date(utcInstantOfLocalMidnight(key, TZ).getTime() + 8 * HOUR);
}

describe('the Workforce agent', () => {
  it('attendance.confirm: the ask ends with the line in the holder\'s language and the record names the agent', async () => {
    const w = await builtIns();
    const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: TZ } });
    const rhea = await createAssociate({ firstName: 'Rhea', lastName: 'Risky' });
    await prisma.associateAssignment.create({ data: { associateId: rhea.id, locationId: hotel.id, startedAt: new Date(Date.now() - 60 * DAY) } });
    const { user: rheaUser } = await createUser({ role: 'ASSOCIATE', email: rhea.email, associateId: rhea.id });
    await prisma.user.update({ where: { id: rheaUser.id }, data: { language: 'tr' } });
    for (const daysAgo of [10, 40]) {
      await prisma.attendanceEvent.create({ data: { associateId: rhea.id, kind: 'NO_CALL_NO_SHOW', points: 2, occurredOn: new Date(Date.now() - daysAgo * DAY), source: 'MANUAL' } });
    }
    const startsAt = localMorning(3);
    await prisma.shift.create({ data: { clientId: null, locationId: hotel.id, position: 'Housekeeper', startsAt, endsAt: new Date(startsAt.getTime() + 8 * HOUR), status: 'ASSIGNED', assignedAssociateId: rhea.id, publishedAt: new Date() } });
    const askAt = new Date(askFrom({ startsAt, locationRel: { timezone: TZ } }).getTime() + HOUR);

    expect((await runAttendanceConfirm(prisma, askAt)).asked).toBe(1);
    await flushPendingNotifications();
    const ask = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: rheaUser.id, category: 'shift_confirm', channel: 'IN_APP' } });
    expect(ask.body.endsWith(disclosureLine({ agentName: 'Workforce agent', ownerName: w.owner, lang: 'tr' }))).toBe(true);
    expect(ask.body).toMatch(/^Housekeeper at The Grand Hotel/);
    expect(ask.byAgentId).toBe(w.workforce);
  });
});

describe('the Compliance agent', () => {
  it('document.chase: the chase ends with the line in the person\'s language; i9.section2 and incident.loop tell the desk the same way', async () => {
    const w = await builtIns();
    const now = new Date();
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', email: ana.email, associateId: ana.id });
    await prisma.user.update({ where: { id: anaUser.id }, data: { language: 'es' } });
    await prisma.documentRecord.create({ data: { associateId: ana.id, kind: 'ID', filename: 'id.pdf', mimeType: 'application/pdf', size: 1, status: 'VERIFIED', expiresAt: new Date(now.getTime() + 20 * DAY) } });
    expect(await runDocumentChase(prisma, now)).toMatchObject({ messages: 1 });
    await flushPendingNotifications();
    const chase = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: anaUser.id, category: 'documents.chase', channel: 'IN_APP' } });
    expect(chase.body.endsWith(disclosureLine({ agentName: 'Compliance agent', ownerName: w.owner, lang: 'es' }))).toBe(true);
    expect(chase.body).toMatch(/^Estos vencen pronto/);
    expect(chase.byAgentId).toBe(w.compliance);

    // i9.section2: HR hears when Section 2 is late.
    const start = new Date(`${new Date(Date.now() - DAY).toISOString().slice(0, 10)}T00:00:00Z`);
    const eve = await createAssociate({ firstName: 'Eve', lastName: 'Hire' });
    await prisma.associate.update({ where: { id: eve.id }, data: { hireDate: start } });
    await prisma.application.create({ data: { associateId: eve.id, onboardingTrack: 'STANDARD', status: 'APPROVED', startDate: start } });
    await prisma.i9Verification.create({ data: { associateId: eve.id, section1CompletedAt: start } });
    const due = addBusinessDays(start, 3);
    expect(await runSection2Clock(prisma, new Date(due.getTime() + DAY + 12 * HOUR))).toMatchObject({ late: 1 });
    await flushPendingNotifications();
    const i9 = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: w.hr.id, category: 'compliance.i9', channel: 'IN_APP' } });
    expect(i9.body.endsWith(disclosureLine({ agentName: 'Compliance agent', ownerName: w.owner, lang: 'en' }))).toBe(true);
    expect(i9.byAgentId).toBe(w.compliance);

    // incident.loop: the desk hears about an incident open 4 days.
    const client = await createClient('Walmart 1234');
    const reportedAt = new Date(Date.now() - 4 * DAY);
    await prisma.oshaIncident.create({ data: { clientId: client.id, associateId: ana.id, occurredAt: reportedAt, reportedAt, description: 'Slipped on a wet floor in aisle 7.', severity: 'MEDICAL_TREATMENT', daysAway: 0, isRecordable: true } });
    expect(await runIncidentLoop(prisma, new Date())).toMatchObject({ told: 1 });
    await flushPendingNotifications();
    const told = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: w.hr.id, category: 'compliance.incidents', channel: 'IN_APP' } });
    expect(told.body.endsWith(disclosureLine({ agentName: 'Compliance agent', ownerName: w.owner, lang: 'en' }))).toBe(true);
    expect(told.byAgentId).toBe(w.compliance);
  });
});

describe('any agent', () => {
  it('an approval request tells the approver an agent is asking; a message carries the line in the readers\' language and names the agent on the record', async () => {
    const w = await builtIns();
    const agent = (await inProcessAgent(prisma, 'workforce-agent', ALTO_TENANT_ID))!;
    const client = await createClient('Coastal Resort');
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const store = await prisma.conversation.create({ data: { kind: 'GROUP', clientId: client.id, title: 'Coastal Resort', participants: { create: [{ userId: portal.id }, { userId: w.hr.id }] } } });

    // A client thread is gated: the owner hears the ask, with the line.
    const gated = await postAgentMessage(prisma, agent, { conversationId: store.id, body: 'Tomorrow 14 people are scheduled for the 6am unload.' });
    expect(gated.gated).toBe(true);
    await flushPendingNotifications();
    const ask = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: w.hr.id, category: 'agent_approval', channel: 'IN_APP' } });
    expect(ask.subject).toBe('Workforce agent is asking for approval');
    expect(ask.body.endsWith(disclosureLine({ agentName: 'Workforce agent', ownerName: w.owner, lang: 'en' }))).toBe(true);
    expect(ask.byAgentId).toBe(w.workforce);

    // An internal thread goes out at once; everyone in it reads Spanish, so the line is Spanish.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const { user: anaUser } = await createUser({ role: 'ASSOCIATE', email: ana.email, associateId: ana.id });
    await prisma.user.update({ where: { id: anaUser.id }, data: { language: 'es' } });
    const direct = await prisma.conversation.create({ data: { kind: 'DIRECT', participants: { create: [{ userId: anaUser.id }] } } });
    const sent = await postAgentMessage(prisma, agent, { conversationId: direct.id, body: 'Tu turno del sábado está cubierto.' });
    expect(sent.gated).toBe(false);
    const m = await prisma.message.findFirstOrThrow({ where: { conversationId: direct.id } });
    expect(m.body).toBe(`Tu turno del sábado está cubierto.\n\n${disclosureLine({ agentName: 'Workforce agent', ownerName: w.owner, lang: 'es' })}`);
    expect(m.senderId).toBeNull();
    expect(m.byAgentId).toBe(w.workforce);
  });

  it('the WhatsApp assistant: an answer ends with the line under the tenant\'s name for it; the opt-in introduction stands alone', async () => {
    const w = await builtIns();
    const client = await createClient('Coastal Resort');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.associate.update({ where: { id: maria.id }, data: { phone: '(850) 555-0101' } });
    await prisma.associateAssignment.create({ data: { associateId: maria.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
    const { user: mariaUser } = await createUser({ role: 'ASSOCIATE', associateId: maria.id });
    await prisma.user.update({ where: { id: mariaUser.id }, data: { language: 'es' } });
    const hr = await loginAs(http(), w.hr.email);
    expect((await hr.patch('/admin/org/settings').send({ assistantName: 'Coco' })).status).toBe(200);
    const asMaria = await loginAs(http(), mariaUser.email);
    expect((await asMaria.post('/whatsapp/me/consent').send({ optIn: true })).status).toBe(200);

    const optIn = await handleInbound({ from: '18505550101', waMessageId: 'wamid.in', text: 'ALTA' }, prisma);
    expect(optIn.reply).toContain('No soy una persona');
    expect(optIn.reply).not.toContain('Enviado por');
    const who = await handleInbound({ from: '18505550101', waMessageId: 'wamid.who', text: '¿quién eres?' }, prisma);
    expect(who.intent).toBe('WHO');
    expect(who.reply!.endsWith(disclosureLine({ agentName: 'Coco', ownerName: w.owner, lang: 'es' }))).toBe(true);
    // The record shows what she saw.
    const row = await prisma.whatsAppMessage.findFirstOrThrow({ where: { associateId: maria.id, direction: 'OUTBOUND', kind: 'ANSWER' }, orderBy: { createdAt: 'desc' } });
    expect(row.body).toContain('Coco, un agente de IA');
  });
});
