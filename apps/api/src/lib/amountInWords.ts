/**
 * The legal amount line on a check: "One thousand one hundred sixteen and
 * 31/100 dollars". The words govern when they and the figures disagree
 * (UCC §3-114), so this is exact to the cent and never rounds.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: Array<[number, string]> = [
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

function underThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(`${ONES[h]} hundred`);
  if (rest) {
    if (rest < 20) parts.push(ONES[rest]!);
    else {
      const t = TENS[Math.floor(rest / 10)]!;
      const o = rest % 10;
      parts.push(o ? `${t}-${ONES[o]}` : t);
    }
  }
  return parts.join(' ');
}

/** Whole dollars in words, lower case ("one thousand one hundred sixteen"). */
export function dollarsInWords(whole: number): string {
  if (!Number.isInteger(whole) || whole < 0) throw new RangeError('dollarsInWords takes a non-negative whole number');
  if (whole === 0) return 'zero';
  const parts: string[] = [];
  let n = whole;
  for (const [size, name] of SCALES) {
    if (n >= size) {
      parts.push(`${underThousand(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(underThousand(n));
  return parts.join(' ');
}

/**
 * "One thousand one hundred sixteen and 31/100 dollars". Amounts are taken
 * in cents internally so binary floating point never changes a cent.
 */
export function amountInWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('amountInWords takes a non-negative amount');
  const cents = Math.round(amount * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  const words = dollarsInWords(whole);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} and ${String(frac).padStart(2, '0')}/100 dollars`;
}

/** "$****1,116.31": the figure box, filled from the left so nothing can be written in front. */
export function protectedAmount(amount: number, width = 14): string {
  const body = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${'*'.repeat(Math.max(0, width - body.length - 1))}${body}`;
}
