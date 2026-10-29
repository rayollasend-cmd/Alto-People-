/**
 * My schedule's month grid runs on payroll's week: each row is one Sat→Fri
 * workweek (lib/workweek), like the week view, the list and overtime.
 */

/** Sunday-indexed weekday names rotated to start on Saturday, for the month grid's header. */
export function saturdayFirst<T>(sundayFirst: T[]): T[] {
  return [sundayFirst[6]!, ...sundayFirst.slice(0, 6)];
}

/** Blank cells before the 1st in a Saturday-first grid. */
export function leadingBlanks(monthStart: Date): number {
  return (monthStart.getDay() + 1) % 7;
}
