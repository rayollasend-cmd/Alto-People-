/**
 * Brief 2-3 step 4 — before/after with masking for the sensitive models
 * (docs/identity-rbac-audit-investigation.md §4.4). Pure: db.ts's client
 * extension reads the row before an update and hands both versions here;
 * this decides what the audit row may hold.
 *
 * Standing rule: never a secret in clear. An SSN, bank account, routing
 * number, tax id, password, token or TOTP secret is written as `••••1234`
 * (the last four, where a last four is what people already see) or
 * `[changed]`; nothing else about it.
 *
 * No imports: db.ts reads this module.
 */

/** The models whose updates carry before/after, and the fields watched on each (null = every field). */
export const AUDITED_MODELS: Record<string, readonly string[] | null> = {
  User: ['email', 'role', 'status', 'tenantRoleId', 'additionalRoles', 'activeRole', 'clientId', 'locationId', 'regionId', 'orgUnitId', 'passwordHash', 'mfaEnabledAt', 'mfaSecretEncrypted', 'deletedAt'],
  CompensationRecord: null,
  PayoutMethod: null,
  W4Submission: null,
  Employment: null,
  TaxForm: ['status', 'amounts', 'ein', 'filedAt', 'kind', 'taxYear', 'quarter'],
  TenantRole: null,
  IdentityConnection: null,
  ShiftRateDefault: null,
  TransportRate: null,
};

const IGNORED = new Set(['updatedAt', 'createdAt', 'id', 'tenantId']);
/** Shown as the last four: values whose last four people already see. */
const LAST_FOUR = /(ssn|accountNumber|routingNumber|^tin$|taxId|^ein$)/i;
/** Never shown at all. */
const SECRET = /(password|secret|token|hash|enc$|encrypted|totp|mfaSecret|fingerprint|privateKey)/i;

export function maskValue(field: string, value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (SECRET.test(field)) return '[changed]';
  if (LAST_FOUR.test(field)) {
    const s = String(value).replace(/\D/g, '');
    return s.length >= 4 ? `••••${s.slice(-4)}` : '[changed]';
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'toFixed' in value) return String(value); // Prisma.Decimal
  if (value instanceof Uint8Array) return '[changed]';
  return value;
}

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) return String(a instanceof Date ? a.toISOString() : a) === String(b instanceof Date ? b.toISOString() : b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.from(a).equals(Buffer.from(b));
  const isDecimal = (v: unknown) => typeof v === 'object' && v !== null && 'toFixed' in v;
  if (isDecimal(a) || isDecimal(b)) return String(a) === String(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b) && (a === null) === (b === null);
};

/**
 * The changed fields of an update, masked. `fields` = the keys the update
 * named (only those can have changed); a model with a watch list ignores
 * the rest. Null when nothing watched changed.
 */
export function auditDiff(
  model: string,
  fields: readonly string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const watch = AUDITED_MODELS[model];
  if (watch === undefined || !before || !after) return null;
  const changed = fields.filter((f) => !IGNORED.has(f) && (watch === null || watch.includes(f)) && f in after && !same(before[f], after[f]));
  if (!changed.length) return null;
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of changed) {
    // A secret that changed says so once, on the after side.
    if (SECRET.test(f)) {
      b[f] = before[f] === null ? null : '[set]';
      a[f] = after[f] === null ? null : '[changed]';
      continue;
    }
    b[f] = maskValue(f, before[f]);
    a[f] = maskValue(f, after[f]);
  }
  return { changed, before: b, after: a };
}

/** The scalar keys an update's `data` names, `{ set: x }` and relation writes included. */
export function updatedFields(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data as object);
}
