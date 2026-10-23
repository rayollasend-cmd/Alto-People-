import type { ModuleKey, ModuleNav } from './modules';

/**
 * The Pay & finance menu in five groups (finance walk 5), as data. The
 * sidebar's doors live in lib/modules.ts (builder SHELL wires this in);
 * this file only says which module belongs where, so the 27 flat links
 * become five short lists and each desk appears once:
 *
 *   Run payroll           the cycle itself, from schedules to the money leaving
 *   Taxes & filings       one desk for deposits and returns, one for forms
 *   Deductions            everything taken out of a check, or paid beside it
 *   Billing & receivables what the work is billed for (statements, pay and bill)
 *   Payroll setup         the rules payroll runs by
 *
 * Garnishments appear once (Deductions), tax deposits once (Payroll taxes),
 * readiness lives inside Run payroll's go-live and the wizard. Redirects for
 * the retired duplicates (/payroll/tax → /payroll/taxes?tab=returns,
 * /payroll/compliance tabs → their desks) belong with the routes.
 */
export interface PayMenuGroup {
  key: 'run' | 'taxes' | 'deductions' | 'billing' | 'setup';
  label: string;
  children: ModuleKey[];
}

export const PAY_MENU_GROUPS: readonly PayMenuGroup[] = [
  { key: 'run', label: 'Run payroll', children: ['payroll', 'pay-schedules', 'payroll-banking', 'manual-checks', 'daily-pay', 'earned-wage', 'payroll-go-live', 'cash-forecast'] },
  // 'payroll-tax' is Year-end, 'state-tax' is Tax tables (one home each — F500 G3).
  { key: 'taxes', label: 'Taxes & filings', children: ['payroll-taxes', 'payroll-tax', 'state-tax', 'payroll-compliance', 'wotc', 'aca', 'certified-payroll', 'contractors'] },
  { key: 'deductions', label: 'Deductions', children: ['garnishments', 'retirement', 'benefits', 'carrier-feeds', 'reimbursements', 'tuition', 'equity'] },
  { key: 'billing', label: 'Billing & receivables', children: ['statements', 'pay-bill', 'fieldglass-setup'] },
  { key: 'setup', label: 'Payroll setup', children: ['payrules', 'compensation', 'market-rates'] },
];

/** Every module the Pay & finance door names today, grouped — the coverage check SHELL's navCoverage test can read. */
export const PAY_MENU_MODULES: readonly ModuleKey[] = PAY_MENU_GROUPS.flatMap((g) => g.children);

/** One group as the sidebar draws it: a heading and the visible modules under it. */
export interface PayMenuGroupView {
  key: PayMenuGroup['key'];
  label: string;
  children: ModuleNav[];
}

/**
 * The Pay door's visible modules, in the five groups and in each group's
 * order. Groups with nothing visible are left out; a module the groups
 * don't name yet (a new desk) joins the last group rather than vanish.
 */
export function groupPayMenu(children: ModuleNav[]): PayMenuGroupView[] {
  const byKey = new Map(children.map((m) => [m.key, m]));
  const placed = new Set<string>();
  const groups: PayMenuGroupView[] = PAY_MENU_GROUPS.map((g) => {
    const items = g.children.map((k) => byKey.get(k)).filter((m): m is ModuleNav => !!m);
    for (const m of items) placed.add(m.key);
    return { key: g.key, label: g.label, children: items };
  });
  const rest = children.filter((m) => !placed.has(m.key));
  if (rest.length) groups[groups.length - 1]!.children.push(...rest);
  return groups.filter((g) => g.children.length > 0);
}
