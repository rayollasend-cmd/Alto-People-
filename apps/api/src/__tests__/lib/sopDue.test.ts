import { describe, expect, it } from 'vitest';
import { dueInstants, dueMinute, isDueTime } from '../../lib/sopDue.js';

/** "By 9:00 AM" on the shift's own clock, at the store. */

const NY = 'America/New_York';
const at = (d: Date | null) =>
  d?.toLocaleString('en-US', { timeZone: NY, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

describe('SOP due times', () => {
  it('parses HH:MM and refuses anything else', () => {
    expect(dueMinute('07:30')).toBe(450);
    expect(dueMinute('23:59')).toBe(1439);
    expect(dueMinute(null)).toBeNull();
    expect(isDueTime('7:30')).toBe(false);
    expect(isDueTime('24:00')).toBe(false);
    expect(isDueTime('12:60')).toBe(false);
  });

  it('an overnight run owes its early-morning blocks the morning after it opened', () => {
    // Thu Sep 17, 10 PM EDT.
    const due = dueInstants(['22:30', '00:00', '02:00', '07:00'], new Date('2026-09-18T02:00:00Z'), NY);
    expect(due.map(at)).toEqual(['Sep 17, 10:30 PM', 'Sep 18, 12:00 AM', 'Sep 18, 2:00 AM', 'Sep 18, 7:00 AM']);
  });

  it('a run opened late still owes its early blocks — they are overdue, not tomorrow', () => {
    // A 7–4 morning SOP opened at 10:30 AM.
    const due = dueInstants(['07:30', '09:30', '16:00'], new Date('2026-09-18T14:30:00Z'), NY);
    expect(due.map(at)).toEqual(['Sep 18, 7:30 AM', 'Sep 18, 9:30 AM', 'Sep 18, 4:00 PM']);
    // An overnight opened by hand at 5 AM: its 10:30 PM block was last night.
    const late = dueInstants(['22:30', '07:00'], new Date('2026-09-18T09:00:00Z'), NY);
    expect(late.map(at)).toEqual(['Sep 17, 10:30 PM', 'Sep 18, 7:00 AM']);
  });

  it('untimed items stay untimed, and the store clock holds across the fall-back night', () => {
    expect(dueInstants([null, null], new Date(), NY)).toEqual([null, null]);
    const due = dueInstants(['22:30', null, '02:00', '07:00'], new Date('2026-11-01T02:00:00Z'), NY);
    expect(due.map(at)).toEqual(['Oct 31, 10:30 PM', undefined, 'Nov 1, 2:00 AM', 'Nov 1, 7:00 AM']);
  });
});
