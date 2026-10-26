/**
 * Numbers the assistant never needs, found in free text.
 *
 * Hugo answers from the person's own records — he never needs their Social
 * Security number or a bank account, and either typed into a chat would sit
 * in a model's context, a supervisor's hand-off thread, or the WhatsApp log.
 * The app stops a message that carries one before it is sent (and says
 * why); the API strips any that still get through, before the words go
 * anywhere.
 *
 *   ssn      nine digits, run together or as 123-45-6789 / 123 45 6789
 *            (a routing number is nine digits too — caught the same way)
 *   account  a run of 12–19 digits, spaces or dashes allowed: an account
 *            or card number
 *
 * Phone numbers (10–11 digits), dates and times don't match either.
 */
export type SensitiveNumberKind = 'ssn' | 'account';

const SSN = /(?<![\d-])\d{3}([- ]?)\d{2}\1\d{4}(?![\d-])/g;
const ACCOUNT = /(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/g;

export const REMOVED_NUMBER = '[number removed]';

/** Which kinds of sensitive number the text carries (empty when none). */
export function findSensitiveNumbers(text: string): SensitiveNumberKind[] {
  const kinds: SensitiveNumberKind[] = [];
  if (new RegExp(ACCOUNT.source).test(text)) kinds.push('account');
  if (new RegExp(SSN.source).test(text.replace(new RegExp(ACCOUNT.source, 'g'), ' '))) kinds.push('ssn');
  return kinds;
}

/** The text with every sensitive number replaced by "[number removed]". */
export function redactSensitiveNumbers(text: string): string {
  return text.replace(new RegExp(ACCOUNT.source, 'g'), REMOVED_NUMBER).replace(new RegExp(SSN.source, 'g'), REMOVED_NUMBER);
}
