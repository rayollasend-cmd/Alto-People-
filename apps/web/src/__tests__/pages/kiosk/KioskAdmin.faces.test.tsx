import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Every kiosk call answers empty unless a test says otherwise.
vi.mock('@/lib/kiosk99Api', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(real)) out[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  return out;
});
vi.mock('@/lib/auth', async (orig) => {
  const real = await orig<typeof import('@/lib/auth')>();
  return {
    ...real,
    useAuth: () => ({ user: { id: 'u1', role: 'OPERATIONS_MANAGER', email: 'ops@example.com' }, can: () => true }),
    useTerm: () => (k: string) => (k === 'nav.kiosk' ? 'Kiosk' : k),
  };
});

import * as kioskApi from '@/lib/kiosk99Api';
import { ConfirmProvider } from '@/lib/confirm';
import { KioskAdmin } from '@/pages/kiosk/KioskAdmin';

/**
 * The kiosk desk in plain words: the face matching tab is "Face photos on
 * file", not "Face refs".
 */
function renderAt(url: string) {
  vi.mocked(kioskApi.listKioskPunches).mockResolvedValue({ punches: [] } as never);
  vi.mocked(kioskApi.listKioskDevices).mockResolvedValue({ devices: [] } as never);
  vi.mocked(kioskApi.listKioskFaceReferences).mockResolvedValue({
    references: [
      {
        id: 'f1',
        associateId: 'a1',
        associateName: 'Ann Lee',
        associateEmail: 'ann@example.com',
        enrolledAt: '2026-09-01T14:00:00Z',
        updatedAt: '2026-09-02T14:00:00Z',
      },
    ],
  } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[url]}>
          <KioskAdmin />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe('Kiosk — face photos on file', () => {
  it('names the tab and its list in plain words', async () => {
    renderAt('/time-attendance/kiosk?tab=faces');
    expect(screen.getByRole('tab', { name: /Face photos on file/ })).toBeInTheDocument();
    expect(screen.queryByText(/Face refs/)).not.toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Face photos on file' });
    expect(within(table).getByText('Ann Lee')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: /On file since/ })).toBeInTheDocument();
  });
});
