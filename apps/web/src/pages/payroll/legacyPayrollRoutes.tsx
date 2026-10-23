import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/**
 * Retired payroll addresses (finance walk 5: each desk appears once). Old
 * bookmarks, notification links and saved Inbox rows keep working: they land
 * on the desk that now owns the work, with any other query parameters kept.
 *
 *   /payroll/tax                       → /payroll/year-end?tab=forms (W-2, 1099, 941/940 forms live on Year-end › Forms)
 *   /payroll/compliance?tab=deposits   → /payroll/taxes?tab=deposits
 *   /payroll/compliance?tab=remittances → /payroll/garnishments?tab=remittances
 *
 * One home per concept (F500 G3):
 *   /payroll/config                    → /payroll/tax-tables (Federal)
 *   /payroll/state-tax                 → /payroll/tax-tables?tab=state
 *   /payroll/tax-jurisdictions         → /payroll/tax-tables?tab=local
 *   /payroll/year-end-close            → /payroll/year-end (Checklist)
 *   /payroll/year-end/reconciliation   → /payroll/year-end?tab=reconcile
 *   /payroll/contractors?tab=year-end  → /payroll/year-end?tab=forms
 *
 * The compliance page's other tabs (new-hire reporting, pay notices, Roth
 * catch-up, paystub rules) have no other home and stay where they are.
 */

const COMPLIANCE_TAB_HOMES: Record<string, { path: string; tab: string }> = {
  deposits: { path: '/payroll/taxes', tab: 'deposits' },
  remittances: { path: '/payroll/garnishments', tab: 'remittances' },
};

/** Retired pages that are now a tab of another page: path → [page, tab] (null tab = the page's first). */
const MOVED: Record<string, [string, string | null]> = {
  '/payroll/tax': ['/payroll/year-end', 'forms'],
  '/payroll/config': ['/payroll/tax-tables', null],
  '/payroll/state-tax': ['/payroll/tax-tables', 'state'],
  '/payroll/tax-jurisdictions': ['/payroll/tax-tables', 'local'],
  '/payroll/year-end-close': ['/payroll/year-end', null],
  '/payroll/year-end/reconciliation': ['/payroll/year-end', 'reconcile'],
};

/** The address an old payroll link now opens, or null when it is still a page. */
export function legacyPayrollTarget(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  const moved = MOVED[pathname];
  if (moved) {
    // Other parameters (a state tax page's ?filter=, a reconciliation's ?year=) ride along.
    if (moved[1]) params.set('tab', moved[1]);
    else params.delete('tab');
    const qs = params.toString();
    return `${moved[0]}${qs ? `?${qs}` : ''}`;
  }
  if (pathname === '/payroll/contractors' && params.get('tab') === 'year-end') {
    params.set('tab', 'forms');
    return `/payroll/year-end?${params.toString()}`;
  }
  if (pathname === '/payroll/compliance') {
    const home = COMPLIANCE_TAB_HOMES[params.get('tab') ?? ''];
    if (!home) return null;
    params.set('tab', home.tab);
    return `${home.path}?${params.toString()}`;
  }
  return null;
}

/** A route element: redirects a retired address, else renders the page it still is. */
export function LegacyPayrollRedirect({ children = null }: { children?: ReactNode }) {
  const { pathname, search, hash } = useLocation();
  const target = legacyPayrollTarget(pathname.replace(/\/+$/, ''), search);
  if (target) return <Navigate to={`${target}${hash}`} replace />;
  return <>{children}</>;
}
