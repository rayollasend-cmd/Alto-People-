import PDFDocument from 'pdfkit';
import {
  ASCENT,
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
import {
  clock,
  duration,
  periodLabel,
  shortStamp,
  stamp,
  type OpsPacket,
  type PacketGroup,
  type PacketShift,
} from './opsPacket.js';

/**
 * The SOP packet, printed.
 *
 * The house style is in lib/pdfDesign.ts — the same grid, palette and type
 * scale the client service report uses, so a store manager holding both
 * does not have to learn two documents.
 *
 * The order is the argument. A packet opens on the one number that
 * summarises the period, states in a sentence what that number means,
 * and then spends the rest of its pages on the things the number hides:
 * the exceptions, the accounts that submitted them, and the stores and
 * shifts they came from. Averages last, never first.
 */

const KIND_TITLE = {
  shift: 'Shift Packet',
  day: 'Daily Operations Packet',
  month: 'Monthly Operations Packet',
  range: 'Operations Packet',
} as const;

const LABEL = { size: T.label, caps: true, bold: true, color: C.ink3 } as const;

const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
const num = (v: number) => v.toLocaleString('en-US');
const gradeColor = (v: number | null) =>
  v == null ? C.ink3 : v >= 95 ? C.good : v >= 85 ? C.warn : C.bad;

export function renderOpsPacketPdf(p: OpsPacket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 0,
      bufferPages: true,
      info: {
        Title: pdfSafe(`${KIND_TITLE[p.kind]} — ${p.scopeLabel} — ${p.periodLabel}`),
        Author: pdfSafe(p.orgName),
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
    const newPage = () => {
      if (pages > 0) doc.addPage();
      pages += 1;
      y = pages === 1 ? MASTHEAD_H + 22 : CONTENT_TOP;
    };
    /** Move to a fresh page unless `h` still fits under the current one. */
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

    /* ---- masthead ---------------------------------------------------- */
    const MASTHEAD_H = 118;
    newPage();
    rect(0, 0, PAGE_W, MASTHEAD_H, C.ink);
    text(p.orgName, M, 26, { size: T.label, caps: true, bold: true, color: C.brand });
    text(KIND_TITLE[p.kind], M, 42, { size: 24, bold: true, color: C.white });
    text(p.scopeLabel, M, 74, { size: T.title, color: C.white });
    text(
      [p.periodLabel, p.narrowLabel].filter(Boolean).join('  ·  '),
      M,
      90,
      { size: T.body, color: C.mastSub },
    );
    textRight(`Generated ${stamp(p.generatedAt)}`, PAGE_W - M, 90, {
      size: T.label,
      color: C.mastSub,
    });

    /* ---- section heading --------------------------------------------- */
    const section = (title: string, note?: string) => {
      const h = 15 + 8;
      need(h + 40); // never a heading alone at the foot of a page
      text(title, M, y, { size: T.title, bold: true });
      if (note) textRight(note, M + W, y + 3, { size: T.label, color: C.ink3 });
      y += 15;
      hr(M, y, W);
      y += 9;
    };

    /* ---- small parts -------------------------------------------------- */
    const meter = (
      x: number,
      yy: number,
      w: number,
      value: number | null,
      color: string = C.data,
      h = 4,
    ) => {
      doc.save().roundedRect(x, yy, w, h, h / 2).fill(C.rule).restore();
      if (value != null && value > 0) {
        const fw = Math.max(2, (w * Math.min(100, value)) / 100);
        doc.save().roundedRect(x, yy, fw, h, h / 2).fill(color).restore();
      }
    };

    /* ================= 1. THE HEADLINE ================================ */
    const r = p.rollup;
    const heroH = 104;
    block(heroH, (x, yy, w) => {
      rect(x, yy, w, heroH, C.wash);
      const inner = w - PAD * 2;
      const heroW = colW(4);
      text('SOP COMPLETION', x + PAD, yy + PAD, LABEL);
      text(pct(r.sopPct), x + PAD, yy + PAD + 8, {
        size: T.hero,
        bold: true,
        color: gradeColor(r.sopPct),
      });
      // Under the figure, not beside it: beside it, the sentence runs into
      // the tile column the moment the totals reach four digits.
      text(
        `${num(r.sopDone)} of ${num(r.sopTotal)} required items`,
        x + PAD,
        yy + PAD + 8 + 46,
        { size: T.body, color: C.ink2 },
      );
      meter(x + PAD, yy + heroH - PAD - 5, heroW, r.sopPct, gradeColor(r.sopPct), 5);

      // The four numbers that qualify the headline. Each is a count, not a
      // rate — a rate at this size invites the reader to stop reading.
      const tiles: { label: string; value: string; color?: string }[] = [
        { label: 'Shifts', value: num(r.shifts) },
        {
          label: 'Submitted on time',
          value: r.onTimeOf > 0 ? `${r.onTimeCloses}/${r.onTimeOf}` : '—',
          color: r.onTimeOf > 0 && r.onTimeCloses < r.onTimeOf ? C.warn : C.ink,
        },
        {
          label: 'Temps out of range',
          value: `${num(r.tempOutOfRange)} of ${num(r.tempChecks)}`,
          color: r.tempOutOfRange > 0 ? C.bad : C.good,
        },
        {
          label: 'Handovers undecided',
          value: num(r.handoverPending),
          color: r.handoverPending > 0 ? C.warn : C.good,
        },
      ];
      // Two by two, not four across: at four across each tile is 76pt
      // wide and every label truncates to "TEMPS OUT OF R…".
      const tileX = x + PAD + heroW + GAP * 2;
      const tileW = (inner - heroW - GAP * 2) / 2;
      tiles.forEach((t, i) => {
        const tx = tileX + tileW * (i % 2);
        const ty = yy + PAD + Math.floor(i / 2) * 36;
        text(fitLine(t.label, tileW - GAP, { ...LABEL }), tx, ty, LABEL);
        text(t.value, tx, ty + 12, {
          size: T.figure,
          bold: true,
          color: t.color ?? C.ink,
        });
      });
    });
    gap();

    /* ================= 2. WHAT THIS SAYS ============================== */
    const verdict = (): string => {
      const parts: string[] = [];
      const where = p.scopeLabel;
      if (r.shifts === 0) {
        return `No operations shifts were recorded for ${where} in this period. Either none ran, or they ran without an SOP open — which is itself the finding.`;
      }
      parts.push(
        `${where} ran ${num(r.shifts)} shift${r.shifts === 1 ? '' : 's'} in this period and completed ${
          r.sopPct == null ? 'no measured' : `${r.sopPct}% of`
        } required SOP items.`,
      );
      if (r.stillOpen > 0) {
        parts.push(
          `${num(r.stillOpen)} ${r.stillOpen === 1 ? 'shift has' : 'shifts have'} not been submitted; until they are, this period's numbers are incomplete.`,
        );
      }
      if (r.incomplete > 0) {
        parts.push(
          `${num(r.incomplete)} ${r.incomplete === 1 ? 'shift was' : 'shifts were'} submitted with required items still open, each with a written reason on the record.`,
        );
      }
      if (r.tempOutOfRange > 0) {
        parts.push(
          `${num(r.tempOutOfRange)} of ${num(r.tempChecks)} temperature readings fell outside their safe band — every one is listed in the exception ledger with the store, the time and the account that took it.`,
        );
      } else if (r.tempChecks > 0) {
        parts.push(`All ${num(r.tempChecks)} temperature readings were inside their safe bands.`);
      }
      if (r.handoverPending > 0) {
        parts.push(
          `${num(r.handoverPending)} handover item${r.handoverPending === 1 ? '' : 's'} left one shift and ${r.handoverPending === 1 ? 'was' : 'were'} never decided by the next.`,
        );
      }
      if (p.unplaced > 0) {
        parts.push(
          `${num(p.unplaced)} shift${p.unplaced === 1 ? '' : 's'} predate the store field and are counted separately rather than assigned to a building.`,
        );
      }
      return parts.join(' ');
    };
    const verdictText = verdict();
    const vH = paraH(verdictText, W - PAD * 2, { size: T.body, color: C.ink2 });
    block(vH + PAD * 2, (x, yy, w) => {
      rect(x, yy, 2.5, vH + PAD * 2, C.brand);
      para(verdictText, x + PAD, yy + PAD, w - PAD * 2, { size: T.body, color: C.ink2 });
    });
    gap(GAP + 4);

    /* ================= 3. EXCEPTIONS ================================== */
    if (p.exceptions.length > 0) {
      section(
        'Exceptions',
        `${num(p.exceptions.length)} recorded — the reason this packet exists`,
      );
      const cols = [colW(2), colW(2), colW(5), colW(3)];
      const headRow = () => {
        block(16, (x, yy) => {
          let cx = x;
          ['WHEN', 'STORE / SHIFT', 'WHAT HAPPENED', 'SUBMITTED BY'].forEach((h, i) => {
            text(h, cx, yy, LABEL);
            cx += cols[i] + GAP;
          });
          hr(x, yy + 12, W, C.ink3, 0.5);
        });
      };
      headRow();
      const sevColor = { temp: C.bad, incomplete: C.warn, unsubmitted: C.bad, handover: C.warn };
      for (const e of p.exceptions.slice(0, 120)) {
        const detailH = e.detail
          ? paraH(e.detail, cols[2], { size: T.label, color: C.ink3 })
          : 0;
        const rowH = 16 + detailH + (e.detail ? 3 : 0) + 6;
        const before = pages;
        need(rowH);
        if (pages !== before) headRow();
        const x = M;
        let cx = x;
        text(shortStamp(e.at), cx, y, { size: T.label, color: C.ink2 });
        cx += cols[0] + GAP;
        text(fitLine(e.storeName, cols[1], { size: T.body }), cx, y, { size: T.body });
        text(
          fitLine(`${periodLabel(e.period)} · ${e.department}`, cols[1], { size: T.label }),
          cx,
          y + 11,
          { size: T.label, color: C.ink3 },
        );
        cx += cols[1] + GAP;
        text(fitLine(e.headline, cols[2], { size: T.body, bold: true }), cx, y, {
          size: T.body,
          bold: true,
          color: sevColor[e.severity],
        });
        if (e.detail) {
          para(e.detail, cx, y + 13, cols[2], { size: T.label, color: C.ink3 });
        }
        cx += cols[2] + GAP;
        text(fitLine(e.account ?? '—', cols[3], { size: T.label }), cx, y + 1, {
          size: T.label,
          color: C.ink2,
        });
        y += rowH;
        hr(M, y - 3, W, C.rule, 0.4);
      }
      if (p.exceptions.length > 120) {
        block(14, (x, yy) =>
          text(
            `${num(p.exceptions.length - 120)} further exceptions are on the record but not printed — narrow the range.`,
            x,
            yy,
            { size: T.label, color: C.ink3 },
          ),
        );
      }
      gap(GAP + 4);
    } else if (r.shifts > 0) {
      block(20, (x, yy) =>
        text(
          'No exceptions were recorded in this period: nothing closed incomplete, no temperature left its band, and every handover was decided.',
          x,
          yy,
          { size: T.body, color: C.good },
        ),
      );
      gap();
    }

    /* ---- a reusable group table -------------------------------------- */
    const groupTable = (title: string, note: string, rows: PacketGroup[], nameHead: string) => {
      if (rows.length === 0) return;
      section(title, note);
      const nameW = colW(4);
      const meterW = colW(3);
      const headRow = () => {
        block(16, (x, yy) => {
          text(nameHead, x, yy, LABEL);
          text('SOP COMPLETION', x + nameW + GAP, yy, LABEL);
          textRight('SHIFTS', x + nameW + GAP + meterW + GAP + colW(1), yy, LABEL);
          textRight('INCOMPLETE', x + nameW + GAP + meterW + GAP + colW(1) + GAP + colW(1.5), yy, LABEL);
          textRight('TEMP ALERTS', x + nameW + GAP + meterW + GAP + colW(1) + GAP + colW(1.5) + GAP + colW(1.5), yy, LABEL);
          hr(x, yy + 12, W, C.ink3, 0.5);
        });
      };
      headRow();
      for (const g of rows.slice(0, 40)) {
        const rowH = g.sub ? 26 : 19;
        const before = pages;
        need(rowH);
        if (pages !== before) headRow();
        const x = M;
        text(fitLine(g.label, nameW, { size: T.body, bold: true }), x, y, {
          size: T.body,
          bold: true,
        });
        if (g.sub) text(fitLine(g.sub, nameW, { size: T.label }), x, y + 11, { size: T.label, color: C.ink3 });
        const mx = x + nameW + GAP;
        meter(mx, y + 4, meterW - 34, g.sopPct, gradeColor(g.sopPct));
        textRight(pct(g.sopPct), mx + meterW, y + 1, {
          size: T.body,
          bold: true,
          color: gradeColor(g.sopPct),
        });
        let cx = mx + meterW + GAP;
        textRight(num(g.shifts), cx + colW(1), y + 1, { size: T.body, color: C.ink2 });
        cx += colW(1) + GAP;
        textRight(g.incomplete > 0 ? num(g.incomplete) : '—', cx + colW(1.5), y + 1, {
          size: T.body,
          color: g.incomplete > 0 ? C.warn : C.ink3,
        });
        cx += colW(1.5) + GAP;
        textRight(g.tempAlerts > 0 ? num(g.tempAlerts) : '—', cx + colW(1.5), y + 1, {
          size: T.body,
          color: g.tempAlerts > 0 ? C.bad : C.ink3,
        });
        y += rowH;
        hr(M, y - 4, W, C.rule, 0.4);
      }
      gap(GAP + 4);
    };

    /* ================= 4. ACCOUNTABILITY ============================== */
    if (p.kind !== 'shift' && p.bySupervisor.length > 0) {
      groupTable(
        'By supervisor account',
        'the login that submitted the shift, worst first',
        p.bySupervisor,
        'SUPERVISOR / ACCOUNT',
      );
    }

    /* ================= 5. BY STORE, BY PERIOD ========================= */
    if (p.kind !== 'shift' && p.byStore.length > 1) {
      groupTable('By store', 'worst first', p.byStore, 'STORE / CLIENT');
    }
    if (p.kind !== 'shift' && p.byPeriod.length > 0) {
      groupTable('By shift', 'period and department', p.byPeriod, 'SHIFT / DEPARTMENT');
    }

    /* ================= 6. THE TREND =================================== */
    if (p.kind !== 'shift' && p.byDay.length > 1) {
      section('Day by day', 'SOP completion, with the days that carried exceptions marked');
      const chartH = 128;
      block(chartH, (x, yy, w) => {
        const plotH = chartH - 30;
        const base = yy + plotH;
        // Gridlines at 0/50/100 — three, because a chart with ten gridlines
        // is a table that has forgotten what it is.
        [0, 50, 100].forEach((g) => {
          const gy = base - (plotH * g) / 100;
          hr(x + 26, gy, w - 26, C.rule, 0.4);
          textRight(`${g}%`, x + 22, gy - 3, { size: T.label, color: C.ink3 });
        });
        const n = p.byDay.length;
        const slot = (w - 26) / n;
        const barW = Math.max(3, Math.min(26, slot - 6));
        p.byDay.forEach((d, i) => {
          const cx = x + 26 + slot * i + slot / 2;
          const v = d.sopPct ?? 0;
          const bh = Math.max(1, (plotH * v) / 100);
          doc
            .save()
            .rect(cx - barW / 2, base - bh, barW, bh)
            .fill(d.sopPct == null ? C.rule : gradeColor(d.sopPct))
            .restore();
          // A day that carried an exception gets a mark, so the reader does
          // not have to cross-reference the ledger to find it.
          if (d.incomplete > 0 || d.tempAlerts > 0) {
            doc.save().circle(cx, base - bh - 6, 2).fill(C.bad).restore();
          }
          if (n <= 16 || i % Math.ceil(n / 16) === 0) {
            textCenter(d.dateKey.slice(5), cx, base + 6, { size: T.label, color: C.ink3 });
          }
        });
        hr(x + 26, base, w - 26, C.ink3, 0.5);
        text(
          'Red dot = that day carried an incomplete submission or a temperature alert.',
          x + 26,
          base + 18,
          { size: T.label, color: C.ink3 },
        );
      });
      gap(GAP + 4);
    }

    /* ================= 7. HANDOVER DISPOSITION ======================== */
    if (p.kind !== 'shift' && r.handoverCreated > 0) {
      section('What one shift told the next', `${num(r.handoverCreated)} items raised`);
      const barH = 46;
      block(barH, (x, yy, w) => {
        const segs = [
          { label: 'Carried', value: r.handoverCarried, color: C.data },
          { label: 'Reviewed', value: r.handoverReviewed, color: C.good },
          { label: 'Dismissed', value: r.handoverDismissed, color: C.ink3 },
          { label: 'Undecided', value: r.handoverPending, color: C.bad },
        ].filter((s) => s.value > 0);
        let cx = x;
        const total = r.handoverCreated || 1;
        for (const s of segs) {
          const sw = (w * s.value) / total;
          rect(cx, yy, Math.max(1, sw - 2), 12, s.color);
          cx += sw;
        }
        // A legend, because four segments of one bar cannot be direct-labelled
        // honestly when one of them is 2% wide.
        let lx = x;
        for (const s of segs) {
          rect(lx, yy + 22, 7, 7, s.color);
          const t = `${s.label} ${num(s.value)}`;
          text(t, lx + 11, yy + 21, { size: T.label, color: C.ink2 });
          lx += 11 + widthOf(t, { size: T.label }) + 16;
        }
        text(
          'Undecided items are the ones that fell through the gap between two shifts.',
          x,
          yy + 34,
          { size: T.label, color: C.ink3 },
        );
      });
      gap(GAP + 4);
    }

    /* ================= 8. PRODUCTION RECORDED ========================= */
    if (p.metrics.length > 0) {
      section('Production recorded', 'named metrics, summed over the period');
      const per = Math.min(4, p.metrics.length);
      const tileW = (W - GAP * (per - 1)) / per;
      block(46, (x, yy) => {
        p.metrics.slice(0, per).forEach((m, i) => {
          const tx = x + (tileW + GAP) * i;
          text(fitLine(metricLabel(m.metricKey), tileW, { size: T.label, caps: true, bold: true }), tx, yy, LABEL);
          text(num(Math.round(m.total)), tx, yy + 14, { size: T.figure, bold: true, color: C.data });
          const unitX = tx + widthOf(num(Math.round(m.total)), { size: T.figure, bold: true }) + 4;
          if (m.unit) text(m.unit, unitX, yy + 14 + T.figure * ASCENT - T.label, LABEL);
          text(`${num(m.readings)} readings`, tx, yy + 36, { size: T.label, color: C.ink3 });
        });
      });
      gap(GAP + 4);
    }

    /* ================= 9. THE SHIFTS ================================== */
    if (p.kind !== 'shift' && p.shifts.length > 0) {
      section('Every shift in this period', `${num(p.shifts.length)} rows, newest first`);
      const cols = {
        day: colW(1.4),
        store: colW(2.4),
        shift: colW(2.2),
        ran: colW(2),
        sop: colW(1.4),
        by: colW(2.6),
      };
      const headRow = () => {
        block(16, (x, yy) => {
          let cx = x;
          (
            [
              ['DAY', cols.day],
              ['STORE', cols.store],
              ['SHIFT', cols.shift],
              ['OPEN - CLOSE', cols.ran],
              ['SOP', cols.sop],
              ['SUBMITTED BY', cols.by],
            ] as [string, number][]
          ).forEach(([h, w]) => {
            text(h, cx, yy, LABEL);
            cx += w + GAP;
          });
          hr(x, yy + 12, W, C.ink3, 0.5);
        });
      };
      headRow();
      for (const s of p.shifts.slice(0, 300)) {
        const rowH = 24;
        const before = pages;
        need(rowH);
        if (pages !== before) headRow();
        const x = M;
        let cx = x;
        text(s.dateKey.slice(5), cx, y, { size: T.body, color: C.ink2 });
        cx += cols.day + GAP;
        text(fitLine(s.storeName, cols.store, { size: T.body }), cx, y, { size: T.body });
        cx += cols.store + GAP;
        text(periodLabel(s.period), cx, y, { size: T.body });
        text(fitLine(s.department, cols.shift, { size: T.label }), cx, y + 11, {
          size: T.label,
          color: C.ink3,
        });
        cx += cols.shift + GAP;
        text(`${clock(s.openedAt)}–${s.closedAt ? clock(s.closedAt) : 'open'}`, cx, y, {
          size: T.label,
          color: C.ink2,
        });
        text(duration(s.ranMinutes), cx, y + 11, { size: T.label, color: C.ink3 });
        cx += cols.ran + GAP;
        text(pct(s.sopPct), cx, y, { size: T.body, bold: true, color: gradeColor(s.sopPct) });
        if (s.closedIncomplete) text('incomplete', cx, y + 11, { size: T.label, color: C.warn });
        else if (s.tempAlerts > 0)
          text(`${s.tempAlerts} temp`, cx, y + 11, { size: T.label, color: C.bad });
        else if (s.status !== 'CLOSED')
          text('not submitted', cx, y + 11, { size: T.label, color: C.bad });
        cx += cols.sop + GAP;
        const acct = s.submittedBy ?? s.openedBy;
        text(fitLine(acct?.name ?? '—', cols.by, { size: T.body }), cx, y, { size: T.body });
        if (acct?.email)
          text(fitLine(acct.email, cols.by, { size: T.label }), cx, y + 11, {
            size: T.label,
            color: C.ink3,
          });
        y += rowH;
        hr(M, y - 5, W, C.rule, 0.4);
      }
      if (p.shifts.length > 300) {
        block(14, (x, yy) =>
          text(`${num(p.shifts.length - 300)} further shifts are not printed — narrow the range.`, x, yy, {
            size: T.label,
            color: C.ink3,
          }),
        );
      }
      gap();
    }

    /* ================= 10. THE SINGLE-SHIFT RECORD ==================== */
    if (p.detail) {
      const d = p.detail;
      renderShiftRecord(d.shift);

      // --- the checklist, by section ---------------------------------
      section('The checklist, as it was worked', `${num(d.tasks.length)} items`);
      let lastSection: string | null | undefined;
      for (const t of d.tasks) {
        if (t.section !== lastSection) {
          lastSection = t.section;
          block(18, (x, yy) => {
            text(t.section ?? 'Other items', x, yy + 3, {
              size: T.label,
              caps: true,
              bold: true,
              color: C.ink2,
            });
          });
        }
        const noteText = [t.note, t.blockedReason].filter(Boolean).join(' · ');
        const noteH = noteText ? paraH(noteText, colW(7), { size: T.label, color: C.ink3 }) + 2 : 0;
        const rowH = 20 + noteH;
        need(rowH);
        const x = M;
        // The state mark: done, open, blocked, or out of band.
        const markColor =
          t.outOfRange ? C.bad : t.status === 'DONE' ? C.good : t.status === 'BLOCKED' ? C.bad : C.ink3;
        doc.save().circle(x + 3.5, y + 5, 3.5).fill(markColor).restore();
        text(fitLine(t.title, colW(6), { size: T.body }), x + 13, y, {
          size: T.body,
          color: t.status === 'DONE' ? C.ink : C.ink2,
        });
        if (t.required && t.status !== 'DONE') {
          text('REQUIRED', x + 13 + colW(6) + 4, y + 1, { size: T.label, bold: true, color: C.bad });
        }
        // The answer and its band — a temperature without its band is a
        // number nobody can judge.
        const ax = x + colW(7) + GAP;
        if (t.answer) {
          text(t.answer, ax, y, {
            size: T.body,
            bold: true,
            color: t.outOfRange ? C.bad : C.ink,
          });
          if (t.band) text(t.band, ax, y + 11, { size: T.label, color: C.ink3 });
        } else {
          text(t.status === 'DONE' ? 'done' : t.status.toLowerCase(), ax, y, {
            size: T.body,
            color: C.ink3,
          });
        }
        const wx = x + colW(9) + GAP * 2;
        text(clock(t.completedAt), wx, y, { size: T.label, color: C.ink2 });
        const who = t.doneBy ?? t.completedByAccount;
        if (who) text(fitLine(who, colW(3), { size: T.label }), wx, y + 11, { size: T.label, color: C.ink3 });
        if (t.photos > 0) {
          textRight(`${t.photos} photo${t.photos === 1 ? '' : 's'}`, M + W, y + 11, {
            size: T.label,
            color: C.data,
          });
        }
        if (noteText) para(noteText, x + 13, y + 20, colW(7), { size: T.label, color: C.ink3 });
        y += rowH;
      }
      gap();

      // --- handovers --------------------------------------------------
      const handoverList = (title: string, items: typeof d.handoverOut, empty: string) => {
        section(title);
        if (items.length === 0) {
          block(16, (x, yy) => text(empty, x, yy, { size: T.body, color: C.ink3 }));
          gap();
          return;
        }
        for (const h of items) {
          const bodyH = paraH(h.body, colW(8), { size: T.body, color: C.ink });
          const rowH = bodyH + 16;
          need(rowH);
          const x = M;
          text(h.kind, x, y, { size: T.label, caps: true, bold: true, color: C.ink3 });
          para(h.body, x + colW(1.5), y, colW(8), { size: T.body });
          textRight(h.status, M + W, y, {
            size: T.label,
            caps: true,
            bold: true,
            color:
              h.status === 'PENDING' ? C.bad : h.status === 'CARRIED' ? C.data : C.ink3,
          });
          const meta = [
            stamp(h.createdAt),
            h.fromShift,
            h.decidedByAccount ? `decided by ${h.decidedByAccount} ${stamp(h.decidedAt)}` : null,
          ]
            .filter(Boolean)
            .join('  ·  ');
          text(fitLine(meta, colW(8), { size: T.label }), x + colW(1.5), y + bodyH + 2, {
            size: T.label,
            color: C.ink3,
          });
          y += rowH;
          hr(M, y - 5, W, C.rule, 0.4);
        }
        gap();
      };
      handoverList('Handed to the next shift', d.handoverOut, d.shift.handoverNone
        ? 'The supervisor recorded that there was nothing to hand over.'
        : 'Nothing was handed over.');
      if (d.handoverIn.length > 0) {
        handoverList('Decided from the previous shift', d.handoverIn, '');
      }

      // --- the signature block ---------------------------------------
      section('Accountability');
      const ATTEST =
        'Submitting a shift is an attested act: the account above certifies that the items marked done were done and that the readings recorded are the readings taken.';
      const attestH = paraH(ATTEST, W - PAD * 2, { size: T.label });
      const signH = PAD + 42 + attestH + PAD;
      block(signH, (x, yy, w) => {
        rect(x, yy, w, signH, C.wash);
        const cells: [string, string, string][] = [
          [
            'OPENED / RUN BY',
            d.shift.openedBy?.name ?? '—',
            d.shift.openedBy?.email ?? '',
          ],
          [
            'SUBMITTED BY',
            d.shift.submittedBy?.name ?? 'Not yet submitted',
            d.shift.submittedBy?.email ?? '',
          ],
          [
            'COVERING FOR',
            d.shift.coveringFor?.name ?? 'Not a covered shift',
            d.shift.coveringFor?.email ?? '',
          ],
        ];
        const cw = (w - PAD * 2) / 3;
        cells.forEach(([l, n, e], i) => {
          const cx = x + PAD + cw * i;
          text(l, cx, yy + PAD, LABEL);
          text(fitLine(n, cw - GAP, { size: T.title, bold: true }), cx, yy + PAD + 13, {
            size: T.title,
            bold: true,
          });
          if (e) text(fitLine(e, cw - GAP, { size: T.label }), cx, yy + PAD + 28, { size: T.label, color: C.ink2 });
        });
        para(ATTEST, x + PAD, yy + PAD + 42, w - PAD * 2, { size: T.label, color: C.ink3 });
      });
      gap();
    }

    /* ---- running header and footer ----------------------------------- */
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      if (i > 0) {
        text(p.orgName, M, 30, { size: T.label, caps: true, bold: true, color: C.ink3 });
        text(
          `${KIND_TITLE[p.kind]} · ${p.scopeLabel} · ${p.periodLabel}`,
          M,
          42,
          { size: T.label, color: C.ink3 },
        );
        hr(M, 54, W);
      }
      hr(M, PAGE_H - 44, W);
      text(
        `Generated ${stamp(p.generatedAt)} · times are store-local`,
        M,
        PAGE_H - 38,
        { size: T.label, color: C.ink3 },
      );
      textRight(`Page ${i + 1} of ${range.count}`, M + W, PAGE_H - 38, {
        size: T.label,
        color: C.ink3,
      });
    }

    doc.end();

    /* ---- the one-shift header block ---------------------------------- */
    function renderShiftRecord(s: PacketShift) {
      section('The shift');
      block(84, (x, yy, w) => {
        rect(x, yy, w, 84, C.wash);
        const facts: [string, string][] = [
          ['STORE', s.storeName],
          ['SHIFT', `${periodLabel(s.period)}${s.windowLabel ? ` · ${s.windowLabel}` : ''}`],
          ['DEPARTMENTS', s.departments.length ? s.departments.join(', ') : s.department],
          ['OPENED', stamp(s.openedAt)],
          ['SUBMITTED', s.closedAt ? stamp(s.closedAt) : 'Not yet submitted'],
          ['RAN FOR', duration(s.ranMinutes)],
          ['HEADCOUNT', `${s.actualHeadcount} of ${s.scheduledHeadcount} scheduled`],
          ['SOP', `${s.sopDone}/${s.sopTotal} required · ${s.taskDone}/${s.taskTotal} total`],
        ];
        const cw = (w - PAD * 2) / 4;
        facts.forEach(([l, v], i) => {
          const cx = x + PAD + cw * (i % 4);
          const cy = yy + PAD + Math.floor(i / 4) * 36;
          text(l, cx, cy, LABEL);
          text(fitLine(v, cw - GAP, { size: T.body, bold: true }), cx, cy + 12, {
            size: T.body,
            bold: true,
          });
        });
      });
      gap();
      if (s.closingSummary) {
        const h = paraH(s.closingSummary, W - PAD * 2, { size: T.body, color: C.ink });
        block(h + PAD * 2 + 14, (x, yy, w) => {
          rect(x, yy, 2.5, h + PAD * 2 + 14, C.data);
          text('THE SUPERVISOR’S CLOSING SUMMARY', x + PAD, yy + PAD, LABEL);
          para(s.closingSummary!, x + PAD, yy + PAD + 14, w - PAD * 2, { size: T.body });
        });
        gap();
      }
      if (s.closedIncomplete && s.incompleteReason) {
        const h = paraH(s.incompleteReason, W - PAD * 2, { size: T.body, color: C.ink });
        block(h + PAD * 2 + 14, (x, yy, w) => {
          rect(x, yy, 2.5, h + PAD * 2 + 14, C.bad);
          text('WHY IT WAS SUBMITTED INCOMPLETE', x + PAD, yy + PAD, LABEL);
          para(s.incompleteReason!, x + PAD, yy + PAD + 14, w - PAD * 2, { size: T.body });
        });
        gap();
      }
    }
  });
}

/** "cases_stocked" → "Cases stocked". */
export function metricLabel(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
