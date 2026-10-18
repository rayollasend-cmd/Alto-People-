import { describe, expect, it } from 'vitest';
import { ageOn, creditFor, filingDeadline, maxCredit, statusAfterAnswers, targetGroupsFor } from '../../lib/wotc.js';

const ctx = { age: 30, zipDesignation: null, startDate: new Date('2026-07-01T00:00:00Z') } as const;

describe('WOTC target groups', () => {
  it('veteran answers resolve to the most valuable veteran group first', () => {
    const groups = targetGroupsFor({ veteran: 'yes', vetDisability: 'yes', vetUnemployed6m: 'yes', snap: 'yes' }, ctx);
    expect(groups[0]).toBe('VET_DISABLED_UNEMPLOYED');
    expect(groups).toEqual(expect.arrayContaining(['VET_UNEMPLOYED_6M', 'VET_SNAP', 'SNAP']));
  });
  it('a non-veteran never lands in a veteran group', () => {
    expect(targetGroupsFor({ vetDisability: 'yes', vetUnemployed6m: 'yes' }, ctx)).toEqual([]);
  });
  it('SNAP and designated-community residence need ages 18–39', () => {
    expect(targetGroupsFor({ snap: 'yes' }, { ...ctx, age: 45 })).toEqual([]);
    expect(targetGroupsFor({}, { ...ctx, zipDesignation: 'RRC' })).toEqual(['DCR']);
    expect(targetGroupsFor({}, { ...ctx, age: 41, zipDesignation: 'EZ' })).toEqual([]);
  });
  it('summer youth: 16–17, an empowerment zone, and a start between May 1 and September 15', () => {
    expect(targetGroupsFor({}, { age: 16, zipDesignation: 'EZ', startDate: new Date('2026-06-15T00:00:00Z') })).toEqual(['SUMMER_YOUTH']);
    expect(targetGroupsFor({}, { age: 16, zipDesignation: 'EZ', startDate: new Date('2026-10-01T00:00:00Z') })).toEqual([]);
  });
  it('unsure is not yes', () => {
    expect(targetGroupsFor({ tanf9: 'unsure', felony: 'no' }, ctx)).toEqual([]);
    expect(targetGroupsFor({ tanf18: 'yes', tanf9: 'yes' }, ctx)).toEqual(['TANF_LONG', 'TANF_SHORT']);
  });
});

describe('WOTC credit', () => {
  it('nothing under 120 hours; 25% from 120; 40% from 400, on wages up to the cap', () => {
    expect(creditFor('SNAP', 119, 5_000)).toEqual({ rate: 0, credit: 0 });
    expect(creditFor('SNAP', 120, 5_000)).toEqual({ rate: 0.25, credit: 1_250 });
    expect(creditFor('SNAP', 400, 9_000)).toEqual({ rate: 0.4, credit: 2_400 });
    expect(creditFor('VET_DISABLED_UNEMPLOYED', 600, 30_000)).toEqual({ rate: 0.4, credit: 9_600 });
    expect(creditFor(null, 600, 30_000).credit).toBe(0);
  });
  it('the most a group earns in year one', () => {
    expect(maxCredit('SUMMER_YOUTH')).toBe(1_200);
    expect(maxCredit('TANF_LONG')).toBe(4_000);
  });
  it('the state deadline is the 28th day after the start', () => {
    expect(filingDeadline(new Date('2026-07-01T00:00:00Z'))?.toISOString().slice(0, 10)).toBe('2026-07-29');
    expect(filingDeadline(null)).toBeNull();
  });
  it('age on the start date, and the status the answers leave', () => {
    expect(ageOn(new Date('2008-07-02T00:00:00Z'), new Date('2026-07-01T00:00:00Z'))).toBe(17);
    expect(ageOn(null, new Date())).toBeNull();
    expect(statusAfterAnswers(true, ['SNAP'])).toBe('DECLINED');
    expect(statusAfterAnswers(false, [])).toBe('NOT_ELIGIBLE');
    expect(statusAfterAnswers(false, ['SNAP'])).toBe('LIKELY_ELIGIBLE');
  });
});
