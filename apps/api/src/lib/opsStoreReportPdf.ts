import PDFDocument from 'pdfkit';
import {
  C,
  colW,
  CONTENT_BOTTOM,
  CONTENT_TOP,
  GAP,
  M,
  PAD,
  PAGE_H,
  PAGE_W,
  T,
  W,
  pdfHelpers,
  pdfSafe,
} from './pdfDesign.js';
import { periodLabel, shortStamp, stamp } from './opsPacket.js';
import { metricLabel } from './opsPacketPdf.js';
import { hourLabel, type OpsStoreReport, type Tone } from './opsStoreReport.js';

/**
 * The Store Operations Report, printed.
 *
 * Same house style as every client-facing PDF (pdfDesign): one grid, five
 * type sizes, one data colour, judgement colours only for judgements,
 * brand gold only on the masthead. What is new here is that the evidence
 * is DRAWN — a department-by-shift grid, a day-by-day bar, each
 * temperature reading against its band, production against its mean, the
 * handover disposition as one bar — and that the last page is a plan, not
 * a table.
 */

const LABEL = { size: T.label, caps: true, bold: true, color: C.ink3 } as const;
const num = (v: number) => v.toLocaleString('en-US');
const tone = (t: Tone) => (t === 'good' ? C.good : t === 'warn' ? C.warn : t === 'bad' ? C.bad : C.ink);
const gradeColor = (v: number | null) => (v == null ? C.ink3 : v >= 95 ? C.good : v >= 85 ? C.warn : C.bad);
const shortDay = (key: string) =>
  new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const weekday = (key: string) =>
  new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

export function renderOpsStoreReportPdf(r: OpsStoreReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const where = r.store?.name ?? r.clientName;
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 0,
      bufferPages: true,
      info: {
        Title: pdfSafe(`Store Operations Report — ${where} — ${r.periodLabel}`),
        Author: pdfSafe(r.orgName),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const { text, textRight, textCenter, para, paraH, hr, rect, fitLine, widthOf } = pdfHelpers(doc);

    /* ---- paging ------------------------------------------------------ */
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
    const dashed = (x1: number, y1: number, x2: number, y2: number, color = C.ink3) => {
      doc.save().lineWidth(0.75).strokeColor(color).dash(2, { space: 2 }).moveTo(x1, y1).lineTo(x2, y2).stroke().undash().restore();
    };
    const tint = (x: number, yy: number, w: number, h: number, color: string, opacity = 0.16) => {
      doc.save().fillOpacity(opacity).rect(x, yy, w, h).fill(color).restore();
    };
    const dot = (cx: number, cy: number, rad: number, color: string) => {
      doc.save().circle(cx, cy, rad).fill(color).restore();
      doc.save().lineWidth(1).strokeColor(C.white).circle(cx, cy, rad).stroke().restore();
    };

    /**
     * A bar chart: values on a 0..max scale, one bar per label, a dashed
     * mean line when asked, the day label under each bar, the value above
     * it when there is room. Thin bars, rounded tops, one colour.
     */
    const bars = (
      x: number,
      yy: number,
      w: number,
      h: number,
      series: { label: string; sub?: string; value: number | null; color?: string }[],
      opts: { max?: number; mean?: number | null; unit?: string; pct?: boolean } = {},
    ) => {
      const plotH = h - 26;
      const max = Math.max(opts.max ?? 0, ...series.map((s) => s.value ?? 0), 1);
      const n = Math.max(series.length, 1);
      // The average's label lives in a gutter past the last bar, so it can
      // never sit on top of that bar's own value.
      const hasMean = opts.mean != null && opts.mean > 0;
      const plotW = hasMean ? w - 40 : w;
      const slot = plotW / n;
      const bw = Math.min(28, Math.max(6, slot * 0.55));
      hr(x, yy + plotH, w, C.rule);
      if (hasMean) {
        const my = yy + plotH - (plotH * Math.min(opts.mean!, max)) / max;
        dashed(x, my, x + w, my);
        textRight(`avg ${opts.pct ? `${Math.round(opts.mean!)}%` : num(Math.round(opts.mean!))}`, x + w, my - 9, {
          size: T.label,
          color: C.ink3,
        });
      }
      series.forEach((s, i) => {
        const cx = x + slot * i + slot / 2;
        if (s.value != null) {
          const bh = Math.max(1.5, (plotH * Math.min(s.value, max)) / max);
          doc.save().roundedRect(cx - bw / 2, yy + plotH - bh, bw, bh, 2).fill(s.color ?? C.data).restore();
          if (slot >= 26) {
            const v = opts.pct ? `${Math.round(s.value)}%` : num(Math.round(s.value));
            textCenter(v, cx, yy + plotH - bh - 10, { size: T.label, color: C.ink2 });
          }
        } else {
          textCenter('—', cx, yy + plotH - 12, { size: T.label, color: C.ink3 });
        }
        if (slot >= 20) {
          textCenter(fitLine(s.label, slot - 2, { size: T.label }), cx, yy + plotH + 5, { size: T.label, color: C.ink2 });
          if (s.sub && slot >= 30) textCenter(s.sub, cx, yy + plotH + 14, { size: 7, color: C.ink3 });
        }
      });
    };

    /* ---- masthead ---------------------------------------------------- */
    newPage();
    rect(0, 0, PAGE_W, MASTHEAD_H, C.ink);
    text(r.orgName, M, 26, { size: T.label, caps: true, bold: true, color: C.brand });
    text('Store Operations Report', M, 42, { size: 24, bold: true, color: C.white });
    text(fitLine(r.store ? `${r.store.name} · ${r.clientName}` : `${r.clientName} · every store`, W, { size: T.title }), M, 74, {
      size: T.title,
      color: C.white,
    });
    text(r.periodLabel, M, 92, { size: T.body, color: C.mastSub });
    if (r.priorLabel) text(`Compared with ${r.priorLabel}`, M, 106, { size: T.label, color: C.mastSub });
    textRight(`Prepared for ${r.clientName}`, PAGE_W - M, 92, { size: T.body, color: C.mastSub });
    textRight(`Generated ${stamp(r.generatedAt)}`, PAGE_W - M, 106, { size: T.label, color: C.mastSub });

    /* ================= 1. THE FIGURES ================================= */
    const tileW = colW(4);
    const tileH = 70;
    for (let row = 0; row < 2; row++) {
      block(tileH, (x, yy) => {
        r.kpis.slice(row * 3, row * 3 + 3).forEach((k, i) => {
          const tx = x + (tileW + GAP) * i;
          rect(tx, yy, tileW, tileH, C.wash);
          rect(tx, yy, 2.5, tileH, tone(k.tone));
          text(k.label, tx + PAD, yy + 10, LABEL);
          text(k.value, tx + PAD, yy + 20, { size: T.figure, bold: true, color: tone(k.tone) });
          if (k.delta) textRight(fitLine(k.delta, tileW / 2, { size: T.label }), tx + tileW - PAD, yy + 27, { size: T.label, color: C.ink2 });
          if (k.sub) text(fitLine(k.sub, tileW - PAD * 2, { size: T.label }), tx + PAD, yy + tileH - PAD - 4, { size: T.label, color: C.ink3 });
        });
      });
      gap(row === 0 ? GAP : GAP + 4);
    }

    /* ================= 2. IN ONE PARAGRAPH ============================ */
    const p = r.packet;
    const rr = p.rollup;
    const verdict = (() => {
      const parts: string[] = [];
      if (rr.shifts === 0) {
        return `No operations shifts were recorded for ${where} between ${r.periodLabel}. Either none ran, or they ran without an SOP open — which is itself the finding: there is no record of the work.`;
      }
      parts.push(
        `${where} ran ${num(rr.shifts)} supervised shift${rr.shifts === 1 ? '' : 's'} over ${r.days.length} day${r.days.length === 1 ? '' : 's'} and completed ${rr.sopPct == null ? 'no measured' : `${rr.sopPct}% of`} required SOP items` +
          (r.prior && r.prior.rollup.sopPct != null && rr.sopPct != null
            ? `, ${rr.sopPct >= r.prior.rollup.sopPct ? 'up' : 'down'} from ${r.prior.rollup.sopPct}% the period before.`
            : '.'),
      );
      if (rr.tempChecks > 0) {
        parts.push(
          rr.tempOutOfRange === 0
            ? `All ${num(rr.tempChecks)} temperature readings held their range.`
            : `${num(rr.tempOutOfRange)} of ${num(rr.tempChecks)} temperature readings fell outside their range; each is on the Food safety page with the re-check that closed it.`,
        );
      }
      if (rr.incomplete > 0) parts.push(`${num(rr.incomplete)} shift${rr.incomplete === 1 ? ' was' : 's were'} submitted incomplete with a written reason.`);
      if (rr.stillOpen > 0) parts.push(`${num(rr.stillOpen)} ${rr.stillOpen === 1 ? 'shift has' : 'shifts have'} not been submitted.`);
      if (r.planned.expected > rr.shifts) parts.push(`${num(r.planned.expected - rr.shifts)} planned store shift${r.planned.expected - rr.shifts === 1 ? '' : 's'} left no SOP record.`);
      parts.push('The last page says what to plan for.');
      return parts.join(' ');
    })();
    const vH = paraH(verdict, W - PAD * 2, { size: T.body, color: C.ink2 });
    block(vH + PAD * 2, (x, yy, w) => {
      rect(x, yy, 2.5, vH + PAD * 2, C.brand);
      para(verdict, x + PAD, yy + PAD, w - PAD * 2, { size: T.body, color: C.ink2 });
    });
    gap(GAP + 4);

    /* ================= 3. DEPARTMENT BY SHIFT ========================= */
    if (r.grid.cells.length > 0) {
      section('Department by shift', 'SOP completion, with the shifts behind each cell');
      const nameW = colW(3);
      const cellW = (W - nameW - GAP * r.grid.periods.length) / Math.max(r.grid.periods.length, 1);
      const rowH = 34;
      block(16, (x, yy) => {
        r.grid.periods.forEach((per, i) => {
          text(periodLabel(per), x + nameW + GAP + (cellW + GAP) * i, yy, LABEL);
        });
        hr(x, yy + 12, W, C.ink3, 0.5);
      });
      for (const dept of r.grid.departments) {
        block(rowH, (x, yy) => {
          text(fitLine(dept, nameW - 4, { size: T.body, bold: true }), x, yy + 11, { size: T.body, bold: true });
          r.grid.periods.forEach((per, i) => {
            const cx = x + nameW + GAP + (cellW + GAP) * i;
            const c = r.grid.cells.find((z) => z.department === dept && z.period === per);
            if (!c) {
              rect(cx, yy + 2, cellW, rowH - 6, C.wash);
              textCenter('—', cx + cellW / 2, yy + 12, { size: T.label, color: C.ink3 });
              return;
            }
            const g = gradeColor(c.sopPct);
            rect(cx, yy + 2, cellW, rowH - 6, C.wash);
            tint(cx, yy + 2, cellW, rowH - 6, g, c.sopPct == null ? 0 : 0.18);
            text(c.sopPct == null ? '—' : `${c.sopPct}%`, cx + 8, yy + 6, { size: T.title, bold: true, color: g });
            const meta = [`${c.shifts} shift${c.shifts === 1 ? '' : 's'}`, c.incomplete ? `${c.incomplete} incomplete` : null, c.tempAlerts ? `${c.tempAlerts} temp` : null, c.unsubmitted ? `${c.unsubmitted} unsubmitted` : null]
              .filter(Boolean)
              .join(' · ');
            text(fitLine(meta, cellW - 16, { size: 7 }), cx + 8, yy + 20, { size: 7, color: C.ink2 });
          });
          hr(x, yy + rowH - 1, W, C.rule);
        });
      }
      gap();
    }

    /* ================= 4. DAY BY DAY ================================== */
    if (r.days.length > 1 && p.byDay.length > 0) {
      section('Day by day', 'SOP completion each day · dashed line is the period average');
      const byKey = new Map(p.byDay.map((d) => [d.dateKey, d]));
      const series = r.days.map((d) => {
        const row = byKey.get(d);
        const flags = row ? [row.incomplete ? `${row.incomplete} inc` : null, row.tempAlerts ? `${row.tempAlerts} temp` : null].filter(Boolean).join(' ') : '';
        return { label: r.days.length > 14 ? shortDay(d).replace(/^\w+ /, '') : `${weekday(d)} ${shortDay(d).split(' ')[1]}`, sub: flags || undefined, value: row?.sopPct ?? null, color: row ? gradeColor(row.sopPct) : undefined };
      });
      const chartH = 118;
      block(chartH, (x, yy, w) => bars(x, yy, w, chartH, series, { max: 100, mean: rr.sopPct, pct: true }));
      gap();
    }

    /* ================= 5. FOOD SAFETY ================================= */
    if (r.temps.length > 0) {
      const outs = r.temps.filter((t) => t.out);
      section('Food safety', `${num(r.temps.length)} readings · ${num(outs.length)} out of range`);
      const cols = [colW(2), colW(4), colW(3), colW(1), colW(2)];
      const head = () => {
        block(16, (x, yy) => {
          let cx = x;
          ['WHEN', 'ITEM', 'AGAINST ITS RANGE', 'READ', 'RE-CHECK'].forEach((h, i) => {
            text(h, cx, yy, LABEL);
            cx += cols[i]! + GAP;
          });
          hr(x, yy + 12, W, C.ink3, 0.5);
        });
      };
      head();
      const rows = [...outs, ...r.temps.filter((t) => !t.out)].slice(0, 48);
      for (const t of rows) {
        const rowH = 22;
        const before = pages;
        need(rowH);
        if (pages !== before) head();
        const x = M;
        let cx = x;
        text(shortStamp(t.at), cx, y + 3, { size: T.label, color: C.ink2 });
        cx += cols[0]! + GAP;
        text(fitLine(t.label, cols[1]!, { size: T.body }), cx, y + 2, { size: T.body });
        text(fitLine(`${t.department} · ${periodLabel(t.period)}`, cols[1]!, { size: 7 }), cx, y + 13, { size: 7, color: C.ink3 });
        cx += cols[1]! + GAP;
        // The band: the allowed range fills the middle 60% of the track; the
        // reading is a dot placed on the same scale, clamped to the track.
        const trackW = cols[2]!;
        const ty = y + 9;
        rect(cx, ty - 1, trackW, 2, C.rule);
        const lo = t.min;
        const hi = t.max;
        let pos = 0.5;
        if (lo != null && hi != null && hi > lo) {
          const bandX = cx + trackW * 0.2;
          rect(bandX, ty - 3, trackW * 0.6, 6, C.dataTint);
          text(`${lo}°`, cx, ty + 5, { size: 7, color: C.ink3 });
          textRight(`${hi}°`, cx + trackW, ty + 5, { size: 7, color: C.ink3 });
          pos = 0.2 + ((t.value - lo) / (hi - lo)) * 0.6;
        } else if (hi != null) {
          // The core PDF fonts have no ≤ / ≥ glyphs — say it in words.
          rect(cx, ty - 3, trackW * 0.8, 6, C.dataTint);
          textRight(`max ${hi}°`, cx + trackW, ty + 5, { size: 7, color: C.ink3 });
          pos = t.value <= hi ? 0.4 : 0.9;
        } else if (lo != null) {
          rect(cx + trackW * 0.2, ty - 3, trackW * 0.8, 6, C.dataTint);
          text(`min ${lo}°`, cx, ty + 5, { size: 7, color: C.ink3 });
          pos = t.value >= lo ? 0.6 : 0.1;
        }
        dot(cx + trackW * Math.min(0.98, Math.max(0.02, pos)), ty, 3.5, t.out ? C.bad : C.data);
        cx += cols[2]! + GAP;
        text(`${t.value}°F`, cx, y + 3, { size: T.body, bold: true, color: t.out ? C.bad : C.ink });
        cx += cols[3]! + GAP;
        const re = !t.out ? '—' : t.recheckMinutes == null ? 'never' : `${t.recheckMinutes} min`;
        text(re, cx, y + 3, { size: T.body, bold: t.out, color: !t.out ? C.ink3 : t.recheckMinutes == null ? C.bad : t.recheckMinutes <= 30 ? C.good : C.warn });
        hr(x, y + rowH - 1, W, C.rule);
        y += rowH;
      }
      if (r.temps.length > rows.length) {
        block(14, (x, yy) => text(`${num(r.temps.length - rows.length)} more in-range readings not listed`, x, yy, { size: T.label, color: C.ink3 }));
      }
      gap();
    }

    /* ================= 6. PRODUCTION ================================== */
    if (r.dailyMetrics.length > 0) {
      section('Production', 'what the floor recorded, by day · dashed line is the daily average');
      for (const m of r.dailyMetrics) {
        const chartH = r.days.length > 1 ? 104 : 40;
        block(chartH + 18, (x, yy, w) => {
          text(metricLabel(m.metricKey), x, yy, { size: T.body, bold: true });
          textRight(`${num(Math.round(m.total))}${m.unit ? ` ${m.unit}` : ''} in the period`, x + w, yy, { size: T.label, color: C.ink2 });
          if (r.days.length > 1) {
            bars(
              x,
              yy + 16,
              w,
              chartH,
              m.byDay.map((d) => ({ label: r.days.length > 14 ? shortDay(d.dateKey).replace(/^\w+ /, '') : shortDay(d.dateKey), value: d.total })),
              { mean: m.mean, unit: m.unit ?? undefined },
            );
          }
        });
        gap(6);
      }
      gap(6);
    }

    /* ================= 7. EXCEPTIONS ================================== */
    if (p.exceptions.length > 0) {
      section('Exceptions', `${num(p.exceptions.length)} recorded, worst first`);
      const order = { unsubmitted: 0, temp: 1, incomplete: 2, handover: 3 } as const;
      const list = [...p.exceptions].sort((a, b) => order[a.severity] - order[b.severity] || b.at.getTime() - a.at.getTime()).slice(0, 60);
      const cols = [colW(2), colW(3), colW(5), colW(2)];
      const head = () => {
        block(16, (x, yy) => {
          let cx = x;
          ['WHEN', 'SHIFT', 'WHAT HAPPENED', 'ACCOUNT'].forEach((h, i) => {
            text(h, cx, yy, LABEL);
            cx += cols[i]! + GAP;
          });
          hr(x, yy + 12, W, C.ink3, 0.5);
        });
      };
      head();
      const sev = { temp: C.bad, incomplete: C.warn, unsubmitted: C.bad, handover: C.warn } as const;
      for (const e of list) {
        const detailH = e.detail ? paraH(e.detail, cols[2]!, { size: T.label, color: C.ink3 }) : 0;
        const rowH = 16 + detailH + (e.detail ? 3 : 0) + 6;
        const before = pages;
        need(rowH);
        if (pages !== before) head();
        const x = M;
        let cx = x;
        rect(x - 6, y + 2, 2, 10, sev[e.severity]);
        text(shortStamp(e.at), cx, y, { size: T.label, color: C.ink2 });
        cx += cols[0]! + GAP;
        text(fitLine(`${periodLabel(e.period)} · ${e.department}`, cols[1]!, { size: T.body }), cx, y, { size: T.body });
        cx += cols[1]! + GAP;
        text(fitLine(e.headline, cols[2]!, { size: T.body, bold: true }), cx, y, { size: T.body, bold: true });
        if (e.detail) para(e.detail, cx, y + 14, cols[2]!, { size: T.label, color: C.ink3 });
        cx += cols[2]! + GAP;
        text(fitLine(e.account ?? '—', cols[3]!, { size: T.label }), cx, y + 1, { size: T.label, color: C.ink2 });
        hr(x, y + rowH - 3, W, C.rule);
        y += rowH;
      }
      gap();
    }

    /* ================= 8. HANDOVER AND STAFFING ======================== */
    section('Handover and staffing');
    block(96, (x, yy, w) => {
      const half = (w - GAP) / 2;
      // Handover disposition, as one bar.
      rect(x, yy, half, 96, C.wash);
      text('HANDOVERS BETWEEN SHIFTS', x + PAD, yy + PAD, LABEL);
      const total = rr.handoverCreated;
      text(total === 0 ? 'None raised' : `${num(total)} raised`, x + PAD, yy + PAD + 12, { size: T.figure, bold: true });
      if (total > 0) {
        const segs = [
          { label: 'Carried', v: rr.handoverCarried, color: C.data },
          { label: 'Reviewed', v: rr.handoverReviewed, color: C.dataTint },
          { label: 'Dismissed', v: rr.handoverDismissed, color: C.ink3 },
          { label: 'Undecided', v: rr.handoverPending, color: C.bad },
        ];
        const bx = x + PAD;
        const bw = half - PAD * 2;
        let sx = bx;
        for (const s of segs) {
          const sw = (bw * s.v) / total;
          if (sw > 0) rect(sx, yy + 54, sw, 8, s.color);
          sx += sw;
        }
        let lx = bx;
        for (const s of segs) {
          if (s.v === 0) continue;
          rect(lx, yy + 72, 6, 6, s.color);
          const l = `${s.label} ${s.v}`;
          text(l, lx + 9, yy + 71, { size: T.label, color: C.ink2 });
          lx += widthOf(l, { size: T.label }) + 18;
        }
      }
      // Staffing.
      const sx = x + half + GAP;
      rect(sx, yy, half, 96, C.wash);
      text('HEADCOUNT ON THE FLOOR', sx + PAD, yy + PAD, LABEL);
      text(r.staffing.scheduled > 0 ? `${num(r.staffing.actual)} of ${num(r.staffing.scheduled)}` : '—', sx + PAD, yy + PAD + 12, { size: T.figure, bold: true, color: r.staffing.scheduled > 0 && r.staffing.actual < r.staffing.scheduled ? C.warn : C.ink });
      text('clocked in against scheduled, summed over shifts', sx + PAD, yy + PAD + 38, { size: T.label, color: C.ink3 });
      const lines = [
        `${r.staffing.understaffedShifts} shift${r.staffing.understaffedShifts === 1 ? '' : 's'} ran below scheduled headcount`,
        r.staffing.sopPctUnderstaffed != null && r.staffing.sopPctFull != null ? `SOP ${r.staffing.sopPctUnderstaffed}% short-staffed vs ${r.staffing.sopPctFull}% at full headcount` : null,
      ].filter(Boolean) as string[];
      lines.forEach((l, i) => text(fitLine(l, half - PAD * 2, { size: T.label }), sx + PAD, yy + 60 + i * 12, { size: T.label, color: C.ink2 }));
    });
    gap(GAP + 4);

    /* ================= 9. PLAN FOR NEXT WEEK ========================== */
    newPage();
    section(r.days.length >= 6 ? 'Plan for next week' : 'Plan for the days ahead', `${r.insights.length} thing${r.insights.length === 1 ? '' : 's'} the record points to`);
    r.insights.forEach((ins, i) => {
      const bodyH = paraH(ins.body, W - PAD * 2 - 22, { size: T.body, color: C.ink2 });
      const h = PAD + 14 + 4 + bodyH + PAD;
      block(h, (x, yy, w) => {
        rect(x, yy, w, h, C.wash);
        rect(x, yy, 2.5, h, tone(ins.tone));
        text(`${i + 1}`, x + PAD, yy + PAD - 2, { size: T.figure, bold: true, color: tone(ins.tone) });
        text(fitLine(ins.title, w - PAD * 2 - 22, { size: T.body, bold: true }), x + PAD + 22, yy + PAD, { size: T.body, bold: true });
        para(ins.body, x + PAD + 22, yy + PAD + 16, w - PAD * 2 - 22, { size: T.body, color: C.ink2 });
      });
      gap(8);
    });
    if (r.lateBlocks.length > 0 || r.lineFailures.length > 0) {
      gap(4);
      section('What to watch', 'the blocks and lines behind the plan');
      block(16, (x, yy, w) => {
        const half = (w - GAP) / 2;
        text('BLOCKS THAT RUN LATE', x, yy, LABEL);
        text('LINES THAT KEEP FAILING', x + half + GAP, yy, LABEL);
        hr(x, yy + 12, half, C.ink3, 0.5);
        hr(x + half + GAP, yy + 12, half, C.ink3, 0.5);
      });
      const n = Math.max(r.lateBlocks.length, r.lineFailures.length, 1);
      for (let i = 0; i < Math.min(n, 8); i++) {
        block(20, (x, yy, w) => {
          const half = (w - GAP) / 2;
          const b = r.lateBlocks[i];
          if (b) {
            text(fitLine(`${b.section} · due ${hourLabel(b.hour)}`, half - 60, { size: T.body }), x, yy + 3, { size: T.body });
            textRight(`late ${b.late} of ${b.runs}`, x + half, yy + 3, { size: T.body, bold: true, color: b.late / b.runs >= 0.6 ? C.bad : C.warn });
          }
          const f = r.lineFailures[i];
          if (f) {
            const fx = x + half + GAP;
            text(fitLine(f.section ? `${f.title} · ${f.section}` : f.title, half - 60, { size: T.body }), fx, yy + 3, { size: T.body });
            textRight(`${f.failed} of ${f.runs}`, fx + half, yy + 3, { size: T.body, bold: true, color: f.failed / f.runs >= 0.5 ? C.bad : C.warn });
          }
          hr(x, yy + 18, w, C.rule);
        });
      }
    }

    /* ================= 10. PHOTO EVIDENCE ============================= */
    if (r.photos.length > 0) {
      newPage();
      section('Photo evidence', `${num(r.photos.length)} most recent, from ${where} only`);
      const pw = (W - GAP * 2) / 3;
      const ph = 132;
      for (let i = 0; i < r.photos.length; i += 3) {
        block(ph + 26, (x, yy) => {
          r.photos.slice(i, i + 3).forEach((photo, j) => {
            const px = x + (pw + GAP) * j;
            rect(px, yy, pw, ph, C.wash);
            try {
              doc.save();
              doc.roundedRect(px, yy, pw, ph, 4).clip();
              doc.image(photo.buffer, px, yy, { fit: [pw, ph], align: 'center', valign: 'center' });
              doc.restore();
            } catch {
              try {
                doc.restore();
              } catch {
                /* no dangling save */
              }
              textCenter('photo could not be read', px + pw / 2, yy + ph / 2 - 4, { size: T.label, color: C.ink3 });
            }
            text(fitLine(photo.caption, pw, { size: 7 }), px, yy + ph + 5, { size: 7, color: C.ink2 });
            text(shortStamp(photo.at), px, yy + ph + 14, { size: 7, color: C.ink3 });
          });
        });
        gap(4);
      }
    }

    /* ---- running header + footer -------------------------------------- */
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (i > 0) {
        text(`${r.orgName} · Store Operations Report`, M, 36, { size: T.label, color: C.ink3 });
        textRight(fitLine(`${where} · ${r.periodLabel}`, W / 2, { size: T.label }), M + W, 36, { size: T.label, color: C.ink3 });
        hr(M, 54, W);
      }
      hr(M, PAGE_H - 44, W);
      text(`Confidential · Prepared for ${r.clientName} by ${r.orgName} · times are store-local`, M, PAGE_H - 38, { size: T.label, color: C.ink3 });
      textRight(`Page ${i + 1} of ${range.count}`, M + W, PAGE_H - 38, { size: T.label, color: C.ink3 });
    }
    doc.end();
  });
}
