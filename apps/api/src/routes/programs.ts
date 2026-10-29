import { Router } from 'express';
import { csvCell as sharedCsvCell } from '@alto-people/shared';
import { tenantIdForWrite } from '../lib/tenant.js';
import { z } from 'zod';
import {
  PROGRAM_TYPE_LABELS,
  ProgramAlertSettingsSchema,
  ProgramInputSchema,
  ProgramTypeSchema,
  ProgramUpdateSchema,
  SponsorInputSchema,
  type SponsorReportResponse,
  type TransitionCalendarResponse,
} from '@alto-people/shared';
import { ROLE_CAPABILITIES, patchSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { recordComplianceEvent } from '../lib/audit.js';
import {
  createProgram,
  createSponsor,
  currentAlerts,
  currentProgramFor,
  getAlertSettings,
  getProgram,
  listPrograms,
  listSponsors,
  saveAlertSettings,
  sponsorReport,
  transitionCalendar,
  updateProgram,
  updateSponsor,
} from '../lib/programs.js';
import { ReportPdf } from '../lib/reportPdf.js';
import { formatRef } from '../lib/emailTemplates.js';

/**
 * Program Lifecycle (Brief 1C-2).
 *
 *   GET   /programs                       participants with alerts     (view:compliance)
 *   POST  /programs                                                     (manage:compliance)
 *   GET   /programs/:id · PATCH /programs/:id
 *   GET   /programs/associate/:associateId the record's current program (view:compliance)
 *   GET   /programs/alerts                every alert firing today     (view:compliance)
 *   GET   /programs/alerts/mine           a supervisor's floor only    (any staff login)
 *   GET   /programs/alert-settings · PUT  lead times                    (manage:compliance to write)
 *   GET   /programs/sponsors · POST · PATCH /programs/sponsors/:id
 *   GET   /programs/sponsors/:id/report?from&to[&format=csv|pdf]
 *   GET   /programs/calendar?from&to[&locationId][&clientId][&format=pdf]
 */
export const programsRouter = Router();

const VIEW = requireCapability('view:compliance');
const MANAGE = requireCapability('manage:compliance');
const Id = z.string().uuid();
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
// The shared escaper (@alto-people/shared): formula guard that leaves numbers numeric.
const csvCell = (v: string | number | null | undefined) => sharedCsvCell(v);
const csv = (rows: Array<Array<string | number | null | undefined>>) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

programsRouter.get('/', VIEW, async (req, res, next) => {
  try {
    const q = z
      .object({
        type: ProgramTypeSchema.optional(),
        sponsorId: Id.optional(),
        clientId: Id.optional(),
        associateId: Id.optional(),
        history: z.enum(['1', 'true']).optional(),
      })
      .parse(req.query);
    res.json({ programs: await listPrograms(prisma, { ...q, includeHistory: !!q.history }) });
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/alerts', VIEW, async (req, res, next) => {
  try {
    const clientId = req.user!.role === 'SHIFT_SUPERVISOR' || req.user!.role === 'FLOOR_SUPERVISOR' ? req.user!.clientId : null;
    res.json({ alerts: await currentAlerts(prisma, { clientId }), settings: await getAlertSettings(prisma) });
  } catch (err) {
    next(err);
  }
});

/** The supervisor dashboard: alerts for the people on their floor. */
programsRouter.get('/alerts/mine', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    const seesAll = ROLE_CAPABILITIES[u.role].has('view:compliance');
    if (!seesAll && !u.clientId) throw new HttpError(403, 'forbidden', 'No client scope.');
    res.json({ alerts: await currentAlerts(prisma, { clientId: seesAll ? null : u.clientId }), settings: await getAlertSettings(prisma) });
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/alert-settings', VIEW, async (_req, res, next) => {
  try {
    res.json(await getAlertSettings(prisma));
  } catch (err) {
    next(err);
  }
});

programsRouter.put('/alert-settings', MANAGE, async (req, res, next) => {
  try {
    const input = ProgramAlertSettingsSchema.parse(req.body);
    res.json(await saveAlertSettings(prisma, input, req.user!.id));
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/sponsors', VIEW, async (_req, res, next) => {
  try {
    res.json({ sponsors: await listSponsors(prisma) });
  } catch (err) {
    next(err);
  }
});

programsRouter.post('/sponsors', MANAGE, async (req, res, next) => {
  try {
    res.status(201).json(await createSponsor(prisma, SponsorInputSchema.parse(req.body)));
  } catch (err) {
    next(err);
  }
});

programsRouter.patch('/sponsors/:id', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    res.json(await updateSponsor(prisma, id, patchSchema(SponsorInputSchema).parse(req.body)));
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/sponsors/:id/report', VIEW, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const q = z.object({ from: DateOnly, to: DateOnly, format: z.enum(['json', 'csv', 'pdf']).default('json') }).parse(req.query);
    if (q.to < q.from) throw new HttpError(400, 'invalid_range', 'to must be on or after from');
    const report = await sponsorReport(prisma, id, q.from, q.to);
    const base = `sponsor-report-${slug(report.sponsor.name)}-${q.from}-${q.to}`;
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.send(
        csv([
          ['Participant', 'Country', 'Program start', 'Program end', 'Client', 'Site', 'Hours', 'Housing', 'Incidents', 'Last check-in', 'Departure', 'Departure reason'],
          ...report.rows.map((r) => [r.associateName, r.country, r.programStart, r.programEnd, r.clientName, r.siteName, r.hours, r.housing, r.incidents, r.lastSponsorCheckInOn, r.departure?.lastDayWorked ?? '', r.departure?.reason ?? '']),
        ]),
      );
      return;
    }
    if (q.format === 'pdf') {
      const pdf = await sponsorReportPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      res.send(pdf);
      return;
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/calendar', VIEW, async (req, res, next) => {
  try {
    const q = z
      .object({ from: DateOnly, to: DateOnly, locationId: Id.optional(), clientId: Id.optional(), format: z.enum(['json', 'pdf']).default('json') })
      .parse(req.query);
    if (q.to < q.from) throw new HttpError(400, 'invalid_range', 'to must be on or after from');
    const cal = await transitionCalendar(prisma, q);
    if (q.format === 'pdf') {
      let scopeName = 'All sites';
      if (q.locationId) {
        const loc = await prisma.site.findUnique({ where: { id: q.locationId }, select: { name: true, client: { select: { name: true } } } });
        if (loc) scopeName = loc.client ? `${loc.client.name} — ${loc.name}` : loc.name;
      } else if (q.clientId) {
        const client = await prisma.client.findUnique({ where: { id: q.clientId }, select: { name: true } });
        if (client) scopeName = client.name;
      }
      const pdf = await calendarPdf(cal, scopeName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="transition-calendar-${slug(scopeName)}-${q.from}-${q.to}.pdf"`);
      res.send(pdf);
      return;
    }
    res.json(cal);
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/associate/:associateId', VIEW, async (req, res, next) => {
  try {
    const associateId = Id.parse(req.params.associateId);
    // Another tenant's person is not found here (Brief 2-1, cross-tenant suite).
    const known = await prisma.associate.findFirst({ where: { id: associateId, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!known) throw new HttpError(404, 'associate_not_found', 'Associate not found');
    res.json({ program: await currentProgramFor(prisma, associateId) });
  } catch (err) {
    next(err);
  }
});

programsRouter.get('/:id', VIEW, async (req, res, next) => {
  try {
    res.json(await getProgram(prisma, Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

programsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = ProgramInputSchema.parse(req.body);
    const program = await createProgram(prisma, input, req.user!.id);
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'program.created',
      entityType: 'Associate',
      entityId: program.associateId,
      associateId: program.associateId,
      metadata: { programId: program.id, type: program.type, programEnd: program.programEnd, petitionClientId: program.petitionClientId },
      req,
    });
    res.status(201).json(program);
  } catch (err) {
    next(err);
  }
});

programsRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = ProgramUpdateSchema.parse(req.body);
    const program = await updateProgram(prisma, id, input);
    await recordComplianceEvent({
      actorUserId: req.user!.id,
      action: 'program.updated',
      entityType: 'Associate',
      entityId: program.associateId,
      associateId: program.associateId,
      metadata: { programId: program.id, fields: Object.keys(input) },
      req,
    });
    res.json(program);
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------------- the PDFs */

const monthLabel = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Counts and dates only: what a client is handed to plan the season. */
async function calendarPdf(cal: TransitionCalendarResponse, scopeName: string): Promise<Buffer> {
  const pdf = new ReportPdf({
    title: 'Workforce transition calendar',
    subtitle: `${scopeName} · ${cal.from} to ${cal.to}`,
    facts: [
      { label: 'Arrivals', value: String(cal.totals.arrivals) },
      { label: 'Program ends', value: String(cal.totals.programEnds) },
      { label: 'Departures', value: String(cal.totals.departures) },
    ],
    reference: formatRef(),
    confidentialityNote: 'Counts and dates only. No participant is named in this document.',
  });
  for (const month of cal.months) {
    const cells = cal.cells.filter((c) => c.month === month);
    pdf.heading(monthLabel(month));
    if (cells.length === 0) {
      pdf.para('No arrivals, program ends or departures.', { muted: true });
      continue;
    }
    pdf.table(
      [
        { label: 'Site' },
        { label: 'Channel', width: 150 },
        { label: 'Arrivals', width: 60, align: 'right' },
        { label: 'Program ends', width: 80, align: 'right' },
        { label: 'Departures', width: 70, align: 'right' },
      ],
      cells.map((c) => [c.clientName === '—' ? c.siteName : `${c.clientName} — ${c.siteName}`, PROGRAM_TYPE_LABELS[c.channel], c.arrivals, c.programEnds, c.departures]),
    );
  }
  return pdf.render();
}

async function sponsorReportPdf(r: SponsorReportResponse): Promise<Buffer> {
  const pdf = new ReportPdf({
    title: `Sponsor report — ${r.sponsor.name}`,
    subtitle: `${r.from} to ${r.to}`,
    facts: [
      { label: 'Participants', value: String(r.totals.participants) },
      { label: 'Hours', value: r.totals.hours.toLocaleString('en-US') },
      { label: 'Incidents', value: String(r.totals.incidents) },
      { label: 'Departures', value: String(r.totals.departures) },
    ],
    reference: formatRef(),
  });
  pdf.table(
    [
      { label: 'Participant' },
      { label: 'Program', width: 110 },
      { label: 'Placement', width: 120 },
      { label: 'Hours', width: 45, align: 'right' },
      { label: 'Housing', width: 120 },
      { label: 'Incidents', width: 50, align: 'right' },
      { label: 'Departure', width: 80 },
    ],
    r.rows.map((row) => [
      `${row.associateName}${row.country ? ` (${row.country})` : ''}`,
      `${row.programStart} → ${row.programEnd}`,
      [row.clientName, row.siteName].filter(Boolean).join(' — ') || '—',
      row.hours,
      row.housing ?? '—',
      row.incidents,
      row.departure ? `${row.departure.lastDayWorked} · ${row.departure.reason.replace(/_/g, ' ').toLowerCase()}` : '—',
    ]),
  );
  return pdf.render();
}
