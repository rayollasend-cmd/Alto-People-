import { describe, expect, it } from 'vitest';
import { nextInQueue, prevInQueue } from '@/lib/queueNext';

const rows = [
  { id: 'a', status: 'PENDING' },
  { id: 'b', status: 'DONE' },
  { id: 'c', status: 'PENDING' },
  { id: 'd', status: 'PENDING' },
];
const pending = (r: { status: string }) => r.status === 'PENDING';

describe('nextInQueue', () => {
  it('moves to the next eligible row after the current one', () => {
    expect(nextInQueue(rows, 'a', pending)?.id).toBe('c');
  });
  it('wraps past the end and never returns the row just decided', () => {
    expect(nextInQueue(rows, 'd', pending)?.id).toBe('a');
    expect(nextInQueue([rows[0]!], 'a', pending)).toBeNull();
  });
  it('starts from the top when the current row already left the list', () => {
    expect(nextInQueue(rows.slice(1), 'a', pending)?.id).toBe('c');
  });
  it('closes the queue honestly when nothing is left', () => {
    expect(nextInQueue(rows, 'a', () => false)).toBeNull();
    expect(nextInQueue([], 'a')).toBeNull();
  });
});

describe('prevInQueue', () => {
  it('steps back and wraps to the end', () => {
    expect(prevInQueue(rows, 'c')?.id).toBe('b');
    expect(prevInQueue(rows, 'a')?.id).toBe('d');
    expect(prevInQueue([rows[0]!], 'a')).toBeNull();
  });
});
