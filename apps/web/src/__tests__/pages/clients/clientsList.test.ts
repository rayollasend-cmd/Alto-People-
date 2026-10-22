import { describe, expect, it } from 'vitest';
import type { ClientListItem } from '@alto-people/shared';
import { NO_FILTERS, billedRange, builtInViewOf, contractEnding, fromQuery, matches, nextSort, numbersLine, sortClients, toQuery, viewCounts, type ListState } from '@/pages/clients/clientsList';

const c = (over: Partial<ClientListItem>): ClientListItem => ({
  id: 'x',
  name: 'X',
  industry: null,
  status: 'ACTIVE',
  contactEmail: null,
  state: null,
  openApplications: 0,
  activeAssociateCount: 0,
  lastPayrollDisbursedAt: null,
  ...over,
});

describe('the clients list rules', () => {
  it('reads the billed range off today', () => {
    expect(billedRange('month', '2026-10-22')).toEqual({ from: '2026-10-01', to: '2026-10-22', short: 'Oct' });
    expect(billedRange('lastMonth', '2026-10-22')).toEqual({ from: '2026-09-01', to: '2026-09-30', short: 'Sep' });
    expect(billedRange('lastMonth', '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31', short: 'Dec' });
    expect(billedRange('lastMonth', '2028-03-01')).toEqual({ from: '2028-02-01', to: '2028-02-29', short: 'Feb' });
    expect(billedRange('quarter', '2026-11-15')).toEqual({ from: '2026-10-01', to: '2026-11-15', short: 'Q4' });
    expect(billedRange('ytd', '2026-10-22')).toEqual({ from: '2026-01-01', to: '2026-10-22', short: '2026' });
  });

  it('writes a list into URL params and a saved view and reads it back', () => {
    const s: ListState = { filters: { ...NO_FILTERS, attention: true, status: 'ACTIVE' }, q: ' harbor ', sort: { key: 'outstanding', direction: 'desc' }, range: 'quarter', hidden: ['owner'] };
    const q = toQuery(s, { cols: true, defaultHidden: ['industry'] });
    expect(q).toEqual({ status: 'ACTIVE', attention: '1', q: 'harbor', sort: 'outstanding', dir: 'desc', range: 'quarter', cols: 'owner' });
    expect(fromQuery(q, { hidden: ['industry'] })).toEqual({ ...s, q: 'harbor' });
    // Defaults stay out: the plain list is a bare URL; the default columns are not written.
    expect(toQuery({ filters: NO_FILTERS, q: '', sort: { key: 'name', direction: 'asc' }, range: 'month', hidden: ['industry'] }, { cols: true, defaultHidden: ['industry'] })).toEqual({});
    // Every column on is written, so it can be told apart from "the defaults".
    expect(toQuery({ filters: NO_FILTERS, q: '', sort: { key: 'name', direction: 'asc' }, range: 'month', hidden: [] }, { cols: true, defaultHidden: ['industry'] })).toEqual({ cols: '-' });
    expect(fromQuery({ cols: '-' }, { hidden: ['industry'] }).hidden).toEqual([]);
    // Junk is ignored, never trusted.
    expect(fromQuery({ status: 'NOPE', sort: 'dropTable', range: 'forever' }, { hidden: [] })).toMatchObject({ filters: NO_FILTERS, sort: { key: 'name', direction: 'asc' }, range: 'month' });
  });

  it('names the built-in view the filters are, and nothing for a mix', () => {
    expect(builtInViewOf(NO_FILTERS)).toBe('all');
    expect(builtInViewOf({ ...NO_FILTERS, status: 'INACTIVE' })).toBe('inactive');
    expect(builtInViewOf({ ...NO_FILTERS, attention: true, mine: true })).toBeNull();
  });

  it('counts a contract as ending from 30 days ago to 60 days ahead', () => {
    const today = '2026-10-22';
    expect(contractEnding(c({ contractEndDate: '2026-12-21' }), today)).toBe(true);
    expect(contractEnding(c({ contractEndDate: '2026-12-22' }), today)).toBe(false);
    expect(contractEnding(c({ contractEndDate: '2026-09-22' }), today)).toBe(true);
    expect(contractEnding(c({ contractEndDate: '2026-09-21' }), today)).toBe(false);
    expect(contractEnding(c({ contractEndDate: null }), today)).toBe(false);
  });

  it('filters by owner, health and status, and counts each view', () => {
    const rows = [c({ id: 'a', health: 'risk', accountOwner: { id: 'me', name: 'Me' } }), c({ id: 'b', health: 'good', status: 'INACTIVE' }), c({ id: 'c', health: 'watch' })];
    const ctx = { me: 'me', today: '2026-10-22' };
    expect(rows.filter((r) => matches(r, { ...NO_FILTERS, attention: true }, ctx)).map((r) => r.id)).toEqual(['a', 'c']);
    expect(rows.filter((r) => matches(r, { ...NO_FILTERS, mine: true }, { ...ctx, me: null })).map((r) => r.id)).toEqual([]);
    expect(viewCounts(rows, ctx)).toEqual({ all: 3, attention: 2, mine: 1, ending: 0, inactive: 1 });
  });

  it('sorts worst health first and sinks unknowns either way', () => {
    const rows = [c({ name: 'B', health: 'good', fillRatePct: null }), c({ name: 'A', health: 'risk', fillRatePct: 70 }), c({ name: 'C', health: 'watch', fillRatePct: 90 })];
    expect(sortClients(rows, { key: 'health', direction: 'asc' }).map((r) => r.name)).toEqual(['A', 'C', 'B']);
    expect(sortClients(rows, { key: 'fillRate', direction: 'asc' }).map((r) => r.name)).toEqual(['A', 'C', 'B']);
    expect(sortClients(rows, { key: 'fillRate', direction: 'desc' }).map((r) => r.name)).toEqual(['C', 'A', 'B']);
    expect(nextSort({ key: 'name', direction: 'asc' }, 'fillRate')).toEqual({ key: 'fillRate', direction: 'asc' });
    expect(nextSort({ key: 'fillRate', direction: 'asc' }, 'fillRate')).toEqual({ key: 'fillRate', direction: 'desc' });
    expect(nextSort({ key: 'fillRate', direction: 'desc' }, 'fillRate')).toEqual({ key: 'name', direction: 'asc' });
  });

  it('puts only what is known on the phone row', () => {
    expect(numbersLine(c({ onAssignment: 12, fillRatePct: 94.4, outstanding: 5760 }))).toBe('12 on assignment · 94% filled · $5.8k due');
    expect(numbersLine(c({ onAssignment: 3, fillRatePct: null, hoursThisWeek: 80.4 }))).toBe('3 on assignment · 80h this week');
    expect(numbersLine(c({ activeAssociateCount: 0, outstanding: 0 }))).toBe('0 on assignment');
  });
});
