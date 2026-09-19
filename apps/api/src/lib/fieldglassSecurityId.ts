/**
 * The Fieldglass Security ID — how Alto identifies a worker to the buyer's
 * Fieldglass without sending a full SSN:
 *
 *   MM DD   month and day of birth            03 14
 *   LL      first two letters of last name    RE   (Reyes)
 *   NNN     last three digits of the SSN      789
 *
 * → "0314RE789". A worker with no SSN uses the last three characters of
 * their passport / travel document number instead.
 *
 * Built from PII, so only finance sees it, and every look is audited with
 * the rest of the registration packet.
 */

export interface SecurityIdInput {
  dob: Date | string | null;
  lastName: string;
  ssnLast4: string | null;
  travelDocLast4: string | null;
}

export interface SecurityId {
  /** Null until every part is on file. */
  value: string | null;
  /** Where the last three came from. */
  source: 'ssn' | 'travel_doc' | null;
  /** What's still needed, in words ("Date of birth"). */
  needs: string[];
}

/** "Núñez" → "NU", "O'Brien" → "OB", "de la Cruz" → "DE". */
export function lastNameLetters(lastName: string): string {
  return lastName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 2)
    .toUpperCase();
}

export function fieldglassSecurityId(input: SecurityIdInput): SecurityId {
  const needs: string[] = [];
  let mmdd: string | null = null;
  if (input.dob) {
    const iso = typeof input.dob === 'string' ? input.dob.slice(0, 10) : input.dob.toISOString().slice(0, 10);
    const [, m, d] = iso.split('-');
    if (m && d) mmdd = `${m}${d}`;
  }
  if (!mmdd) needs.push('Date of birth');

  const letters = lastNameLetters(input.lastName);
  if (letters.length < 2) needs.push('Last name (two letters)');

  const ssn = (input.ssnLast4 ?? '').replace(/\D/g, '');
  const doc = (input.travelDocLast4 ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  let tail: string | null = null;
  let source: SecurityId['source'] = null;
  if (ssn.length >= 3) {
    tail = ssn.slice(-3);
    source = 'ssn';
  } else if (doc.length >= 3) {
    tail = doc.slice(-3);
    source = 'travel_doc';
  } else {
    needs.push('Last 4 of SSN — or of a passport / travel document');
  }

  return {
    value: needs.length === 0 ? `${mmdd}${letters}${tail}` : null,
    source,
    needs,
  };
}
