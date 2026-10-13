import PDFDocument from 'pdfkit';
import { RECRUITING_CHANNEL_LABELS, type SeasonPlanComputed, type SeasonPlanSiteComputed } from '@alto-people/shared';
import { C, CONTENT_BOTTOM, CONTENT_TOP, GAP, M, PAD, PAGE_W, T, W, colW, pdfHelpers, pdfSafe } from './pdfDesign.js';
import { stamp } from './opsPacket.js';

/**
 * The per-store season plan, printed — in the same house style as the
 * Store Operations Report (one grid, five type sizes, one data colour,
 * judgement colours only for judgements, brand gold only on the masthead):
 * the figures, the arithmetic in one paragraph, the week-by-week table,
 * the gaps, the recruiting targets.
 */

const num = (v: number) => v.toLocaleString('en-US');
const LABEL = { size: T.label, caps: true, bold: true, color: C.ink3 } as const;
const weekLabel = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function renderSeasonPlanSitePdf(plan: SeasonPlanComputed, site: SeasonPlanSiteComputed, orgName = 'Alto HR', generatedAt = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 0,
      bufferPages: true,
      info: { Title: pdfSafe(`Season Plan — ${site.siteName} — ${plan.name}`), Author: pdfSafe(orgName) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const { text, textRight, para, paraH, hr, rect, fitLine } = pdfHelpers(doc);

    let y = 0;
    let pages = 0;
    const MASTHEAD_H = 132;
    const newPage = () => {
      if (pages > 0) doc.addPage();
      pages += 1;
      y = pages === 1 ? MASTHEAD_H + 22 : CONTENT_TOP;
    };
    const need = (h: number) => {
      if (y + h > CONTENT_BOTTOM) newPage();
    };
    const block = (h: number, draw: (x: number, yy: number, w: number) => void) => {
      need(h);
      draw(M, y, W);
      y += h;
    };
    const gap = (h = GAP) => {
      y += h;
    };
    const section = (title: string, note?: string) => {
      need(15 + 8 + 40);
      text(title, M, y, { size: T.title, bold: true });
      if (note) textRight(note, M + W, y + 3, { size: T.label, color: C.ink3 });
      y += 15;
      hr(M, y, W);
      y += 9;
    };

    /* ---- masthead ---------------------------------------------------- */
    newPage();
    rect(0, 0, PAGE_W, MASTHEAD_H, C.ink);
    text(orgName, M, 26, { size: T.label, caps: true, bold: true, color: C.brand });
    text('Season Plan', M, 42, { size: 24, bold: true, color: C.white });
    text(fitLine(`${site.siteName} · ${site.clientName}`, W, { size: T.title }), M, 74, { size: T.title, color: C.white });
    text(`${longDate(plan.seasonStart)} – ${longDate(plan.seasonEnd)} · ${plan.weeks.length} weeks`, M, 92, { size: T.body, color: C.mastSub });
    text(`Scenario: ${plan.name}`, M, 106, { size: T.label, color: C.mastSub });
    textRight(`Prepared for ${site.clientName}`, PAGE_W - M, 92, { size: T.body, color: C.mastSub });
    textRight(`Generated ${stamp(generatedAt)}`, PAGE_W - M, 106, { size: T.label, color: C.mastSub });

    /* ---- the figures --------------------------------------------------- */
    const peakRow = site.weeks.find((w) => w.week === site.peak.week) ?? site.weeks[0];
    const worstSeats = site.weeks.reduce((b, w) => (w.vanSeatsGap > (b?.vanSeatsGap ?? -1) ? w : b), site.weeks[0]);
    const kpis: Array<{ label: string; value: string; sub: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = [
      { label: 'Peak on the floor', value: num(site.peak.daily), sub: `a day, week of ${weekLabel(site.peak.week)}`, tone: 'neutral' },
      { label: 'Associates needed', value: num(site.peak.associatesNeeded), sub: `${plan.targetHoursPerWeek} h weeks, ${plan.shiftHours} h shifts, ${plan.reservePct}% reserve`, tone: 'neutral' },
      { label: 'Beds', value: `${num(site.peak.bedsNeeded)} / ${num(site.bedsAvailable)}`, sub: peakRow && peakRow.bedsGap > 0 ? `${num(peakRow.bedsGap)} short at peak` : 'needed / available — covered', tone: peakRow && peakRow.bedsGap > 0 ? 'bad' : 'good' },
      { label: 'Van seats per shift', value: `${num(site.peak.vanSeatsNeeded)} / ${num(site.vanSeatsPerRun * site.runsPerShift)}`, sub: worstSeats && worstSeats.vanSeatsGap > 0 ? `${num(worstSeats.vanSeatsGap)} short, week of ${weekLabel(worstSeats.week)}` : `${site.runsPerShift} run${site.runsPerShift === 1 ? '' : 's'} × ${site.vanSeatsPerRun} seats · ${site.routeMinutes} min route`, tone: worstSeats && worstSeats.vanSeatsGap > 0 ? 'warn' : 'good' },
      { label: 'Active today', value: num(site.weeks.find((w) => w.activeHeadcount !== null)?.activeHeadcount ?? 0), sub: 'associates by the one definition', tone: 'neutral' },
      { label: 'Shift slots a week', value: num(peakRow?.shiftSlots ?? 0), sub: 'at peak: floor headcount × 7', tone: 'neutral' },
    ];
    const toneColor = (t: string) => (t === 'good' ? C.good : t === 'warn' ? C.warn : t === 'bad' ? C.bad : C.ink);
    const tileW = colW(4);
    const tileH = 70;
    for (let row = 0; row < 2; row++) {
      block(tileH, (x, yy) => {
        kpis.slice(row * 3, row * 3 + 3).forEach((k, i) => {
          const tx = x + (tileW + GAP) * i;
          rect(tx, yy, tileW, tileH, C.wash);
          rect(tx, yy, 2.5, tileH, toneColor(k.tone));
          text(k.label, tx + PAD, yy + 10, LABEL);
          text(k.value, tx + PAD, yy + 20, { size: T.figure, bold: true, color: toneColor(k.tone) });
          text(fitLine(k.sub, tileW - PAD * 2, { size: T.label }), tx + PAD, yy + tileH - PAD - 4, { size: T.label, color: C.ink3 });
        });
      });
      gap(row === 0 ? GAP : GAP + 4);
    }

    /* ---- in one paragraph -------------------------------------------- */
    const shiftsPerPerson = plan.targetHoursPerWeek / plan.shiftHours;
    const verdict =
      `${site.siteName} needs ${num(site.peak.daily)} people on the floor a day at its peak (week of ${weekLabel(site.peak.week)}): ` +
      `${num(site.peak.daily)} × 7 days = ${num(peakRow?.shiftSlots ?? 0)} shift slots, ÷ ${shiftsPerPerson} shifts per person per week = ${num(Math.ceil((peakRow?.shiftSlots ?? 0) / shiftsPerPerson))}, ` +
      `plus ${plan.reservePct}% reserve = ${num(site.peak.associatesNeeded)} associates. ` +
      (peakRow && peakRow.bedsGap > 0 ? `Housing covers ${num(site.bedsAvailable)} of the ${num(site.peak.bedsNeeded)} beds that mix needs — ${num(peakRow.bedsGap)} short. ` : `Housing covers the ${num(site.peak.bedsNeeded)} beds that mix needs. `) +
      (worstSeats && worstSeats.vanSeatsGap > 0 ? `The vans are ${num(worstSeats.vanSeatsGap)} seats short on the biggest shift.` : 'The vans carry the biggest shift.');
    const vh = paraH(verdict, W, { size: T.body });
    block(vh + 4, (x, yy, w) => para(verdict, x, yy, w, { size: T.body, color: C.ink2 }));
    gap(GAP + 4);

    /* ---- week by week ------------------------------------------------ */
    section('Week by week', 'floor headcount per shift, and what it takes');
    const cols = [
      { label: 'WEEK OF', w: 62, align: 'left' as const },
      { label: 'DAY', w: 42, align: 'right' as const },
      { label: 'EVENING', w: 50, align: 'right' as const },
      { label: 'OVERNIGHT', w: 58, align: 'right' as const },
      { label: 'ON FLOOR', w: 52, align: 'right' as const },
      { label: 'ASSOCIATES', w: 62, align: 'right' as const },
      { label: 'BEDS', w: 62, align: 'right' as const },
      { label: 'VAN SEATS', w: 62, align: 'right' as const },
      { label: 'SCHEDULED H', w: 0, align: 'right' as const },
    ];
    const fixed = cols.reduce((a, c) => a + c.w, 0);
    cols[cols.length - 1]!.w = W - fixed;
    const colX = (i: number) => M + cols.slice(0, i).reduce((a, c) => a + c.w, 0);
    const cellText = (s: string, i: number, yy: number, st: Record<string, unknown> = {}) => {
      const c = cols[i]!;
      if (c.align === 'right') textRight(s, colX(i) + c.w - 4, yy, { size: T.body, ...st });
      else text(s, colX(i), yy, { size: T.body, ...st });
    };
    block(16, (_x, yy) => {
      cols.forEach((c, i) => cellText(c.label, i, yy, { size: T.label, bold: true, color: C.ink3 }));
      hr(M, yy + 12, W, C.ink3, 0.5);
    });
    for (const w of site.weeks) {
      block(16, (_x, yy) => {
        const isPeak = w.week === site.peak.week;
        if (isPeak) rect(M, yy - 3, W, 16, C.wash);
        cellText(weekLabel(w.week), 0, yy, { bold: isPeak });
        cellText(num(w.day), 1, yy);
        cellText(num(w.evening), 2, yy);
        cellText(num(w.overnight), 3, yy);
        cellText(num(w.daily), 4, yy, { bold: true });
        cellText(num(w.associatesNeeded), 5, yy, { bold: true, color: C.data });
        cellText(`${num(w.bedsNeeded)}${w.bedsGap > 0 ? ` (−${num(w.bedsGap)})` : ''}`, 6, yy, { color: w.bedsGap > 0 ? C.bad : C.ink });
        cellText(`${num(w.vanSeatsNeeded)}${w.vanSeatsGap > 0 ? ` (−${num(w.vanSeatsGap)})` : ''}`, 7, yy, { color: w.vanSeatsGap > 0 ? C.warn : C.ink });
        cellText(w.scheduledHours === null ? '—' : num(Math.round(w.scheduledHours)), 8, yy, { color: C.ink2 });
        hr(M, yy + 12, W, C.rule, 0.5);
      });
    }
    gap(GAP + 4);

    /* ---- gaps -------------------------------------------------------- */
    const gaps = plan.gaps.filter((g) => g.siteName === site.siteName || g.kind === 'RECRUITING');
    section('Every shortfall, named', `${gaps.length} gap${gaps.length === 1 ? '' : 's'}`);
    if (gaps.length === 0) {
      block(16, (x, yy) => text('No shortfall at this store with the inputs as entered.', x, yy, { size: T.body, color: C.ink2 }));
    }
    gaps.forEach((g, i) => {
      const bodyH = paraH(g.text, W - PAD * 2 - 22, { size: T.body });
      const h = PAD + bodyH + PAD;
      block(h, (x, yy, w) => {
        rect(x, yy, w, h, C.wash);
        rect(x, yy, 2.5, h, g.kind === 'BEDS' || g.kind === 'HEADCOUNT' ? C.bad : C.warn);
        text(`${i + 1}`, x + PAD, yy + PAD - 2, { size: T.figure, bold: true, color: g.kind === 'BEDS' || g.kind === 'HEADCOUNT' ? C.bad : C.warn });
        para(g.text, x + PAD + 22, yy + PAD, w - PAD * 2 - 22, { size: T.body, color: C.ink2 });
      });
      gap(6);
    });
    gap(GAP);

    /* ---- recruiting ----------------------------------------------------- */
    section('Recruiting targets', 'the plan-wide peak, split by channel, with the date each must be in hand');
    block(16, (x, yy) => {
      text('CHANNEL', x, yy, LABEL);
      textRight('SHARE', x + 300, yy, LABEL);
      textRight('TARGET', x + 370, yy, LABEL);
      textRight('ON THE BOOKS', x + 450, yy, LABEL);
      textRight('RECRUIT BY', x + W, yy, LABEL);
      hr(x, yy + 12, W, C.ink3, 0.5);
    });
    for (const r of plan.recruiting) {
      block(16, (x, yy) => {
        text(RECRUITING_CHANNEL_LABELS[r.channel], x, yy, { size: T.body });
        textRight(`${r.sharePct}%`, x + 300, yy, { size: T.body, color: C.ink2 });
        textRight(num(r.target), x + 370, yy, { size: T.body, bold: true, color: C.data });
        textRight(num(r.pipeline), x + 450, yy, { size: T.body, color: r.gap > 0 ? C.bad : C.good });
        textRight(longDate(r.recruitBy), x + W, yy, { size: T.body, color: C.ink2 });
        hr(x, yy + 12, W, C.rule, 0.5);
      });
    }

    /* ---- footer on every page ---------------------------------------- */
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      hr(M, CONTENT_BOTTOM + 14, W, C.rule, 0.5);
      text(`Confidential · Prepared for ${site.clientName} by ${orgName} · counts are planning figures`, M, CONTENT_BOTTOM + 20, { size: 7, color: C.ink3 });
      textRight(`Page ${i - range.start + 1} of ${range.count}`, M + W, CONTENT_BOTTOM + 20, { size: 7, color: C.ink3 });
    }
    doc.end();
  });
}
