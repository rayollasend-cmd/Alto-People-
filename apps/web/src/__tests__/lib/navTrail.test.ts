import { describe, expect, it } from 'vitest';
import { defaultTerminologyFor, ROLE_CAPABILITIES, type Capability, type Role, type TermKey } from '@alto-people/shared';
import { applyTerms, navShapeFor, roleNavLabels, visibleModules } from '@/lib/modules';
import { areaCrumbs, navCrumbs, tidyCrumbs, type AreaTrail } from '@/lib/navTrail';

/**
 * Breadcrumbs in the sidebar's own words (lib/navTrail): the door and the
 * parent page a module sits under for THIS person, so a trail can't say
 * "Workforce › Performance" where no Workforce exists. One helper, used by
 * every page header that doesn't write its own.
 */
/** The staffing tenant's own words (the default terminology). */
const TERMS = defaultTerminologyFor('WORKFORCE_PROVIDER');
const term = (k: TermKey) => TERMS[k]?.en ?? k;

function modelFor(role: Role) {
  const caps = ROLE_CAPABILITIES[role];
  const can = (c: Capability) => caps.has(c);
  const visible = roleNavLabels(applyTerms(visibleModules(role, can, {}), term), role, () => 'Paystubs');
  return { visible, shape: navShapeFor(visible, role, term), term };
}

const crumbs = (role: Role, pathname: string, leaf?: string) => navCrumbs({ pathname, ...modelFor(role), leaf });

describe('navCrumbs', () => {
  it('a module under another module’s path names that page as its parent (and Back goes there)', () => {
    expect(crumbs('HR_ADMINISTRATOR', '/payroll/banking')).toEqual([{ label: 'Payroll', to: '/payroll' }, { label: 'Payroll banking' }]);
  });

  it('a module root sits under the door the sidebar shows it behind', () => {
    expect(crumbs('HR_ADMINISTRATOR', '/documents')).toEqual([{ label: 'Compliance', to: '/compliance' }, { label: 'Documents' }]);
  });

  it('a page below a module ends with the page’s own name, the module linked above it', () => {
    const c = crumbs('HR_ADMINISTRATOR', '/performance/calibration', 'Review calibration')!;
    expect(c[c.length - 1]).toEqual({ label: 'Review calibration' });
    expect(c[c.length - 2]).toEqual({ label: 'Performance', to: '/performance' });
    expect(c.map((s) => s.label)).not.toContain('Workforce');
  });

  it('the jargon-free label: "Store leads" under Scheduling, in the tenant’s word for a site', () => {
    expect(crumbs('HR_ADMINISTRATOR', '/scheduling/supervisors')).toEqual([{ label: 'Scheduling', to: '/scheduling' }, { label: 'Store leads' }]);
  });

  it('a page that IS its door’s first page has no parent, so no trail', () => {
    expect(crumbs('HR_ADMINISTRATOR', '/compliance')).toBeNull();
    // The associate's pay page opens "My pay" — nothing above it.
    expect(crumbs('ASSOCIATE', '/payroll')).toBeNull();
  });

  it('two steps to the same place collapse into the more specific one', () => {
    // "Me" (→ /me) and "My profile" (/me) are one place: the trail says My profile.
    expect(crumbs('ASSOCIATE', '/me/pay-notices', 'Pay notices')).toEqual([{ label: 'My profile', to: '/me' }, { label: 'Pay notices' }]);
  });

  it('off the nav, there is no trail to invent', () => {
    expect(crumbs('HR_ADMINISTRATOR', '/settings', 'Account settings')).toBeNull();
    expect(crumbs('HR_ADMINISTRATOR', '/', 'Home')).toBeNull();
  });
});

describe('tidyCrumbs', () => {
  it('drops a lone crumb that repeats the title; keeps a real trail', () => {
    expect(tidyCrumbs([{ label: 'People' }], 'People')).toBeNull();
    expect(tidyCrumbs([{ label: 'People', to: '/people' }, { label: 'Mass update' }], 'Mass update')).toHaveLength(2);
    expect(tidyCrumbs([], 'x')).toBeNull();
  });
});

describe('areaCrumbs — a page inside Settings & trust takes its trail from the rail', () => {
  const trail: AreaTrail = {
    area: { label: 'Settings & trust', to: '/admin' },
    rail: [
      { label: 'Users & access', to: '/admin/users', section: 'Access & trust' },
      { label: 'Integrations', to: '/integrations', section: 'Platform' },
      { label: 'Regions & places', to: '/org/chart?view=field', section: 'Organization' },
    ],
  };

  it('the rail item’s own page: area › section › page', () => {
    expect(areaCrumbs(trail, '/admin/users', 'Whatever the page called itself')).toEqual([
      { label: 'Settings & trust', to: '/admin' },
      { label: 'Access & trust' },
      { label: 'Users & access' },
    ]);
  });

  it('a page below a rail item: the item becomes a link and the page names itself', () => {
    expect(areaCrumbs(trail, '/integrations/connections/c1', 'Workday')).toEqual([
      { label: 'Settings & trust', to: '/admin' },
      { label: 'Platform' },
      { label: 'Integrations', to: '/integrations' },
      { label: 'Workday' },
    ]);
  });

  it('matches a rail item by its path alone (a query in `to` is a view, not a different page)', () => {
    expect(areaCrumbs(trail, '/org/chart', null)?.at(-1)).toEqual({ label: 'Regions & places' });
  });

  it('a page the rail does not hold (the overview) keeps its own', () => {
    expect(areaCrumbs(trail, '/admin', 'Settings & trust')).toBeNull();
  });
});
