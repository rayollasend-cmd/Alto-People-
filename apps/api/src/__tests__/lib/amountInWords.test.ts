import { describe, expect, it } from 'vitest';
import { amountInWords, dollarsInWords, protectedAmount } from '../../lib/amountInWords.js';

describe('the legal amount line', () => {
  it('writes every scale exactly, to the cent', () => {
    expect(amountInWords(1116.31)).toBe('One thousand one hundred sixteen and 31/100 dollars');
    expect(amountInWords(0.07)).toBe('Zero and 07/100 dollars');
    expect(amountInWords(40)).toBe('Forty and 00/100 dollars');
    expect(amountInWords(19.99)).toBe('Nineteen and 99/100 dollars');
    expect(amountInWords(2_000_015.5)).toBe('Two million fifteen and 50/100 dollars');
    expect(amountInWords(1_234_567.89)).toBe('One million two hundred thirty-four thousand five hundred sixty-seven and 89/100 dollars');
    expect(dollarsInWords(100_000)).toBe('one hundred thousand');
    expect(dollarsInWords(1_000_000_001)).toBe('one billion one');
  });

  it('never loses a cent to floating point', () => {
    expect(amountInWords(0.29)).toBe('Zero and 29/100 dollars');
    expect(amountInWords(1.005 + 0.000001)).toBe('One and 01/100 dollars');
    expect(amountInWords(4.35)).toBe('Four and 35/100 dollars');
  });

  it('refuses a negative or non-finite amount', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError);
    expect(() => amountInWords(Number.NaN)).toThrow(RangeError);
  });

  it('fills the figure box from the left', () => {
    expect(protectedAmount(1116.31)).toBe('$*****1,116.31');
    expect(protectedAmount(12.5, 10)).toBe('$****12.50');
  });
});
