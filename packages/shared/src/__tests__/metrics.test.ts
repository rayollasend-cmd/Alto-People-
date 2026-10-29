import { describe, expect, it } from 'vitest';
import { METRICS, daysToCollectOf, marginPctOf, metric, type MetricId } from '../metrics.js';
import { OVERTIME_RISK_HOURS, isOvertimeRisk } from '../attendanceInsights.js';

const ids = Object.keys(METRICS) as MetricId[];

describe('the metric dictionary', () => {
  it('keys each entry by its own id', () => {
    for (const id of ids) expect(METRICS[id].id).toBe(id);
  });

  it('gives every measure its own label — one name never carries two numbers', () => {
    const labels = ids.map((id) => METRICS[id].label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('names the measures people confuse, and each of those exists under a different label', () => {
    for (const id of ids) {
      for (const other of (METRICS[id] as { notSameAs?: readonly string[] }).notSameAs ?? []) {
        expect(ids, `${id} → ${other}`).toContain(other);
        expect(metric(other as MetricId).label).not.toBe(METRICS[id].label);
      }
    }
  });

  it('says where every number is computed, in one sentence', () => {
    for (const id of ids) {
      const m = METRICS[id];
      expect(m.computedBy).toMatch(/^(apps\/api\/src|packages\/shared\/src)\//);
      expect(m.definition.trim().endsWith('.')).toBe(true);
      expect(m.definition.length).toBeGreaterThan(20);
    }
  });

  it('keeps the audit pairs apart: gross margin vs margin after wages, DSO vs days to pay, working vs placed', () => {
    expect(METRICS.grossMarginPct.label).toBe('Gross margin %');
    expect(METRICS.marginAfterWages.label).toBe('Margin after wages');
    expect(METRICS.scheduledMarginAfterWages.label).toBe('Scheduled margin after wages');
    expect(METRICS.daysToCollect.label).toBe('Days to collect');
    expect(METRICS.averageDaysToPay.label).toBe('Average days to pay');
    expect(METRICS.working.label).toBe('Working');
    expect(METRICS.placed.label).toBe('Placed');
    expect(METRICS.onTheBooks.label).toBe('On the books');
    expect(METRICS.turnover90d.definition).toMatch(/trailing 90 days/);
    expect(METRICS.hoursThisWeek.definition).toMatch(/Saturday/);
    expect(METRICS.openShifts.definition).toMatch(/no one assigned/);
  });
});

describe('the dictionary math', () => {
  it('gross margin % is (billed − cost) ÷ billed, null with nothing billed', () => {
    expect(marginPctOf(100, 79.2)).toBeCloseTo(20.8, 6);
    expect(marginPctOf(0, 10)).toBeNull();
  });

  it('days to collect is open AR over the 90 days’ average daily billing', () => {
    // $23,760 open on $90,000 billed in 90 days ($1,000 a day) → 23.76 days.
    expect(daysToCollectOf(23_760, 90_000)).toBeCloseTo(23.76, 6);
    expect(daysToCollectOf(5_000, 0)).toBeNull();
  });

  it('overtime risk is worked + scheduled at or past 36 hours', () => {
    expect(OVERTIME_RISK_HOURS).toBe(36);
    expect(isOvertimeRisk(35.99)).toBe(false);
    expect(isOvertimeRisk(36)).toBe(true);
  });
});
