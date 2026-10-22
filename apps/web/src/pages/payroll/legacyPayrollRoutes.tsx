import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/**
 * Retired payroll addresses (finance walk 5: each desk appears once). Old
 * bookmarks, notification links and saved Inbox rows keep working: they land
 * on the desk that now owns the work, with any other query parameters kept.
 *
 *   /payroll/tax                       → /payroll/taxes?tab=returns (tax forms live on the Returns tab)
 *   /payroll/compliance?tab=deposits   → /payroll/taxes?tab=deposits
 *   /payroll/compliance?tab=remittances → /payroll/garnishments?tab=remittances
 *
 * The compliance page's other tabs (new-hire reporting, pay notices, Roth
 * catch-up, paystub rules) have no other home and stay where they are.
 */

const COMPLIANCE_TAB_HOMES: Record<string, { path: string; tab: string }> = {
  deposits: { path: '/payroll/taxes', tab: 'deposits' },
  remittances: { path: '/payroll/garnishments', tab: 'remittances' },
};

/** The address an old payroll link now opens, or null when it is still a page. */
export function legacyPayrollTarget(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  if (pathname === '/payroll/tax') {
    params.set('tab', 'returns');
    return `/payroll/taxes?${params.toString()}`;
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
