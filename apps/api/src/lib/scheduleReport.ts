import PDFDocument from 'pdfkit';

/**
 * Phase 54.4 — schedule PDF renderer.
 *
 * Renders a chronological table of shifts for a date range. Output is a
 * Buffer so the route can hash / log it before streaming. Uses pdfkit's
 * built-in Helvetica family (no font files in the repo). Page is letter
 * landscape so the wide table doesn't wrap nine columns into the gutter.
 */

export interface ScheduleReportShift {
  startsAt: Date;
  endsAt: Date;
  position: string;
  clientName: string | null;
  location: string | null;
  assignedAssociateName: string | null;
  status: string;
  hourlyRate: number | null;
  scheduledMinutes: number;
}

export interface ScheduleReportData {
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  filters: {
    clientName: string | null; // null = all
  };
  shifts: ScheduleReportShift[];
}

const COLS = [
  { key: 'date',     label: 'Date',     width: 70 },
  { key: 'time',     label: 'Time',     width: 80 },
  { key: 'hours',    label: 'Hrs',      width: 32, align: 'right' as const },
  { key: 'position', label: 'Position', width: 100 },
  { key: 'client',   label: 'Client',   width: 90 },
  { key: 'loc',      label: 'Location', width: 80 },
  { key: 'assoc',    label: 'Associate', width: 110 },
  { key: 'status',   label: 'Status',   width: 60 },
  { key: 'rate',     label: 'Rate',     width: 50, align: 'right' as const },
];

const ROW_HEIGHT = 16;
const HEADER_PT = 9;
const ROW_PT = 9;
const PAGE_MARGIN = 36;

export async function renderSchedulePdf(data: ScheduleReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const drawHeader = () => {
      doc.fontSize(16).font('Helvetica-Bold').text('SCHEDULE', PAGE_MARGIN, PAGE_MARGIN);
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#444')
        .text(formatRange(data.rangeFrom, data.rangeTo), PAGE_MARGIN, PAGE_MARGIN + 22);
      const filterLine = data.filters.clientName ? `Client: ${data.filters.clientName}` : '';
      if (filterLine) doc.text(filterLine, PAGE_MARGIN, PAGE_MARGIN + 36);
      doc
        .fontSize(8)
        .fillColor('#888')
        .text(
          `Generated ${data.generatedAt.toLocaleString()} · Alto People`,
          PAGE_MARGIN,
          PAGE_MARGIN + (filterLine ? 50 : 36)
        );
      doc.fillColor('#000');
    };

    const drawTableHeader = (top: number) => {
      doc.font('Helvetica-Bold').fontSize(HEADER_PT).fillColor('#000');
      let x = PAGE_MARGIN;
      for (const c of COLS) {
        doc.text(c.label, x + 2, top + 4, {
          width: c.width - 4,
          align: c.align ?? 'left',
        });
        x += c.width;
      }
      // Underline
      doc
        .moveTo(PAGE_MARGIN, top + ROW_HEIGHT - 1)
        .lineTo(x, top + ROW_HEIGHT - 1)
        .lineWidth(0.5)
        .strokeColor('#888')
        .stroke();
      doc.strokeColor('#000');
    };

    drawHeader();

    let y = PAGE_MARGIN + 78;
    drawTableHeader(y);
    y += ROW_HEIGHT;

    // Page-bottom guard so we know when to start a new page.
    const pageBottom = doc.page.height - PAGE_MARGIN - ROW_HEIGHT;

    if (data.shifts.length === 0) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(11)
        .fillColor('#666')
        .text('No shifts in this range.', PAGE_MARGIN, y + 12);
      doc.end();
      return;
    }

    // Sort chronologically defensively (route should already do this).
    const sorted = [...data.shifts].sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
    );

    let prevDate = '';
    doc.font('Helvetica').fontSize(ROW_PT).fillColor('#000');

    for (const s of sorted) {
      // Page break + repeat header.
      if (y > pageBottom) {
        doc.addPage();
        drawHeader();
        y = PAGE_MARGIN + 78;
        drawTableHeader(y);
        y += ROW_HEIGHT;
        prevDate = '';
        doc.font('Helvetica').fontSize(ROW_PT).fillColor('#000');
      }

      const dateStr = s.startsAt.toLocaleDateString();
      const showDate = dateStr !== prevDate;
      prevDate = dateStr;

      // Light grey divider when the date rolls over — nicer scan on paper.
      if (showDate && y > PAGE_MARGIN + 78 + ROW_HEIGHT) {
        doc
          .moveTo(PAGE_MARGIN, y - 1)
          .lineTo(PAGE_MARGIN + COLS.reduce((a, c) => a + c.width, 0), y - 1)
          .lineWidth(0.25)
          .strokeColor('#ddd')
          .stroke();
      }

      const cells: Record<string, string> = {
        date: showDate ? dateStr : '',
        time: `${fmtTime(s.startsAt)}–${fmtTime(s.endsAt)}`,
        hours: (s.scheduledMinutes / 60).toFixed(2),
        position: s.position,
        client: s.clientName ?? '—',
        loc: s.location ?? '',
        assoc: s.assignedAssociateName ?? '—',
        status: s.status,
        rate: s.hourlyRate !== null ? `$${s.hourlyRate.toFixed(2)}` : '',
      };

      // Status color bar on the left of the row.
      const statusColor = colorForStatus(s.status);
      doc
        .save()
        .fillColor(statusColor)
        .rect(PAGE_MARGIN - 2, y + 2, 1.5, ROW_HEIGHT - 4)
        .fill()
        .restore();

      let x = PAGE_MARGIN;
      doc.font('Helvetica').fontSize(ROW_PT).fillColor('#111');
      for (const c of COLS) {
        const text = cells[c.key] ?? '';
        doc.text(text, x + 2, y + 4, {
          width: c.width - 4,
          align: c.align ?? 'left',
          ellipsis: true,
        });
        x += c.width;
      }
      y += ROW_HEIGHT;
    }

    // Footer summary on the last page.
    const totalMinutes = sorted.reduce((acc, s) => acc + s.scheduledMinutes, 0);
    const totalHours = totalMinutes / 60;
    const counts = sorted.reduce<Record<string, number>>((acc, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});
    const summary = `Total: ${sorted.length} shifts · ${totalHours.toFixed(1)} scheduled hours · ${
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' · ')
    }`;
    if (y + 24 > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      y = PAGE_MARGIN;
    } else {
      y += 8;
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#000')
      .text(summary, PAGE_MARGIN, y);

    doc.end();
  });
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRange(from: Date, toExclusive: Date): string {
  // Display the inclusive end (1 ms before toExclusive) so the title reads naturally.
  const last = new Date(toExclusive.getTime() - 1);
  if (
    from.getFullYear() === last.getFullYear() &&
    from.getMonth() === last.getMonth() &&
    from.getDate() === 1
  ) {
    const lastDay = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
    if (last.getDate() === lastDay) {
      return from.toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
  }
  if (
    from.getFullYear() === last.getFullYear() &&
    from.getMonth() === last.getMonth() &&
    from.getDate() === last.getDate()
  ) {
    return from.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return `${from.toLocaleDateString()} – ${last.toLocaleDateString()}`;
}

function colorForStatus(status: string): string {
  switch (status) {
    case 'OPEN':
      return '#EDB23C';
    case 'ASSIGNED':
    case 'COMPLETED':
      return '#34A874';
    case 'DRAFT':
      return '#888888';
    case 'CANCELLED':
      return '#E85244';
    default:
      return '#999999';
  }
}
