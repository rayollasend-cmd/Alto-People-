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
    // Widened 2026-10-12 (Brief 1B-2): pay, identity documents, health,
    // discipline and credentials that the first list had let through.
    [['me', 'earnings']],
    [['me', 'earnings-rate']],
    [['Section2Verifier', 'docs', 'app-1']],
    [['J1DocsTask', 'docs', 'app-1']],
    [['J1Tab', 'profiles']],
    [['BackgroundTab', 'checks']],
    [['BulkOrderDialog', 'pending']],
    [['DrugTestTab', 'tests']],
    [['kiosk-pin', 'assoc-1']],
    [['kiosk', 'pins']],
    [['kiosk', 'config', 'altokiosk_token']],
    [['FinancialChangesQueue', 'list']],
    [['RateDefaultsSection', 'defaults', 'client-1']],
    [['application', 'app-1']],
    [['ProfileInfoTask', 'state', 'app-1']],
    [['InPersonOnboarding', 'application', 'app-1']],
    [['AssociateChecklist', 'application', 'app-1']],
    [['hrCases', 'case', 'case-1']],
    [['DisciplineHome', 'rows']],
    [['MyDiscipline', 'actions']],
    [['NewRecordDrawer', 'doseNumber', 'assoc-1']],
    [['vaccinations', 'rows']],
    [['BenefitsHome', 'enrollments']],
    [['CobraTab', 'rows']],
    [['QleTab', 'rows']],
    [['OeTab', 'rows']],
    [['BranchEnrollmentDialog', 'enrollment', 'assoc-1']],
    [['ReimbursementDrawer', 'data', 'r-1']],
    [['ReimbursementsHome', 'rows']],
    [['EquityHome', 'mine']],
    [['equityGrant', 'g-1']],
    [['TuitionHome', 'queue']],
    [['mfa', 'status']],
    [['PasskeysCard', 'passkeys']],
    [['login-history']],
    [['transport', 'charges', '2026-10-01']],
    [['timesheets', 'detail', 'ts-1']],
    [['team', 'timesheets']],
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
    [['transport', 'driver']],
    [['directory', 'picker', 'jo']],
    [['palette', 'people', 'jo']],
    [['storeScope', 'clients', true]],
    [['auth', 'oidc-config']],
    [['scheduling', 'top-candidate', 'shift-1']],
    [['compliance', 'scorecard', 'shifts', '']],
  ])('still persists %j', (key) => {
    expect(isSensitiveQueryKey(key)).toBe(false);
  });
});
