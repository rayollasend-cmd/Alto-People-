import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Settings › "When things reach you" (owner, 2026-11-02). Email is a choice
 * of five with the role's default marked "Recommended for you"; quiet hours
 * are on from 9 PM to 7 AM until the person says otherwise. The card shows
 * the EFFECTIVE values the API answers and saves each choice the moment it
 * is made.
 */

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DeliveryCard } from '@/components/settings/DeliveryCard';

type Settings = {
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  deliveryEmail: string;
  deliveryPush: string;
  deliverySms: string;
};

function answer(s: Settings, defaults: Settings, isDefault: boolean) {
  return { ...s, timezone: 'America/Chicago', isDefault, defaults };
}

const OFFICE: Settings = { quietHoursStart: 21 * 60, quietHoursEnd: 7 * 60, deliveryEmail: 'DAILY', deliveryPush: 'REALTIME', deliverySms: 'REALTIME' };
const FLOOR: Settings = { ...OFFICE, deliveryEmail: 'IMPORTANT' };

let current: ReturnType<typeof answer>;
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === 'PATCH') {
    const patch = JSON.parse(String(init.body)) as Partial<Settings>;
    current = { ...current, ...patch, isDefault: false };
  }
  return new Response(JSON.stringify(current), { status: 200, headers: { 'content-type': 'application/json' } });
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeliveryCard />
    </QueryClientProvider>,
  );
}

/** The PATCH bodies sent so far. */
const patches = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH').map(([url, init]) => ({ url, body: JSON.parse(String(init!.body)) as unknown }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('when things reach you', () => {
  it('shows the office defaults: the morning summary, recommended, and quiet hours 9 PM–7 AM', async () => {
    current = answer(OFFICE, OFFICE, true);
    mount();
    const daily = await screen.findByRole('radio', { name: /One summary each morning/ });
    expect(daily).toBeChecked();
    const label = daily.closest('label')!;
    expect(within(label).getByText('Recommended for you')).toBeInTheDocument();
    // The time it leaves is said in words, not left to guess.
    expect(within(label).getByText(/^At .*7.*one email with everything since the last one\.$/)).toBeInTheDocument();
    // Only one option carries the mark.
    expect(screen.getAllByText('Recommended for you')).toHaveLength(1);
    for (const name of [/Only what needs me/, /Every update, as it happens/, /Once an hour, together/, /Only urgent and required notices/]) {
      expect(screen.getByRole('radio', { name })).not.toBeChecked();
    }
    expect(screen.getByRole('switch', { name: /Quiet hours/ })).toBeChecked();
    expect(screen.getByLabelText('From')).toHaveValue('21:00');
    expect(screen.getByLabelText('Until')).toHaveValue('07:00');
    expect(screen.getByText(/Urgent safety, security and pay notices always come through/)).toBeInTheDocument();
  });

  it('marks the floor default instead for a person on the floor', async () => {
    current = answer(FLOOR, FLOOR, true);
    mount();
    const important = await screen.findByRole('radio', { name: /Only what needs me/ });
    expect(important).toBeChecked();
    expect(within(important.closest('label')!).getByText('Recommended for you')).toBeInTheDocument();
  });

  it('choosing an option saves it at once', async () => {
    current = answer(OFFICE, OFFICE, true);
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Every update, as it happens/ }));
    await waitFor(() => expect(patches()).toEqual([{ url: '/api/auth/me/notification-delivery', body: { deliveryEmail: 'REALTIME' } }]));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Every update, as it happens/ })).toBeChecked());
    // The recommendation stays on the role's default, not on the choice.
    expect(within(screen.getByRole('radio', { name: /One summary each morning/ }).closest('label')!).getByText('Recommended for you')).toBeInTheDocument();
  });

  it('turning quiet hours off sends both ends empty; push keeps its two speeds', async () => {
    current = answer(OFFICE, OFFICE, true);
    mount();
    fireEvent.click(await screen.findByRole('switch', { name: /Quiet hours/ }));
    await waitFor(() => expect(patches().at(-1)?.body).toEqual({ quietHoursStart: null, quietHoursEnd: null }));
    await waitFor(() => expect(screen.queryByLabelText('From')).toBeNull());

    const push = screen.getByRole('combobox', { name: 'Push delivery' });
    expect([...(push as HTMLSelectElement).options].map((o) => o.value)).toEqual(['REALTIME', 'DIGEST']);
    fireEvent.change(push, { target: { value: 'DIGEST' } });
    await waitFor(() => expect(patches().at(-1)?.body).toEqual({ deliveryPush: 'DIGEST' }));
    expect(screen.getByRole('combobox', { name: 'WhatsApp / SMS delivery' })).toHaveValue('REALTIME');
  });
});
