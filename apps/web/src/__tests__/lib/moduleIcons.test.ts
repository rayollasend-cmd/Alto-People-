import { describe, expect, it } from 'vitest';
import {
  BarChart3,
  BookUser,
  Bot,
  Building2,
  CalendarDays,
  CalendarPlus,
  Clock,
  Cpu,
  House,
  MapPin,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
  Wallet,
} from '@/components/ui/icons';
import { DOORS, MODULES, type DoorKey, type ModuleKey } from '@/lib/modules';
import { DASHBOARD_ICON, DOOR_ICONS, MODULE_ICONS } from '@/lib/moduleIcons';

/**
 * In a rail that is icons only, the glyph IS the label: two modules with
 * the same icon are one module to the eye. These pin the two rules the
 * icon map lives by — every module and door has an icon, and no two
 * modules share one — plus the meaning table in docs/design-system.md §6.
 */

/** The display name each icon component carries (its Phosphor glyph), for a readable failure. */
function nameOf(icon: unknown): string {
  const c = icon as { displayName?: string; name?: string };
  return c.displayName ?? c.name ?? String(icon);
}

describe('MODULE_ICONS', () => {
  it('gives every module in the nav an icon', () => {
    for (const m of MODULES) {
      expect(MODULE_ICONS[m.key], `module "${m.key}" has no icon`).toBeTypeOf('object');
    }
  });

  it('no two modules share a glyph (compared by component reference, so names mapped to one Phosphor glyph count as the same)', () => {
    const byIcon = new Map<unknown, ModuleKey[]>();
    for (const [key, icon] of Object.entries(MODULE_ICONS) as [ModuleKey, unknown][]) {
      byIcon.set(icon, [...(byIcon.get(icon) ?? []), key]);
    }
    const shared = [...byIcon.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([icon, keys]) => `${nameOf(icon)}: ${keys.join(', ')}`);
    expect(shared, shared.join('\n')).toEqual([]);
  });

  it('follows the meaning table in design-system §6', () => {
    expect(MODULE_ICONS.analytics).toBe(BarChart3);
    expect(MODULE_ICONS.clients).toBe(Building2);
    expect(MODULE_ICONS.compliance).toBe(ShieldCheck);
    expect(MODULE_ICONS.payroll).toBe(Wallet);
    expect(MODULE_ICONS.scheduling).toBe(CalendarDays);
    expect(MODULE_ICONS['time-attendance']).toBe(Clock);
    expect(MODULE_ICONS.people).toBe(Users);
    expect(MODULE_ICONS.agents).toBe(Bot);
    expect(MODULE_ICONS.audit).toBe(ScrollText);
    expect(MODULE_ICONS.settings).toBe(Settings2);
    // One glyph per kind of worker, the same in the rail, the roster, Tasks and the Control Room.
    expect(MODULE_ICONS.robots).toBe(Cpu);
    expect(MODULE_ICONS.workers).toBe(BookUser);
  });

  it('the pairs that used to collide are told apart', () => {
    // Sites are places, clients are companies.
    expect(MODULE_ICONS.sites).toBe(MapPin);
    expect(MODULE_ICONS.sites).not.toBe(MODULE_ICONS.clients);
    // Open shifts is a calendar, not a storefront.
    expect(MODULE_ICONS.marketplace).toBe(CalendarPlus);
    expect(MODULE_ICONS.agents).not.toBe(MODULE_ICONS.workers);
    expect(MODULE_ICONS.reliability).not.toBe(MODULE_ICONS.benefits);
    expect(MODULE_ICONS.pulse).not.toBe(MODULE_ICONS.reliability);
    expect(MODULE_ICONS.headcount).not.toBe(MODULE_ICONS.analytics);
    expect(MODULE_ICONS.compensation).not.toBe(MODULE_ICONS.payroll);
    expect(MODULE_ICONS.equity).not.toBe(MODULE_ICONS.compensation);
    expect(new Set([MODULE_ICONS.learning, MODULE_ICONS.mentorship, MODULE_ICONS.tuition]).size).toBe(3);
  });

  it('Home is a house', () => {
    expect(DASHBOARD_ICON).toBe(House);
  });
});

describe('DOOR_ICONS', () => {
  it('gives every door an icon', () => {
    for (const key of Object.keys(DOORS) as DoorKey[]) {
      expect(DOOR_ICONS[key], `door "${key}" has no icon`).toBeTypeOf('object');
    }
  });
});
