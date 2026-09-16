import PDFDocument from 'pdfkit';
import { prisma } from '../db.js';
import { getBlobStore } from './blobStore.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { formatTimeInZone, zonedMinutes } from './timezone.js';
import {
  HOUR,
  ORG_TZ,
  attendanceWhere,
  coverageByHours,
  fullName,
  gradeWeeks,
  loadPunches,
  loadTargets,
  nextKey,
  shiftScope,
  targetAtMinute,
  type PortalScope,
} from './portalMetrics.js';

/**
 * The store service report — the portal, on paper, for a day the
 * store manager picks.
 *
 * A manager who downloads the 16th gets what the portal showed on the
 * 16th: delivered vs contracted for the day, the coverage curve hour by
 * hour, and every shift wave (morning, midday, evening, overnight) with
 * the faces of who was on the floor and when they punched. For a range
 * (last week, a custom span) the first page is the period at a glance
 * and each day follows on its own page. Every number comes from the
 * same instruments the live page uses (portalMetrics), so the PDF and
 * the screen never disagree — the PDF is just the screen, frozen.
 */

export const REPORT_MAX_DAYS = 31;

export type ReportState = 'open' | 'on-floor' | 'worked' | 'missed' | 'not-in' | 'confirmed' | 'unconfirmed';
export type WaveName = 'Morning' | 'Midday' | 'Evening' | 'Overnight';

export interface ReportPerson {
  name: string | null;
  initials: string;
  position: string;
  isLead: boolean;
  locationName: string | null;
  state: ReportState;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  timezone: string;
  photo: Buffer | null;
}

export interface ReportWave {
  name: WaveName;
  timeRange: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  phase: 'upcoming' | 'live' | 'finished';
  expected: number;
  present: number;
  onFloor: number;
  missed: number;
  open: number;
  groups: Array<{ key: 'in' | 'worked' | 'missing' | 'upcoming' | 'open'; label: string; people: ReportPerson[] }>;
}

export interface ReportDay {
  key: string;
  label: string;
  isToday: boolean;
  isFuture: boolean;
  summary: { expected: number; showed: number; onFloor: number; missed: number; open: number };
  contract: {
    contractedHours: number;
    deliveredHours: number;
    score: number | null;
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    basis: 'contract' | 'schedule' | null;
  };
  hours: Array<{ label: string; scheduled: number; delivered: number | null; target: number | null }>;
  waves: ReportWave[];
  requests: Array<{ kind: string; subject: string; status: string; at: string }>;
  multiStore: boolean;
}

export interface PortalReportData {
  orgName: string;
  clientName: string;
  storeName: string | null;
  from: string;
  to: string;
  isRange: boolean;
  generatedAt: string;
  days: ReportDay[];
  totals: {
    expected: number;
    showed: number;
    missed: number;
    open: number;
    contractedHours: number;
    deliveredHours: number;
    score: number | null;
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  };
}

/* ---- naming ------------------------------------------------------------ */

export function waveName(startsAt: Date, timezone: string): WaveName {
  const h = Math.floor(zonedMinutes(startsAt, timezone) / 60);
  if (h >= 4 && h < 11) return 'Morning';
  if (h >= 11 && h < 16) return 'Midday';
  if (h >= 16 && h < 21) return 'Evening';
  return 'Overnight';
}

export function dayLabel(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function shortDay(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function initialsOf(name: string | null): string {
  if (!name) return '·';
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** The scope for a client-wide or store account, loaded off the ids. */
export async function portalScopeFor(clientId: string, locationId: string | null): Promise<PortalScope | null> {
  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, name: true } });
  if (!client) return null;
  const location = locationId
    ? await prisma.location.findFirst({
        where: { id: locationId, clientId, deletedAt: null },
        select: { id: true, name: true, timezone: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true },
      })
    : null;
  if (locationId && !location) return null;
  return { clientId: client.id, locationId: location?.id ?? null, client, location };
}

/* ---- build ------------------------------------------------------------- */

export async function buildPortalReport(
  scope: PortalScope,
  fromKey: string,
  toKey: string,
  orgName: string,
  now: Date = new Date(),
): Promise<PortalReportData> {
  const from = utcInstantOfLocalMidnight(fromKey, ORG_TZ);
  const toExclusive = utcInstantOfLocalMidnight(nextKey(toKey, 1), ORG_TZ);
  const todayKey = orgDateKey(now);
  const nowMs = now.getTime();

  const [rows, leadPositions, punches, targets, requests] = await Promise.all([
    prisma.shift.findMany({
      where: { ...shiftScope(scope), startsAt: { lt: toExclusive }, endsAt: { gt: from } },
      select: {
        id: true,
        position: true,
        startsAt: true,
        endsAt: true,
        status: true,
        acknowledgedAt: true,
        locationId: true,
        assignedAssociateId: true,
        assignedAssociate: { select: { firstName: true, lastName: true, photoS3Key: true } },
        locationRel: { select: { name: true, timezone: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 6000,
    }),
    prisma.shiftPosition.findMany({ where: { clientId: scope.clientId, isLead: true, deletedAt: null }, select: { name: true }, take: 50 }),
    loadPunches(scope, from, toExclusive, now),
    loadTargets(scope, toExclusive < now ? toExclusive : now),
    prisma.clientRequest.findMany({
      where: { clientId: scope.clientId, createdAt: { gte: from, lt: toExclusive } },
      select: { kind: true, subject: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    }),
  ]);
  const ncns = new Set(
    rows.length === 0
      ? []
      : (
          await prisma.attendanceEvent.findMany({
            where: { ...attendanceWhere(scope, from, rows.map((s) => s.id)), kind: 'NO_CALL_NO_SHOW', shiftId: { in: rows.map((s) => s.id) } },
            select: { shiftId: true },
            take: 5000,
          })
        ).map((e) => e.shiftId),
  );
  const leadNames = new Set(leadPositions.map((p) => p.name));

  // Faces: one fetch per distinct photo, bounded. A missing blob just
  // renders the initials medallion, exactly as the live page does.
  const blobStore = getBlobStore();
  const photoKeys = [...new Set(rows.map((s) => s.assignedAssociate?.photoS3Key).filter((k): k is string => !!k))].slice(0, 120);
  const photos = new Map<string, Buffer | null>();
  await Promise.all(
    photoKeys.map(async (k) => {
      try {
        photos.set(k, await blobStore.get(k));
      } catch {
        photos.set(k, null);
      }
    }),
  );

  const days: ReportDay[] = [];
  for (let key = fromKey; key <= toKey; key = nextKey(key, 1)) {
    const dayStart = utcInstantOfLocalMidnight(key, ORG_TZ);
    const dayEnd = utcInstantOfLocalMidnight(nextKey(key, 1), ORG_TZ);
    const dayShifts = rows.filter((s) => s.startsAt < dayEnd && s.endsAt > dayStart);
    const coverage = coverageByHours({
      locations: targets,
      storeScoped: !!scope.locationId,
      from: dayStart,
      to: dayEnd,
      now,
      shifts: dayShifts,
      entries: punches.entries,
    });
    const coverageAt = new Map(coverage.map((h) => [h.instant.getTime(), h]));
    const hours = Array.from({ length: 24 }, (_, h) => {
      const at = new Date(dayStart.getTime() + h * HOUR);
      const covering = dayShifts.filter((s) => s.startsAt.getTime() <= at.getTime() && s.endsAt.getTime() > at.getTime());
      let target: number | null = null;
      for (const loc of targets) {
        const t = targetAtMinute(loc, zonedMinutes(at, loc.timezone));
        if (t) target = (target ?? 0) + t.target;
      }
      const cov = coverageAt.get(at.getTime());
      return {
        label: hourLabel(h),
        scheduled: covering.filter((s) => s.status !== 'OPEN').length,
        delivered: at.getTime() + HOUR <= nowMs ? (cov?.delivered ?? 0) : null,
        target,
      };
    });

    // Each shift's state — the same rules as the live Day page.
    const people = dayShifts.map((s) => {
      const punch = s.status === 'OPEN' ? null : punches.punchFor(s);
      const ended = s.endsAt.getTime() <= nowMs;
      const started = s.startsAt.getTime() <= nowMs;
      let state: ReportState;
      if (s.status === 'OPEN') state = 'open';
      else if (ncns.has(s.id)) state = 'missed';
      else if (punch && punch.clockOutAt === null && !ended) state = 'on-floor';
      else if (punch) state = 'worked';
      else if (ended) state = 'missed';
      else if (started) state = 'not-in';
      else state = s.acknowledgedAt ? 'confirmed' : 'unconfirmed';
      const name = s.assignedAssociate ? fullName(s.assignedAssociate) : null;
      const tz = s.locationRel?.timezone ?? ORG_TZ;
      return {
        shift: s,
        person: {
          name,
          initials: initialsOf(name),
          position: s.position,
          isLead: leadNames.has(s.position),
          locationName: s.locationRel?.name ?? null,
          state,
          clockInAt: punch && state !== 'missed' ? punch.clockInAt : null,
          clockOutAt: punch && state === 'worked' ? punch.clockOutAt : null,
          timezone: tz,
          photo: s.assignedAssociate?.photoS3Key ? (photos.get(s.assignedAssociate.photoS3Key) ?? null) : null,
        } satisfies ReportPerson,
      };
    });

    // Waves: every shift sharing the same start and end instant.
    const byKey = new Map<string, ReportWave & { buckets: Record<ReportWave['groups'][number]['key'], ReportPerson[]> }>();
    for (const { shift: s, person } of people) {
      const k = `${s.startsAt.toISOString()}|${s.endsAt.toISOString()}`;
      const tz = person.timezone;
      let w = byKey.get(k);
      if (!w) {
        w = {
          name: waveName(s.startsAt, tz),
          timeRange: `${formatTimeInZone(s.startsAt, tz)} – ${formatTimeInZone(s.endsAt, tz)}`,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          timezone: tz,
          phase: nowMs < s.startsAt.getTime() ? 'upcoming' : nowMs >= s.endsAt.getTime() ? 'finished' : 'live',
          expected: 0,
          present: 0,
          onFloor: 0,
          missed: 0,
          open: 0,
          groups: [],
          buckets: { in: [], worked: [], missing: [], upcoming: [], open: [] },
        };
        byKey.set(k, w);
      }
      switch (person.state) {
        case 'open':
          w.open += 1;
          w.buckets.open.push(person);
          break;
        case 'on-floor':
          w.expected += 1;
          w.present += 1;
          w.onFloor += 1;
          w.buckets.in.push(person);
          break;
        case 'worked':
          w.expected += 1;
          w.present += 1;
          w.buckets.worked.push(person);
          break;
        case 'missed':
          w.expected += 1;
          w.missed += 1;
          w.buckets.missing.push(person);
          break;
        case 'not-in':
          w.expected += 1;
          w.buckets.missing.push(person);
          break;
        default:
          w.expected += 1;
          w.buckets.upcoming.push(person);
      }
    }
    const byName = (a: ReportPerson, b: ReportPerson) => (a.name ?? '').localeCompare(b.name ?? '');
    const byPunch = (a: ReportPerson, b: ReportPerson) =>
      (a.clockInAt?.getTime() ?? 0) - (b.clockInAt?.getTime() ?? 0) || byName(a, b);
    const waves: ReportWave[] = [...byKey.values()]
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((w) => {
        const { buckets, ...rest } = w;
        const groups: ReportWave['groups'] = [];
        if (buckets.in.length) groups.push({ key: 'in', label: 'On the floor', people: buckets.in.sort(byPunch) });
        if (buckets.worked.length) groups.push({ key: 'worked', label: 'Worked', people: buckets.worked.sort(byPunch) });
        if (buckets.missing.length)
          groups.push({
            key: 'missing',
            label: w.phase === 'finished' ? 'Did not punch in' : 'Not in yet',
            people: buckets.missing.sort(byName),
          });
        if (buckets.upcoming.length) groups.push({ key: 'upcoming', label: 'Expected', people: buckets.upcoming.sort(byName) });
        if (buckets.open.length) groups.push({ key: 'open', label: 'Unfilled', people: buckets.open });
        return { ...rest, groups };
      });

    const states = people.map((p) => p.person.state);
    const ended = dayShifts.filter((s) => s.status !== 'OPEN' && s.endsAt.getTime() <= nowMs);
    const showedEnded = ended.filter((s) => !ncns.has(s.id) && punches.punched(s)).length;
    const contractedHours = coverage.reduce((a, h) => a + h.target, 0);
    const deliveredHours = coverage.reduce((a, h) => a + h.delivered, 0);
    const graded = gradeWeeks([{ contracted: contractedHours, delivered: deliveredHours, ended: ended.length, showed: showedEnded }]);

    days.push({
      key,
      label: dayLabel(key),
      isToday: key === todayKey,
      isFuture: key > todayKey,
      summary: {
        expected: states.filter((s) => s !== 'open').length,
        showed: states.filter((s) => s === 'worked' || s === 'on-floor').length,
        onFloor: states.filter((s) => s === 'on-floor').length,
        missed: states.filter((s) => s === 'missed').length,
        open: states.filter((s) => s === 'open').length,
      },
      contract: { contractedHours, deliveredHours, score: graded.score, grade: graded.grade, basis: graded.basis },
      hours,
      waves,
      requests: requests
        .filter((r) => r.createdAt >= dayStart && r.createdAt < dayEnd)
        .map((r) => ({ kind: r.kind, subject: r.subject, status: r.status, at: formatTimeInZone(r.createdAt, scope.location?.timezone ?? ORG_TZ) })),
      multiStore: new Set(people.map((p) => p.person.locationName ?? '')).size > 1,
    });
  }

  const sum = (f: (d: ReportDay) => number) => days.reduce((a, d) => a + f(d), 0);
  const endedAll = rows.filter((s) => s.status !== 'OPEN' && s.endsAt.getTime() <= nowMs);
  const rangeGrade = gradeWeeks([
    {
      contracted: sum((d) => d.contract.contractedHours),
      delivered: sum((d) => d.contract.deliveredHours),
      ended: endedAll.length,
      showed: endedAll.filter((s) => !ncns.has(s.id) && punches.punched(s)).length,
    },
  ]);

  return {
    orgName,
    clientName: scope.client.name,
    storeName: scope.location?.name ?? null,
    from: fromKey,
    to: toKey,
    isRange: fromKey !== toKey,
    generatedAt: `${orgDateKey(now)} ${formatTimeInZone(now, ORG_TZ)}`,
    days,
    totals: {
      expected: sum((d) => d.summary.expected),
      showed: sum((d) => d.summary.showed),
      missed: sum((d) => d.summary.missed),
      open: sum((d) => d.summary.open),
      contractedHours: sum((d) => d.contract.contractedHours),
      deliveredHours: sum((d) => d.contract.deliveredHours),
      score: rangeGrade.score,
      grade: rangeGrade.grade,
    },
  };
}

/* ---- render ------------------------------------------------------------ */

const NAVY = '#0B1832';
const NAVY_SOFT = '#22355C';
const GOLD = '#C9A227';
const GREY = '#5B6472';
const LIGHT = '#9AA3B2';
const PANEL = '#F3F5F9';
const TRACK = '#E1E5EC';
const GOOD = '#1A7F4B';
const WARN = '#B45309';
const BAD = '#B42318';
const SCHEDULED = '#C9D2E3';

export function renderPortalReportPdf(data: PortalReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const where = data.storeName ?? data.clientName;
    const period = data.isRange ? `${data.from} — ${data.to}` : data.from;
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 48,
      bufferPages: true,
      info: { Title: `Service Report — ${where} — ${period}`, Author: data.orgName },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 26;
    const ensure = (needed: number) => {
      if (doc.y + needed > bottom()) {
        doc.addPage();
        doc.y = 54;
      }
    };
    const gradeTone = (g: ReportDay['contract']['grade']) => (g === 'A' || g === 'B' ? GOOD : g === 'F' ? BAD : NAVY);

    /* ---- letterhead ----------------------------------------------------- */
    doc.rect(0, 0, doc.page.width, 118).fill(NAVY);
    doc.rect(0, 118, doc.page.width, 3).fill(GOLD);
    doc.font('Helvetica-Bold').fontSize(21).fillColor('#FFFFFF').text(data.orgName, left, 34);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(GOLD)
      .text(data.isRange ? 'SERVICE REPORT · THE PERIOD, DAY BY DAY' : 'SERVICE REPORT · THE DAY AS THE PORTAL SHOWED IT', left, 60, {
        characterSpacing: 2,
      });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#FFFFFF').text(where, left, 34, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#C7CEDC')
      .text(data.isRange ? `${dayLabel(data.from)} — ${dayLabel(data.to)}` : dayLabel(data.from), left, 56, { width, align: 'right' })
      .text(`Prepared ${data.generatedAt}`, left, 70, { width, align: 'right' });
    const single = data.days.length === 1 ? data.days[0]! : null;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#8E99AD')
      .text(
        single?.isToday
          ? 'Your store site, as it stands right now — the same numbers the live page shows, frozen at the time above.'
          : single
            ? 'Your store site, as it stood that day — delivered against contract, coverage hour by hour, every shift wave with who was on the floor and when they punched.'
            : 'Each day of the period, as your store site showed it — delivered against contract, coverage hour by hour, and every shift wave with who was on the floor.',
        left,
        90,
        { width: width * 0.78 },
      );
    doc.y = 140;

    /* ---- helpers ------------------------------------------------------- */
    const section = (title: string, sub?: string) => {
      ensure(sub ? 58 : 46);
      const y = doc.y + 8;
      doc.rect(left, y + 1, 4, 11).fill(GOLD);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(title, left + 10, y);
      doc
        .moveTo(left, y + 18)
        .lineTo(right, y + 18)
        .lineWidth(0.5)
        .strokeColor(TRACK)
        .stroke();
      doc.y = y + 24;
      if (sub) {
        doc.font('Helvetica').fontSize(8).fillColor(LIGHT).text(sub, left, doc.y, { width });
        doc.y += 6;
      }
    };

    const kpiCards = (cards: Array<{ label: string; value: string; tone?: string; sub?: string }>) => {
      ensure(70);
      const gap = 8;
      const cardW = (width - gap * (cards.length - 1)) / cards.length;
      const cardH = 56;
      const y0 = doc.y;
      cards.forEach((k, i) => {
        const x = left + i * (cardW + gap);
        doc.roundedRect(x, y0, cardW, cardH, 5).fill(PANEL);
        doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT).text(k.label, x + 8, y0 + 8, { width: cardW - 16, characterSpacing: 0.4, lineBreak: false, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(17).fillColor(k.tone ?? NAVY).text(k.value, x + 8, y0 + 20, { width: cardW - 16, lineBreak: false });
        if (k.sub) doc.font('Helvetica').fontSize(7).fillColor(GREY).text(k.sub, x + 8, y0 + 41, { width: cardW - 16, lineBreak: false, ellipsis: true });
      });
      doc.y = y0 + cardH + 14;
    };

    const dayCards = (d: ReportDay) => {
      const c = d.contract;
      kpiCards([
        {
          label: c.basis === 'schedule' ? 'SHOWED VS SCHEDULED' : 'DELIVERED VS CONTRACT',
          value: c.score === null ? '—' : `${c.score}%${c.grade ? ` · ${c.grade}` : ''}`,
          tone: gradeTone(c.grade),
          sub:
            c.contractedHours > 0
              ? `${c.deliveredHours} of ${c.contractedHours} contracted person-hours`
              : c.basis === 'schedule'
                ? 'no floor target set — graded on the schedule'
                : d.isFuture
                  ? 'not yet — the day has not started'
                  : 'no graded hours yet',
        },
        {
          label: d.isToday ? 'ON THE FLOOR NOW' : d.isFuture ? 'EXPECTED' : 'ON THE FLOOR',
          value: d.isToday ? `${d.summary.onFloor}` : d.isFuture ? `${d.summary.expected}` : `${d.summary.showed} / ${d.summary.expected}`,
          tone: d.isFuture ? NAVY : d.summary.showed >= d.summary.expected ? GOOD : NAVY,
          sub: d.isToday ? `${d.summary.showed} of ${d.summary.expected} punched in so far` : d.isFuture ? 'assigned for the day' : 'punched in of expected',
        },
        {
          label: 'DID NOT PUNCH IN',
          value: String(d.summary.missed),
          tone: d.summary.missed > 0 ? BAD : GOOD,
          sub: d.summary.missed === 0 ? 'nobody missed' : 'shift ended, no punch',
        },
        {
          label: 'UNFILLED',
          value: String(d.summary.open),
          tone: d.summary.open > 0 ? WARN : GOOD,
          sub: d.summary.open === 0 ? 'every slot filled' : 'open slots that day',
        },
      ]);
    };

    /** The coverage curve: scheduled (grey), delivered (green), the
     *  contracted line (gold), one column per hour of the org day. */
    const hourChart = (d: ReportDay) => {
      const h = 96;
      ensure(h + 40);
      const y0 = doc.y;
      const axisW = 18;
      const plotX = left + axisW;
      const plotW = width - axisW;
      const slot = plotW / 24;
      const maxV = Math.max(1, ...d.hours.map((r) => Math.max(r.scheduled, r.target ?? 0, r.delivered ?? 0)));
      const yFor = (v: number) => y0 + h - (v / maxV) * h;
      // Grid
      doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT);
      for (const g of [0, Math.ceil(maxV / 2), maxV]) {
        const gy = yFor(g);
        doc.moveTo(plotX, gy).lineTo(right, gy).lineWidth(0.4).strokeColor(TRACK).stroke();
        doc.text(String(g), left, gy - 4, { width: axisW - 4, align: 'right' });
      }
      d.hours.forEach((r, i) => {
        const x = plotX + i * slot;
        if (r.scheduled > 0) doc.rect(x + 1, yFor(r.scheduled), slot - 2, y0 + h - yFor(r.scheduled)).fill(SCHEDULED);
        if (r.delivered !== null && r.delivered > 0) {
          const bw = Math.max(2, (slot - 2) * 0.55);
          doc.rect(x + 1 + ((slot - 2) - bw) / 2, yFor(r.delivered), bw, y0 + h - yFor(r.delivered)).fill(GOOD);
        }
      });
      // Contracted: a stepped gold line.
      doc.lineWidth(1.2).strokeColor(GOLD);
      let pen = false;
      d.hours.forEach((r, i) => {
        const x = plotX + i * slot;
        if (r.target === null) {
          pen = false;
          return;
        }
        const ty = yFor(r.target);
        if (!pen) {
          doc.moveTo(x, ty);
          pen = true;
        } else doc.lineTo(x, ty);
        doc.lineTo(x + slot, ty);
      });
      if (pen) doc.stroke();
      // Now marker on today's chart.
      if (d.isToday) {
        const nowH = zonedMinutes(new Date(), ORG_TZ) / 60;
        const nx = plotX + nowH * slot;
        doc.moveTo(nx, y0).lineTo(nx, y0 + h).lineWidth(0.8).dash(2, { space: 2 }).strokeColor(NAVY_SOFT).stroke().undash();
        doc.font('Helvetica').fontSize(6.5).fillColor(NAVY_SOFT).text('now', nx + 2, y0 + 2, { lineBreak: false });
      }
      // Axis labels every 3 hours.
      doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT);
      d.hours.forEach((r, i) => {
        if (i % 3 === 0) doc.text(r.label, plotX + i * slot, y0 + h + 3, { width: slot * 3, lineBreak: false });
      });
      // Legend
      const ly = y0 + h + 15;
      let lx = plotX;
      const legend = (color: string, label: string, line = false) => {
        if (line) doc.moveTo(lx, ly + 4).lineTo(lx + 10, ly + 4).lineWidth(1.2).strokeColor(color).stroke();
        else doc.rect(lx, ly, 8, 8).fill(color);
        doc.font('Helvetica').fontSize(6.5).fillColor(GREY).text(label, lx + 13, ly, { lineBreak: false });
        lx += 13 + doc.widthOfString(label) + 14;
      };
      legend(SCHEDULED, 'Scheduled');
      legend(GOOD, 'On the floor (punched)');
      legend(GOLD, 'Contracted', true);
      doc.y = ly + 18;
    };

    const punchLine = (p: ReportPerson): string => {
      const tz = p.timezone;
      switch (p.state) {
        case 'on-floor':
          return p.clockInAt ? `in ${formatTimeInZone(p.clockInAt, tz)}` : 'on the floor';
        case 'worked':
          return p.clockInAt
            ? p.clockOutAt
              ? `in ${formatTimeInZone(p.clockInAt, tz)} · out ${formatTimeInZone(p.clockOutAt, tz)}`
              : `in ${formatTimeInZone(p.clockInAt, tz)}`
            : 'worked';
        case 'missed':
          return 'no punch';
        case 'not-in':
          return 'not in yet';
        case 'confirmed':
          return 'confirmed';
        case 'unconfirmed':
          return 'not yet confirmed';
        default:
          return 'open';
      }
    };
    const toneFor = (key: ReportWave['groups'][number]['key']) =>
      key === 'in' ? GOOD : key === 'worked' ? GREY : key === 'missing' ? BAD : key === 'open' ? WARN : LIGHT;

    /** One face card: the medallion, the name, the position, the punch. */
    const faceCard = (p: ReportPerson, x: number, y: number, cw: number, ch: number, tone: string, multiStore: boolean) => {
      doc.roundedRect(x, y, cw, ch, 5).fill(PANEL);
      const avatar = 26;
      const ax = x + 7;
      const ay = y + (ch - avatar) / 2;
      let drew = false;
      if (p.photo) {
        try {
          doc.save();
          doc.circle(ax + avatar / 2, ay + avatar / 2, avatar / 2).clip();
          doc.image(p.photo, ax, ay, { width: avatar, height: avatar });
          doc.restore();
          drew = true;
        } catch {
          try {
            doc.restore();
          } catch {
            /* no dangling save */
          }
        }
      }
      if (!drew) {
        doc.circle(ax + avatar / 2, ay + avatar / 2, avatar / 2).fill(p.state === 'open' ? TRACK : NAVY_SOFT);
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(p.state === 'open' ? GREY : '#FFFFFF')
          .text(p.initials, ax, ay + 8, { width: avatar, align: 'center', lineBreak: false });
      }
      // Status ring
      doc.circle(ax + avatar / 2, ay + avatar / 2, avatar / 2 + 1.2).lineWidth(1.4).strokeColor(tone).stroke();
      const tx = ax + avatar + 7;
      const tw = cw - (tx - x) - 6;
      doc
        .font('Helvetica-Bold')
        .fontSize(7.8)
        .fillColor(p.state === 'open' ? WARN : NAVY)
        .text(p.state === 'open' ? 'OPEN' : (p.name ?? '—'), tx, y + 6, { width: tw, lineBreak: false, ellipsis: true });
      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(GREY)
        .text(`${p.position}${p.isLead ? ' · Lead' : ''}${multiStore && p.locationName ? ` · ${p.locationName}` : ''}`, tx, y + 16, {
          width: tw,
          lineBreak: false,
          ellipsis: true,
        });
      doc.font('Helvetica').fontSize(6.8).fillColor(tone).text(punchLine(p), tx, y + 25, { width: tw, lineBreak: false, ellipsis: true });
    };

    const waveBlock = (w: ReportWave, multiStore: boolean) => {
      ensure(60);
      const y = doc.y + 6;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text(`${w.name} · ${w.timeRange}`, left, y, { lineBreak: false });
      const status =
        w.phase === 'finished'
          ? `${w.present} of ${w.expected} on the floor${w.open > 0 ? ` · ${w.open} unfilled` : ''}`
          : w.phase === 'live'
            ? `${w.onFloor} of ${w.expected} in${w.open > 0 ? ` · ${w.open} unfilled` : ''}`
            : `starts ${formatTimeInZone(w.startsAt, w.timezone)} · ${w.expected} expected${w.open > 0 ? ` · ${w.open} unfilled` : ''}`;
      const statusTone = w.phase === 'upcoming' ? GREY : w.present + w.onFloor >= w.expected && w.open === 0 ? GOOD : w.missed > 0 || w.open > 0 ? WARN : NAVY;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(statusTone).text(status, left, y + 2, { width, align: 'right', lineBreak: false });
      // Meter
      const my = y + 16;
      doc.roundedRect(left, my, width, 4, 2).fill(TRACK);
      const denom = Math.max(1, w.expected + w.open);
      const filled = (width * (w.present + w.onFloor)) / denom;
      if (filled > 0) doc.roundedRect(left, my, Math.max(filled, 3), 4, 2).fill(w.phase === 'upcoming' ? LIGHT : GOOD);
      doc.y = my + 12;
      const cols = 3;
      const gap = 6;
      const cw = (width - gap * (cols - 1)) / cols;
      const ch = 36;
      for (const g of w.groups) {
        ensure(ch + 22);
        doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT).text(`${g.label.toUpperCase()}  ${g.people.length}`, left, doc.y + 2, { characterSpacing: 0.6 });
        doc.y += 12;
        for (let i = 0; i < g.people.length; i += cols) {
          ensure(ch + 6);
          const rowY = doc.y;
          g.people.slice(i, i + cols).forEach((p, col) => {
            faceCard(p, left + col * (cw + gap), rowY, cw, ch, toneFor(g.key), multiStore);
          });
          doc.y = rowY + ch + 5;
        }
        doc.y += 2;
      }
      doc.y += 4;
    };

    const dayBody = (d: ReportDay) => {
      section(d.isToday ? 'The day so far' : 'The day at a glance');
      dayCards(d);
      section('Coverage, hour by hour', 'People on the floor with punch evidence against the contracted headcount, one column per hour.');
      hourChart(d);
      if (d.waves.length === 0) {
        section('Shifts');
        doc.font('Helvetica').fontSize(9).fillColor(LIGHT).text('Nothing scheduled this day.', left, doc.y, { width });
        doc.y += 14;
      } else {
        section(
          `Shifts · ${d.waves.length} ${d.waves.length === 1 ? 'wave' : 'waves'}`,
          'Every shift wave of the day — who was on the floor and when they punched. Names and punch times are the record; there is no “late” label here, only what happened.',
        );
        for (const w of d.waves) waveBlock(w, d.multiStore);
      }
      if (d.requests.length > 0) {
        section(`Requests logged · ${d.requests.length}`);
        for (const r of d.requests) {
          ensure(14);
          const y = doc.y;
          doc.font('Helvetica').fontSize(8).fillColor(GREY).text(r.at, left, y, { width: 60, lineBreak: false });
          doc.font('Helvetica-Bold').fillColor(NAVY).text(r.kind, left + 64, y, { width: 70, lineBreak: false });
          doc.font('Helvetica').fillColor(NAVY).text(r.subject, left + 140, y, { width: width - 240, lineBreak: false, ellipsis: true });
          doc.fillColor(r.status === 'RESOLVED' ? GOOD : GREY).text(r.status.replace('_', ' ').toLowerCase(), right - 90, y, { width: 90, align: 'right', lineBreak: false });
          doc.y = y + 13;
        }
      }
    };

    /* ---- the period at a glance (range only) --------------------------- */
    if (data.isRange) {
      section('The period at a glance');
      const tt = data.totals;
      kpiCards([
        {
          label: 'DELIVERED VS CONTRACT',
          value: tt.score === null ? '—' : `${tt.score}%${tt.grade ? ` · ${tt.grade}` : ''}`,
          tone: gradeTone(tt.grade),
          sub: tt.contractedHours > 0 ? `${tt.deliveredHours} of ${tt.contractedHours} person-hours` : 'no contracted hours in the period',
        },
        { label: 'ON THE FLOOR', value: `${tt.showed} / ${tt.expected}`, tone: tt.showed >= tt.expected ? GOOD : NAVY, sub: 'punched in of expected' },
        { label: 'DID NOT PUNCH IN', value: String(tt.missed), tone: tt.missed > 0 ? BAD : GOOD, sub: tt.missed === 0 ? 'nobody missed' : 'shifts ended with no punch' },
        { label: 'UNFILLED', value: String(tt.open), tone: tt.open > 0 ? WARN : GOOD, sub: tt.open === 0 ? 'every slot filled' : 'open slots in the period' },
      ]);
      section('Day by day', 'Each row is one day, as its own page below.');
      {
        const rowH = 17;
        const nameW = 92;
        const numW = 46;
        const barX = left + nameW + 6;
        const barW = width - nameW - numW * 4 - 30;
        doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT);
        doc.text('DAY', left, doc.y, { characterSpacing: 0.6 });
        doc.text('DELIVERED VS CONTRACTED', barX, doc.y, { characterSpacing: 0.6 });
        doc.text('ON FLOOR', barX + barW + 8, doc.y, { width: numW, align: 'right' });
        doc.text('NO PUNCH', barX + barW + 8 + numW, doc.y, { width: numW, align: 'right' });
        doc.text('UNFILLED', barX + barW + 8 + numW * 2, doc.y, { width: numW, align: 'right' });
        doc.text('GRADE', barX + barW + 8 + numW * 3, doc.y, { width: numW, align: 'right' });
        doc.y += 11;
        for (const d of data.days) {
          ensure(rowH + 2);
          const y = doc.y;
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(shortDay(d.key), left, y + 3, { width: nameW, lineBreak: false });
          doc.roundedRect(barX, y + 3, barW, 8, 4).fill(TRACK);
          const score = d.contract.score;
          if (score !== null && score > 0) {
            doc.roundedRect(barX, y + 3, Math.max(4, (barW * Math.min(100, score)) / 100), 8, 4).fill(gradeTone(d.contract.grade));
          }
          doc.font('Helvetica').fontSize(7).fillColor(GREY).text(score === null ? (d.isFuture ? 'upcoming' : 'no graded hours') : `${score}%`, barX + barW - 60, y + 3, {
            width: 58,
            align: 'right',
            lineBreak: false,
          });
          doc.font('Helvetica').fontSize(8.5).fillColor(NAVY);
          doc.text(`${d.summary.showed}/${d.summary.expected}`, barX + barW + 8, y + 3, { width: numW, align: 'right' });
          doc.fillColor(d.summary.missed > 0 ? BAD : LIGHT).text(String(d.summary.missed), barX + barW + 8 + numW, y + 3, { width: numW, align: 'right' });
          doc.fillColor(d.summary.open > 0 ? WARN : LIGHT).text(String(d.summary.open), barX + barW + 8 + numW * 2, y + 3, { width: numW, align: 'right' });
          doc
            .font('Helvetica-Bold')
            .fillColor(gradeTone(d.contract.grade))
            .text(d.contract.grade ?? '—', barX + barW + 8 + numW * 3, y + 3, { width: numW, align: 'right' });
          doc.y = y + rowH;
        }
      }
      for (const d of data.days) {
        doc.addPage();
        doc.y = 54;
        // Day band
        const by = doc.y;
        doc.roundedRect(left, by, width, 40, 6).fill(NAVY);
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#FFFFFF').text(d.label, left + 12, by + 9, { lineBreak: false });
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(GOLD)
          .text(
            d.isFuture
              ? `${d.summary.expected} expected · ${d.summary.open} unfilled`
              : `${d.summary.showed} of ${d.summary.expected} on the floor · ${d.summary.missed} did not punch in · ${d.summary.open} unfilled`,
            left + 12,
            by + 25,
            { lineBreak: false },
          );
        if (d.contract.grade) {
          doc.font('Helvetica-Bold').fontSize(18).fillColor(gradeTone(d.contract.grade) === NAVY ? '#FFFFFF' : gradeTone(d.contract.grade)).text(d.contract.grade, left, by + 10, {
            width: width - 12,
            align: 'right',
            lineBreak: false,
          });
        }
        doc.y = by + 48;
        dayBody(d);
      }
    } else {
      dayBody(data.days[0]!);
    }

    /* ---- footer on every page ------------------------------------------ */
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .moveTo(left, doc.page.height - 48)
        .lineTo(right, doc.page.height - 48)
        .lineWidth(0.5)
        .strokeColor(GOLD)
        .stroke();
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(LIGHT)
        .text(`${data.orgName} · Service Report · ${where} · ${period} · Confidential · page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - 40, {
          width,
          align: 'center',
          lineBreak: false,
        });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}
