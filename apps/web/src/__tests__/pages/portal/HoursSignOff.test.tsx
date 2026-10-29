import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { HoursSignOffDialog, HoursSignOffPanel } from '@/pages/portal/HoursSignOff';
import type { WeekHours } from '@/lib/hoursSignOffApi';

/**
 * The client signs a finished store week's hours off — or flags a line with
 * a note — from the portal; the total it saw rides along so hours that moved
 * meanwhile are never signed blind.
 */

const week = (over: Partial<WeekHours> = {}): WeekHours => ({
  store: { id: 'l1', name: 'Front Beach 218' },
  week: { start: '2026-10-17', end: '2026-10-23' },
  weeks: ['2026-10-17', '2026-10-10'],
  signable: true,
  canSign: true,
  lines: [
    { associateId: 'a1', name: 'Ken Adams', hours: 6, punches: 1 },
    { associateId: 'a2', name: 'Maria Lopez', hours: 15, punches: 2 },
  ],
  totalHours: 21,
  people: 2,
  openPunches: 0,
  state: 'unsigned',
  signOff: null,
  ...over,
});

function wrap(node: React.ReactNode) {
  const role = 'CLIENT_PORTAL' as const;
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'sm@x.example', role, status: 'ACTIVE', clientId: 'c1', associateId: null } as never,
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter>{node}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('the client\'s hours sign-off', () => {
  it('lists each person\'s hours and signs the week with the total it showed', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { body?: unknown }) => {
      if (path.startsWith('/client-portal/hours/sign')) {
        calls.push({ path, body: opts?.body });
        return { state: 'signed', signOff: { status: 'SIGNED', signedAt: new Date().toISOString(), signedByName: 'Lauren W.', totalHours: 21, people: 2, flags: [], note: null } } as never;
      }
      if (path.startsWith('/client-portal/hours')) return week() as never;
      throw new Error(`unexpected ${path}`);
    });
    const onClose = vi.fn();
    wrap(<HoursSignOffDialog open onClose={onClose} scopeQs="" />);
    const list = await screen.findByRole('list', { name: 'Hours by person' });
    expect(within(list).getByText('Maria Lopez')).toBeInTheDocument();
    expect(within(list).getByText('15h')).toBeInTheDocument();
    expect(within(list).getByText('Total for 2 people')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign off 21h' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ week: '2026-10-17', flags: [], expectTotalHours: 21 });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a flagged line needs its note before the week can be signed', async () => {
    const calls: unknown[] = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { body?: unknown }) => {
      if (path.startsWith('/client-portal/hours/sign')) {
        calls.push(opts?.body);
        return { state: 'flagged', signOff: null } as never;
      }
      if (path.startsWith('/client-portal/hours')) return week() as never;
      throw new Error(`unexpected ${path}`);
    });
    wrap(<HoursSignOffDialog open onClose={vi.fn()} scopeQs="?locationId=l1" />);
    await userEvent.click(await screen.findByRole('button', { name: "Flag Ken Adams's hours" }));
    const sign = screen.getByRole('button', { name: 'Sign with 1 flagged' });
    expect(sign).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: "Why Ken Adams's hours are flagged" }), 'Left at 1 PM');
    expect(sign).toBeEnabled();
    await userEvent.click(sign);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ week: '2026-10-17', flags: [{ associateId: 'a1', note: 'Left at 1 PM' }], expectTotalHours: 21 });
  });

  it('a preview reads the hours but cannot sign; the panel says the state', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.startsWith('/client-portal/hours')) {
        return week({ canSign: false, state: 'changed', signOff: { status: 'SIGNED', signedAt: '2026-10-24T14:00:00.000Z', signedByName: 'Lauren Whitfield', totalHours: 19, people: 2, flags: [], note: null } }) as never;
      }
      throw new Error(`unexpected ${path}`);
    });
    wrap(<HoursSignOffPanel scopeQs="?clientId=c1&locationId=l1" />);
    expect(await screen.findByText('Changed since sign-off')).toBeInTheDocument();
    expect(screen.getByText(/by Lauren Whitfield · .* · 19h/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText("Only the client signs its hours off. You're reading them as a preview.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sign/ })).toBeNull();
  });
});
