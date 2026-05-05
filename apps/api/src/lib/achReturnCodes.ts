/**
 * NACHA ACH return-code → plain-English mapping.
 *
 * Used by the Branch webhook handler to compose the HR-facing failure
 * reason on a returned-payment notification. The full NACHA list has
 * 80+ codes; we cover the high-frequency ones HR will actually see and
 * fall through to a generic "verify bank details" message for the rest.
 *
 * Codes intentionally NOT in the friendly map (e.g. R11 administrative,
 * R30 RDFI not participant in CCD/CTX) are rare enough that surfacing
 * the raw code with a "contact associate" prompt is cleaner than a
 * fake-precise translation that could mislead an HR rep into the
 * wrong remediation.
 */

const FRIENDLY_RETURN_REASONS: Record<string, string> = {
  R01: 'Insufficient funds',
  R02: 'Bank account closed',
  R03: 'No bank account found',
  R04: 'Invalid bank account number',
  R05: 'Unauthorized debit',
  R07: 'Authorization revoked',
  R10: 'Customer advises not authorized',
  R16: 'Bank account frozen',
};

/**
 * Translate a Branch failure_reason string into HR-readable copy.
 *
 * Branch may pass us:
 *  - a raw NACHA code: "R01"
 *  - a code with prefix: "ach_return: R01" or "R01: insufficient funds"
 *  - a free-text reason from the rail: "card_declined", "invalid_account"
 *  - null/empty (Branch-side bug or a non-ACH failure)
 *
 * We extract the first R-code if present and map it. Otherwise we
 * surface the raw reason verbatim with a generic verify-bank prompt.
 */
export function describeBranchFailure(rawReason: string | null | undefined): string {
  if (!rawReason || !rawReason.trim()) {
    return 'Payment failed. Contact associate to verify bank details.';
  }

  const codeMatch = rawReason.match(/\bR\d{2}\b/i);
  if (codeMatch) {
    const code = codeMatch[0].toUpperCase();
    const friendly = FRIENDLY_RETURN_REASONS[code];
    if (friendly) return friendly;
    return `Payment returned with code ${code}. Contact associate to verify bank details.`;
  }

  // Non-ACH failure (Branch card decline, network error). Surface what
  // Branch told us so HR isn't guessing at root cause.
  return rawReason.trim();
}
