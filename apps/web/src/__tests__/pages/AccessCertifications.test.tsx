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
    expect(screen.getByText('2 waiting on you')).toBeInTheDocument();

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
});
