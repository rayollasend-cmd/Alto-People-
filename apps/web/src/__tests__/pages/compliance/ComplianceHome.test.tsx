import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ROLE_CAPABILITIES, defaultTenantProfile, type BusinessModel, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * The audit packet is the product's largest single PII export: every I-9,
 * every background check, every drug test for a period, in one zip.
 *
 * The server used to let anyone with view:hr-admin pull it — six roles,
 * including MARKETING_MANAGER — and now requires export:audit-packet, which
 * two hold. This asserts the tab moved with it. A gate that lags the server
 * is not merely cosmetic: it hands four roles a button whose only possible
 * outcome is a 403, and the person on the other end reads that as the app
 * being broken rather than as a boundary.
 */

// The tabs themselves all fetch on mount and are tested elsewhere; this is
// about which of them exist at all.
vi.mock('@/pages/compliance/I9Tab', () => ({ I9Tab: () => <div>i9</div> }));
vi.mock('@/pages/compliance/EVerifyTab', () => ({ EVerifyTab: () => <div>everify</div> }));
vi.mock('@/pages/compliance/BackgroundTab', () => ({ BackgroundTab: () => <div>background</div> }));
vi.mock('@/pages/compliance/DrugTestTab', () => ({ DrugTestTab: () => <div>drugtests</div> }));
vi.mock('@/pages/compliance/J1Tab', () => ({ J1Tab: () => <div>j1</div> }));
vi.mock('@/pages/compliance/ComplianceScorecard', () => ({
  ComplianceScorecard: () => <div>scorecard body</div>,
}));
vi.mock('@/pages/compliance/AuditPacketTab', () => ({
  AuditPacketTab: () => <div>audit packet body</div>,
}));

import { ComplianceHome } from '@/pages/compliance/ComplianceHome';

function renderAs(role: Role, path = '/compliance', model: BusinessModel = 'WORKFORCE_PROVIDER') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={{
        tenant: { id: 't1', ...defaultTenantProfile(model) },
        isInitializing: false,
        isOffline: false,
        user: {
          id: 'u',
          email: `${role.toLowerCase()}@altohr.com`,
          role,
          status: 'ACTIVE',
          clientId: null,
          associateId: null,
        },
        role,
        capabilities: new Set<Capability>(caps),
        signIn: vi.fn(),
        signOut: vi.fn(),
        can: (c: Capability) => caps.has(c),
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <ComplianceHome />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('the audit-packet tab follows the capability the server enforces', () => {
  it('shows it to a role that holds export:audit-packet', () => {
    expect(ROLE_CAPABILITIES.HR_ADMINISTRATOR.has('export:audit-packet')).toBe(true);
    renderAs('HR_ADMINISTRATOR');
    expect(screen.getByRole('tab', { name: 'Audit packets' })).toBeInTheDocument();
  });

  it('hides it from a role that only holds view:hr-admin', () => {
    // The exact pair that used to be conflated: OPERATIONS_MANAGER can read
    // the HR admin surfaces and cannot export the packet. (Marketing held
    // the same pair until 2026-10-17, the recruiter until 2026-10-21 — each
    // narrowed to its own charter.)
    expect(ROLE_CAPABILITIES.OPERATIONS_MANAGER.has('view:hr-admin')).toBe(true);
    expect(ROLE_CAPABILITIES.OPERATIONS_MANAGER.has('export:audit-packet')).toBe(false);
    renderAs('OPERATIONS_MANAGER');
    expect(screen.queryByRole('tab', { name: 'Audit packets' })).toBeNull();
  });

  it('falls back to the scorecard for a bookmarked ?tab=audit it can no longer open', () => {
    // Anyone who used this before the narrowing has the URL in their
    // history. Selecting a tab with no panel renders a blank page, which
    // reads as an outage.
    renderAs('OPERATIONS_MANAGER', '/compliance?tab=audit');
    expect(screen.getByText('scorecard body')).toBeInTheDocument();
    expect(screen.queryByText('audit packet body')).toBeNull();
  });

  it('still opens it for someone who is allowed', () => {
    renderAs('HR_ADMINISTRATOR', '/compliance?tab=audit');
    expect(screen.getByText('audit packet body')).toBeInTheDocument();
  });
});

describe('the contract scorecard and the J-1 tab follow the tenant\'s modules', () => {
  it('a staffing company sees both and lands on the scorecard', () => {
    renderAs('HR_ADMINISTRATOR');
    expect(screen.getByRole('tab', { name: 'Scorecard' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'J-1 program' })).toBeInTheDocument();
    expect(screen.getByText('scorecard body')).toBeInTheDocument();
  });

  it('a direct employer with no client contracts or programs sees neither and lands on I-9', () => {
    renderAs('HR_ADMINISTRATOR', '/compliance', 'DIRECT_EMPLOYER');
    expect(screen.queryByRole('tab', { name: 'Scorecard' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'J-1 program' })).toBeNull();
    expect(screen.getByText('i9')).toBeInTheDocument();
    // The tenant's word for a site names the requirements tab.
    expect(screen.getByRole('tab', { name: 'Property requirements' })).toBeInTheDocument();
  });

  it('a bookmarked ?tab=j1 falls back to I-9 when programs are off', () => {
    renderAs('HR_ADMINISTRATOR', '/compliance?tab=j1', 'DIRECT_EMPLOYER');
    expect(screen.queryByText('j1')).toBeNull();
    expect(screen.getByText('i9')).toBeInTheDocument();
  });
});
