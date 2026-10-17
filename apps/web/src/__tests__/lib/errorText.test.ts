import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { errorText } from '@/lib/errorText';
import { pickOne, withArticle } from '@/lib/validationCopy';

/**
 * errorText is the one place a failed mutation turns into a sentence: the
 * API's own message when it has one, else the caller's specific fallback.
 * A bare "Failed." is what it retires.
 */
describe('errorText', () => {
  it('prefers the API message when there is one', () => {
    const err = new ApiError(409, 'CONFLICT', 'That rule already exists.');
    expect(errorText(err, "Couldn't save the pay rule.")).toBe('That rule already exists.');
  });

  it('falls back when the API message is blank', () => {
    expect(errorText(new ApiError(500, 'INTERNAL', '   '), "Couldn't save the pay rule.")).toBe("Couldn't save the pay rule.");
  });

  it('falls back for non-API errors and non-errors', () => {
    expect(errorText(new TypeError('x is not a function'), "Couldn't export the report.")).toBe("Couldn't export the report.");
    expect(errorText('oops', "Couldn't export the report.")).toBe("Couldn't export the report.");
    expect(errorText(undefined, "Couldn't export the report.")).toBe("Couldn't export the report.");
  });
});

describe('pickOne', () => {
  const staffing = (key: string) => ({ worker: 'Associate', site: 'Store', manager: 'Manager' })[key] ?? key;
  const hotel = (key: string) => ({ worker: 'Team member', site: 'Property', manager: 'Property manager' })[key] ?? key;

  it('builds the sentence from the tenant word with the right article', () => {
    expect(pickOne(staffing as never)).toBe('Pick an associate.');
    expect(pickOne(hotel as never)).toBe('Pick a team member.');
    expect(pickOne(staffing as never, 'site')).toBe('Pick a store.');
  });

  it('withArticle chooses by first letter', () => {
    expect(withArticle('employee')).toBe('an employee');
    expect(withArticle('Property')).toBe('a Property');
  });
});
