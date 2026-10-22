import { describe, expect, it } from 'vitest';
import { groupPayMenu, PAY_MENU_GROUPS, PAY_MENU_MODULES } from '@/lib/payMenu';
import type { ModuleNav } from '@/lib/modules';
import { DOORS } from '@/lib/modules';

/**
 * Finance walk 5: the Pay & finance door's 27+ links in five groups, each
 * module once, and none lost — every child the door names today has a group.
 */
describe('the five-group Pay menu', () => {
  it('has the five groups in order', () => {
    expect(PAY_MENU_GROUPS.map((g) => g.label)).toEqual(['Run payroll', 'Taxes & filings', 'Deductions', 'Billing & receivables', 'Payroll setup']);
  });
  it('names every module the Pay door holds, exactly once', () => {
    const door = DOORS.pay.children;
    expect([...PAY_MENU_MODULES].sort()).toEqual([...door].sort());
    expect(new Set(PAY_MENU_MODULES).size).toBe(PAY_MENU_MODULES.length);
  });
  it('groups the visible modules, drops empty groups, and keeps a module no group names', () => {
    const m = (key: string) => ({ key, label: key, path: `/${key}` }) as unknown as ModuleNav;
    const out = groupPayMenu([m('payroll'), m('garnishments'), m('brand-new-desk')]);
    expect(out.map((g) => [g.label, g.children.map((c) => c.key)])).toEqual([
      ['Run payroll', ['payroll']],
      ['Deductions', ['garnishments']],
      ['Payroll setup', ['brand-new-desk']],
    ]);
  });
});
