import { describe, expect, it } from 'vitest';
import { isSensitiveQueryKey } from '@/lib/queryPersist';

/**
 * The persisted cache is for schedules in basements, not for E-Verify
 * cases, I-9s, documents, garnishments, pay or anything carrying an SSN.
 * These are the keys the app actually uses (grep queryKey), so a renamed
 * key that stops matching shows up here before it shows up on disk.
 */
describe('isSensitiveQueryKey', () => {
  it.each([
    [['CaseDrawer', 'detail', 'assoc-1']],
    [['EVerifyTab', 'rows']],
    [['I9Tab', 'rows']],
    [['I9Task', 'status', 'app-1']],
    [['I9DocsStep', 'docs', 'app-1']],
    [['documents', 'admin', { q: '' }]],
    [['me', 'documents']],
    [['DocumentUploadTask', 'docs']],
    [['GarnishmentsView', 'rows', 'ALL']],
    [['payrollTax', 'garnishments']],
    [['payrollTax', 'forms']],
    [['payroll', 'runs', 'ALL']],
    [['PayrollYtd', 'data', 2026]],
    [['me', 'payrollItems']],
    [['me', 'paystubYtd', 'item-1']],
    [['PayoutMethodCard', 'method']],
    [['w4-recollection']],
    [['associate-w4', 'assoc-1']],
    [['W4Task', 'status', 'app-1']],
    [['external-payments', 'assoc-1']],
    [['comp-records', 'assoc-1']],
  ])('never persists %j', (key) => {
    expect(isSensitiveQueryKey(key)).toBe(true);
  });

  it.each([
    [['me', 'shifts', '2026-09-24']],
    [['scheduling', 'shifts', 'week-key']],
    [['UsersAdmin', 'rows', { q: '' }]],
    [['nav-pins', 'user-1']],
    [['holidays', 2026]],
    [['MyPlanCard', 'items', '2026-09-24', '2026-09-30']],
  ])('still persists %j', (key) => {
    expect(isSensitiveQueryKey(key)).toBe(false);
  });
});
