import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/vto130Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/vto130Api')>()),
  getVtoPolicy: vi.fn(),
  setVtoPolicy: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  listClients: vi.fn().mockResolvedValue({ clients: [{ id: 'c1', name: 'Grand Hotel' }], nextCursor: null }),
}));

import { getVtoPolicy, setVtoPolicy } from '@/lib/vto130Api';
import { VtoPolicyEditor } from '@/pages/vto/VtoPolicyEditor';

/**
 * Audit Tier 3: GET/PUT /vto-policy existed with no screen. The editor
 * shows what is in effect and writes the org default or a client's own.
 */

function renderEditor() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VtoPolicyEditor />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<VtoPolicyEditor>', () => {
  it('shows the effective policy and saves the org default', async () => {
    vi.mocked(getVtoPolicy).mockResolvedValue({ policy: null, effective: { annualHoursCap: '16', matchRatio: '10', matchCurrency: 'USD' } });
    vi.mocked(setVtoPolicy).mockResolvedValue({ ok: true });
    const user = renderEditor();
    expect(await screen.findByText(/In effect: 16 h\/year · USD 10\/hour/)).toBeInTheDocument();
    expect(screen.getByText('Built-in default')).toBeInTheDocument();
    const cap = screen.getByLabelText(/Annual hours cap/);
    await user.clear(cap);
    await user.type(cap, '24');
    await user.click(screen.getByRole('button', { name: 'Save org default' }));
    await waitFor(() => expect(setVtoPolicy).toHaveBeenCalledWith({ clientId: null, annualHoursCap: 24, matchRatio: 10, matchCurrency: 'USD' }));
  });

  it('writes a client policy when a client is picked', async () => {
    vi.mocked(getVtoPolicy).mockImplementation(async (clientId?: string) =>
      clientId
        ? { policy: { id: 'p1', clientId, annualHoursCap: '8', matchRatio: '5', matchCurrency: 'USD' }, effective: { annualHoursCap: '8', matchRatio: '5', matchCurrency: 'USD' } }
        : { policy: null, effective: { annualHoursCap: '16', matchRatio: '10', matchCurrency: 'USD' } },
    );
    vi.mocked(setVtoPolicy).mockResolvedValue({ ok: true });
    const user = renderEditor();
    await screen.findByText('Built-in default');
    await user.selectOptions(await screen.findByLabelText('Applies to'), 'c1');
    expect(await screen.findByText('Client policy set')).toBeInTheDocument();
    expect(getVtoPolicy).toHaveBeenCalledWith('c1');
    await user.click(screen.getByRole('button', { name: 'Save client policy' }));
    await waitFor(() => expect(setVtoPolicy).toHaveBeenCalledWith({ clientId: 'c1', annualHoursCap: 8, matchRatio: 5, matchCurrency: 'USD' }));
  });

  it('refuses a cap of zero before calling the server', async () => {
    vi.mocked(getVtoPolicy).mockResolvedValue({ policy: null, effective: { annualHoursCap: '16', matchRatio: '10', matchCurrency: 'USD' } });
    const user = renderEditor();
    const cap = await screen.findByLabelText(/Annual hours cap/);
    await user.clear(cap);
    await user.type(cap, '0');
    expect(screen.getByText(/Enter the yearly cap in hours/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save org default' })).toBeDisabled();
    expect(setVtoPolicy).not.toHaveBeenCalled();
  });

  it('says so when the policy cannot load', async () => {
    vi.mocked(getVtoPolicy).mockRejectedValue(new Error('boom'));
    renderEditor();
    expect(await screen.findByText('Could not load the policy.')).toBeInTheDocument();
  });
});
