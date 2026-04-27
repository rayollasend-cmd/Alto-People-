import PDFDocument from 'pdfkit';

/**
 * Phase 65 — time entry PDF renderer.
 *
 * Mirrors scheduleReport.ts: a chronological, page-broken table sized for
 * letter-landscape, with a status color bar on each row and a footer
 * summary. Uses pdfkit's built-in Helvetica family.
 */

export interface TimeReportEntry {
  clockInAt: Date;
  clockOutAt: Date | null;
  associateName: string;
  clientName: string | null;
  jobName: string | null;
  status: string;
  minutes: number;
  rejectionReason: string | null;
}

export interface TimeReportData {
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  filters: {
    clientName: string | null;
    associateName: string | null;
    status: string | null;
  };
  entries: TimeReportEntry[];
}

const COLS = [
  { key: 'date',  label: 'Date',      width: 70 },
  { key: 'in',    label: 'In',        width: 60 },
  { key: 'out',   label: 'Out',       width: 60 },
  { key: 'hrs',   label: 'Hrs',       width: 40, align: 'right' as const },
  { key: 'assoc', label: 'Associate', width: 130 },
  { key: 'client',label: 'Client',    width: 110 },
  { key: 'job',   label: 'Job',       width: 110 },
  { key: 'status',label: 'Status',    width: 70 },
];

const ROW_HEIGHT = 16;
const HEADER_PT = 9;
const ROW_PT = 9;
const PAGE_MARGIN = 36;

export async function renderTimeReportPdf(data: TimeReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const filterLines: string[] = [];
    if (data.filters.clientName) filterLines.push(`Client: ${data.filters.clientName}`);
    if (data.filters.associateName) filterLines.push(`Associate: ${data.filters.associateName}`);
    if (data.filters.status) filterLines.push(`Status: ${data.filters.status}`);

    const drawHeader = () => {
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#000').text('TIME ENTRIES', PAGE_MARGIN, PAGE_MARGIN);
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#444')
        .text(formatRange(data.rangeFrom, data.rangeTo), PAGE_MARGIN, PAGE_MARGIN + 22);
      let y = PAGE_MARGIN + 36;
      for (const line of filterLines) {
        doc.text(line, PAGE_MARGIN, y);
        y += 12;
      }
      doc
        .fontSize(8)
        .fillColor('#888')
        .text(
          `Generated ${data.generatedAt.toLocaleString()} · Alto People`,
          PAGE_MARGIN,
          y + 2
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
      doc
        .moveTo(PAGE_MARGIN, top + ROW_HEIGHT - 1)
        .lineTo(x, top + ROW_HEIGHT - 1)
        .lineWidth(0.5)
        .strokeColor('#888')
        .stroke();
      doc.strokeColor('#000');
    };

    const headerHeight = 60 + filterLines.length * 12;

    drawHeader();
    let y = PAGE_MARGIN + headerHeight;
    drawTableHeader(y);
    y += ROW_HEIGHT;

    const pageBottom = doc.page.height - PAGE_MARGIN - ROW_HEIGHT;

    if (data.entries.length === 0) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(11)
        .fillColor('#666')
        .text('No time entries in this range.', PAGE_MARGIN, y + 12);
      doc.end();
      return;
    }

    const sorted = [...data.entries].sort(
      (a, b) => a.clockInAt.getTime() - b.clockInAt.getTime()
    );

    let prevDate = '';
    doc.font('Helvetica').fontSize(ROW_PT).fillColor('#000');

    for (const e of sorted) {
      if (y > pageBottom) {
        doc.addPage();
        drawHeader();
        y = PAGE_MARGIN + headerHeight;
        drawTableHeader(y);
        y += ROW_HEIGHT;
        prevDate = '';
        doc.font('Helvetica').fontSize(ROW_PT).fillColor('#000');
      }

      const dateStr = e.clockInAt.toLocaleDateString();
      const showDate = dateStr !== prevDate;
      prevDate = dateStr;

      if (showDate && y > PAGE_MARGIN + headerHeight + ROW_HEIGHT) {
        doc
          .moveTo(PAGE_MARGIN, y - 1)
          .lineTo(PAGE_MARGIN + COLS.reduce((a, c) => a + c.width, 0), y - 1)
          .lineWidth(0.25)
          .strokeColor('#ddd')
          .stroke();
      }

      const cells: Record<string, string> = {
        date: showDate ? dateStr : '',
        in: fmtTime(e.clockInAt),
        out: e.clockOutAt ? fmtTime(e.clockOutAt) : '—',
        hrs: (e.minutes / 60).toFixed(2),
        assoc: e.associateName,
        client: e.clientName ?? '—',
        job: e.jobName ?? '',
        status: e.status,
      };

      const statusColor = colorForStatus(e.status);
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

      if (e.rejectionReason) {
        if (y > pageBottom) {
          doc.addPage();
          drawHeader();
          y = PAGE_MARGIN + headerHeight;
          drawTableHeader(y);
          y += ROW_HEIGHT;
        }
        doc
          .font('Helvetica-Oblique')
          .fontSize(8)
          .fillColor('#B5360F')
          .text(
            `Rejected: ${e.rejectionReason}`,
            PAGE_MARGIN + COLS[0].width + COLS[1].width + COLS[2].width + COLS[3].width + 2,
            y - 4,
            { width: COLS[4].width + COLS[5].width + COLS[6].width + COLS[7].width - 4 }
          );
        doc.font('Helvetica').fontSize(ROW_PT).fillColor('#111');
        y += 10;
      }
    }

    const totalMinutes = sorted.reduce((acc, e) => acc + e.minutes, 0);
    const totalHours = totalMinutes / 60;
    const counts = sorted.reduce<Record<string, number>>((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {});
    const summary = `Total: ${sorted.length} entries · ${totalHours.toFixed(1)} hours · ${
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
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(summary, PAGE_MARGIN, y);

    doc.end();
  });
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRange(from: Date, toExclusive: Date): string {
  const last = new Date(toExclusive.getTime() - 1);
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
    case 'APPROVED':
      return '#34A874';
    case 'COMPLETED':
      return '#EDB23C';
    case 'REJECTED':
      return '#E85244';
    case 'ACTIVE':
      return '#3F8EE0';
    default:
      return '#999999';
  }
}
