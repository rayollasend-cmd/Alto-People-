import { describe, expect, it } from 'vitest';
import { enumWords, known } from '@/lib/known';

describe('known', () => {
  const STATUS = { OPEN: { label: 'Open' }, CLOSED: { label: 'Closed' } };
  it('reads a value the screen knows from its map', () => {
    expect(known(STATUS, 'OPEN', (k) => ({ label: k })).label).toBe('Open');
  });
  it('a value the server added later reads as words instead of crashing', () => {
    expect(known(STATUS, 'PENDING_REVIEW', (k) => ({ label: enumWords(k) })).label).toBe('Pending review');
    expect(known(STATUS, null, (k) => ({ label: enumWords(k) })).label).toBe('—');
    // Not fooled by what every object inherits.
    expect(known(STATUS, 'toString', (k) => ({ label: enumWords(k) })).label).toBe('Tostring');
  });
});
