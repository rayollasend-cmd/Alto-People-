import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { apiFetch } from '@/lib/api';
import { AccessCertificationPage, AccessCertifications } from '@/pages/admin/AccessCertifications';

/**
 * Access pack — the certification page: the owner opens a campaign, a
 * reviewer decides their own rows (a note is required for anything but
 * keep), and closing waits for every row.
 */

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

function renderAt(path: string, caps: Capability[] = ['manage:org', 'view:hr-admin']) {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u-owner', email: 'owner@example.com', role: 'HR_ADMINISTRATOR' as const, status: 'ACTIVE' as const, clientId: null, associateId: null },
    role: 'HR_ADMINISTRATOR' as const,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.includes(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={value}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/admin/access-certifications" element={<AccessCertifications />} />
              <Route path="/admin/access-certifications/:id" element={<AccessCertificationPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const summary = {
  id: 'c1',
  name: 'Q4 staff access',
  scope: 'INTERNAL',
  status: 'OPEN',
  dueAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-10-17T00:00:00.000Z',
  closedAt: null,
  items: 2,
  decided: 0,
  revoke: 0,
  change: 0,
  mine: 1,
};

const person = (id: string, email: string, name: string | null = null) => ({ id, email, name, role: 'MANAGER', status: 'ACTIVE' });

beforeEach(() => fetchMock.mockReset());

describe('<AccessCertifications>', () => {
  it('lists campaigns with what is owed, and offers to open one to someone who runs access', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/admin/access-certifications') return { runs: true, certifications: [summary] };
      // Chrome hooks (a prefetch, a probe) may ask for other things; they are not this test's business.
      return undefined;
    });
    renderAt('/admin/access-certifications');
    expect(await screen.findByRole('link', { name: 'Q4 staff access' })).toHaveAttribute('href', '/admin/access-certifications/c1');
    expect(screen.getByText('1 for you')).toBeInTheDocument();
    expect(screen.getByText('0% decided')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open a certification/i })).toBeInTheDocument();
  });

  it('hides the open button from a reviewer who does not run access', async () => {
    fetchMock.mockResolvedValue({ runs: false, certifications: [] });
    renderAt('/admin/access-certifications', ['view:dashboard']);
    expect(await screen.findByText('No certification yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open a certification/i })).not.toBeInTheDocument();
  });
});

describe('<AccessCertificationPage>', () => {
  it('a revoke needs a note; keep records at once; close waits for every row', async () => {
    const detail = {
      ...summary,
      runs: true,
      items: [
        { id: 'i1', subject: person('u-rae', 'rae@example.com', 'Rae Report'), reviewer: person('u-owner', 'owner@example.com'), snapshot: { role: 'INTERNAL_RECRUITER', lastSeenAt: '2026-10-01T00:00:00Z' }, decision: null, note: null, decidedBy: null, decidedAt: null, mine: true },
        { id: 'i2', subject: person('u-mia', 'mia@example.com', 'Mia Manager'), reviewer: person('u-owner', 'owner@example.com'), snapshot: { role: 'MANAGER', lastSeenAt: null }, decision: null, note: null, decidedBy: null, decidedAt: null, mine: true },
      ],
    };
    const decided: Array<{ path: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/admin/access-certifications/c1') return detail;
      if (typeof path === 'string' && path.includes('/decide')) {
        decided.push({ path, body: init?.body });
        return undefined;
      }
      return undefined;
    });
    renderAt('/admin/access-certifications/c1');
    expect(await screen.findByRole('heading', { name: 'Q4 staff access' })).toBeInTheDocument();
    expect(screen.getByText('Rae Report')).toBeInTheDocument();
    expect(screen.getByText(/never signed in/)).toBeInTheDocument();
    // What is owed sits in the header's facts.
    expect(screen.getByText('Waiting on you').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Decided').nextElementSibling).toHaveTextContent('0 of 2');

    // Closing is held while rows are undecided.
    expect(screen.getByRole('button', { name: /close certification/i })).toBeDisabled();

    // Revoke asks why before it records.
    const revokes = screen.getAllByRole('button', { name: 'Revoke' });
    fireEvent.click(revokes[0]!);
    const record = screen.getByRole('button', { name: /record revoke/i });
    expect(record).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/why revoke/i), { target: { value: 'Left the desk.' } });
    fireEvent.click(record);
    await waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]).toMatchObject({ path: '/admin/access-certifications/c1/items/i1/decide', body: { decision: 'REVOKE', note: 'Left the desk.' } });

    // Keep records straight away.
    fireEvent.click(screen.getAllByRole('button', { name: /^keep$/i })[0]!);
    await waitFor(() => expect(decided).toHaveLength(2));
    expect(decided[1]!.body).toEqual({ decision: 'KEEP' });
  });

  it('keeps many at once, filters to what waits on me, and lists findings to apply after close', async () => {
    const items = [
      { id: 'i1', subject: person('u-rae', 'rae@example.com', 'Rae Report'), reviewer: person('u-owner', 'owner@example.com'), snapshot: { role: 'INTERNAL_RECRUITER' }, decision: null, note: null, decidedBy: null, decidedAt: null, mine: true },
      { id: 'i2', subject: person('u-mia', 'mia@example.com', 'Mia Manager'), reviewer: person('u-other', 'other@example.com', 'Oli Other'), snapshot: { role: 'MANAGER' }, decision: null, note: null, decidedBy: null, decidedAt: null, mine: false },
      { id: 'i3', subject: { ...person('u-gus', 'gus@example.com', 'Gus Gone'), status: 'DISABLED' }, reviewer: person('u-owner', 'owner@example.com'), snapshot: { role: 'MANAGER' }, decision: null, note: null, decidedBy: null, decidedAt: null, mine: true },
    ];
    const detail = { ...summary, runs: false, items };
    const decided: string[] = [];
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/admin/access-certifications/c1') return detail;
      if (typeof path === 'string' && path.includes('/decide')) decided.push(path);
      return undefined;
    });
    renderAt('/admin/access-certifications/c1', ['view:dashboard']);
    expect(await screen.findByText('Rae Report')).toBeInTheDocument();
    // A status in words, never the enum lower-cased.
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    // Not mine and I don't run access: nothing to press on Mia's row.
    expect(screen.getByText('Waiting on reviewer')).toBeInTheDocument();
    // "Waiting on me" narrows to my two.
    fireEvent.click(screen.getByRole('button', { name: 'Waiting on me 2' }));
    await waitFor(() => expect(screen.queryByText('Mia Manager')).not.toBeInTheDocument());
    // Bulk keep the selection.
    fireEvent.click(screen.getByRole('checkbox', { name: /select every account you can decide/i }));
    fireEvent.click(await screen.findByRole('button', { name: /keep selected/i }));
    await waitFor(() => expect(decided.sort()).toEqual(['/admin/access-certifications/c1/items/i1/decide', '/admin/access-certifications/c1/items/i3/decide']));
  });

  it('after close, each revoke or change links to the account in Users & access', async () => {
    const detail = {
      ...summary,
      status: 'CLOSED',
      closedAt: '2026-10-20T00:00:00.000Z',
      revoke: 1,
      runs: true,
      items: [
        { id: 'i1', subject: person('u-rae', 'rae@example.com', 'Rae Report'), reviewer: person('u-owner', 'owner@example.com'), snapshot: {}, decision: 'REVOKE', note: 'Left the desk.', decidedBy: person('u-owner', 'owner@example.com'), decidedAt: '2026-10-19T00:00:00.000Z', mine: false },
        { id: 'i2', subject: person('u-mia', 'mia@example.com', 'Mia Manager'), reviewer: person('u-owner', 'owner@example.com'), snapshot: {}, decision: 'KEEP', note: null, decidedBy: person('u-owner', 'owner@example.com'), decidedAt: '2026-10-19T00:00:00.000Z', mine: false },
      ],
    };
    fetchMock.mockImplementation(async (path: string) => (path === '/admin/access-certifications/c1' ? detail : undefined));
    renderAt('/admin/access-certifications/c1');
    const findings = await screen.findByRole('list', { name: 'Findings to apply' });
    expect(findings).toHaveTextContent('Rae Report');
    expect(findings).not.toHaveTextContent('Mia Manager');
    expect(screen.getByRole('link', { name: 'Apply' })).toHaveAttribute('href', '/admin/users?status=all&user=u-rae');
  });
});

describe('<AccessCertifications> — the access review home', () => {
  it('holds the access report as a tab for HR administration, linked as ?tab=report', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === '/admin/access-certifications') return { runs: true, certifications: [summary] };
      if (path === '/admin/users/access-report') return { generatedAt: '2026-10-13T12:00:00.000Z', counts: { totalAccounts: 0, byStatus: { ACTIVE: 0, INVITED: 0, DISABLED: 0 }, byRole: {}, activeAssociates: 0, flaggedAccounts: 0, byFlag: {} }, rows: [] };
      return undefined;
    });
    renderAt('/admin/access-certifications?tab=report');
    expect(await screen.findByRole('tab', { name: 'Access report', selected: true })).toBeInTheDocument();
    expect(await screen.findByText('Flagged accounts')).toBeInTheDocument();
  });

  it('a reviewer without HR administration sees campaigns only', async () => {
    fetchMock.mockResolvedValue({ runs: false, certifications: [] });
    renderAt('/admin/access-certifications?tab=report', ['view:dashboard']);
    expect(await screen.findByText('No certification yet.')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Access report' })).not.toBeInTheDocument();
  });
});
