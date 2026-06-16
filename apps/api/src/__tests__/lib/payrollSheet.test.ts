import { describe, expect, it } from 'vitest';
import {
  buildPayrollSheet,
  minutesToHours,
  type PayrollSheetInputRow,
} from '../../lib/payrollSheet.js';

// 2026-06-15 is a Monday → anchors a clean ISO week (Mon..Sun) in UTC.
function entry(
  associateId: string,
  name: string,
  dateYmd: string,
  startHour: number,
  hours: number,
): PayrollSheetInputRow {
  const clockInAt = new Date(`${dateYmd}T${String(startHour).padStart(2, '0')}:00:00.000Z`);
  const clockOutAt = new Date(clockInAt.getTime() + hours * 60 * 60 * 1000);
  return { associateId, associateName: name, clockInAt, clockOutAt, breaks: [] };
}

describe('buildPayrollSheet', () => {
  it('splits weekly overtime at 40h and sums dates worked', () => {
    // Mon–Fri, 9h each = 45h in one ISO week → 40 regular / 5 OT.
    const rows = [
      entry('a1', 'Ann Lee', '2026-06-15', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-16', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-17', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-18', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-19', 9, 9),
    ];
    const sheet = buildPayrollSheet(rows);
    expect(sheet.associates).toHaveLength(1);
    const a = sheet.associates[0];
    expect(a.regularMinutes).toBe(40 * 60);
    expect(a.overtimeMinutes).toBe(5 * 60);
    expect(a.totalMinutes).toBe(45 * 60);
    expect(a.days).toHaveLength(5);
    expect(a.days[0]).toEqual({ date: '2026-06-15', minutes: 540 });
    expect(sheet.totalRegularMinutes).toBe(40 * 60);
    expect(sheet.totalOvertimeMinutes).toBe(5 * 60);
  });

  it('computes overtime per ISO week independently (no spillover)', () => {
    // 45h in week 1 + 45h in the next week → 80 regular / 10 OT, not 50/40.
    const rows = [
      entry('a1', 'Ann Lee', '2026-06-15', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-16', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-17', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-18', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-19', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-22', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-23', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-24', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-25', 9, 9),
      entry('a1', 'Ann Lee', '2026-06-26', 9, 9),
    ];
    const a = buildPayrollSheet(rows).associates[0];
    expect(a.regularMinutes).toBe(80 * 60);
    expect(a.overtimeMinutes).toBe(10 * 60);
    expect(a.days).toHaveLength(10);
  });

  it('merges multiple entries on the same date into one day total', () => {
    const rows = [
      entry('a1', 'Ann Lee', '2026-06-15', 8, 4), // 4h morning
      entry('a1', 'Ann Lee', '2026-06-15', 13, 4), // 4h afternoon
    ];
    const a = buildPayrollSheet(rows).associates[0];
    expect(a.days).toHaveLength(1);
    expect(a.days[0]).toEqual({ date: '2026-06-15', minutes: 8 * 60 });
    expect(a.regularMinutes).toBe(8 * 60);
    expect(a.overtimeMinutes).toBe(0);
  });

  it('subtracts break time from the daily duration', () => {
    const clockInAt = new Date('2026-06-15T09:00:00.000Z');
    const clockOutAt = new Date('2026-06-15T17:00:00.000Z'); // 8h gross
    const rows: PayrollSheetInputRow[] = [
      {
        associateId: 'a1',
        associateName: 'Ann Lee',
        clockInAt,
        clockOutAt,
        breaks: [
          {
            type: 'MEAL',
            startedAt: new Date('2026-06-15T12:00:00.000Z'),
            endedAt: new Date('2026-06-15T12:30:00.000Z'), // 30m
          },
        ],
      },
    ];
    const a = buildPayrollSheet(rows).associates[0];
    expect(a.days[0].minutes).toBe(7 * 60 + 30); // 8h − 30m
  });

  it('sorts associates by name', () => {
    const rows = [
      entry('z', 'Zoe Park', '2026-06-15', 9, 8),
      entry('a', 'Al Roy', '2026-06-15', 9, 8),
    ];
    const sheet = buildPayrollSheet(rows);
    expect(sheet.associates.map((a) => a.name)).toEqual(['Al Roy', 'Zoe Park']);
  });

  it('returns an empty sheet for no rows', () => {
    const sheet = buildPayrollSheet([]);
    expect(sheet.associates).toHaveLength(0);
    expect(sheet.totalMinutes).toBe(0);
  });
});

describe('minutesToHours', () => {
  it('formats to 2 decimals', () => {
    expect(minutesToHours(150)).toBe('2.50');
    expect(minutesToHours(0)).toBe('0.00');
    expect(minutesToHours(2700)).toBe('45.00');
  });
});
