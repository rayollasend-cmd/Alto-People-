import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WhatsAppMeResponse } from '@alto-people/shared';
import { I18nProvider } from '@/lib/i18n';

vi.mock('@/lib/whatsappApi', () => ({ getMyWhatsApp: vi.fn(), setWhatsAppConsent: vi.fn() }));

import { getMyWhatsApp, setWhatsAppConsent } from '@/lib/whatsappApi';
import { WhatsAppCard } from '@/components/WhatsAppCard';

/**
 * Consent is the associate's own word: the number, the checkbox, the
 * button. Off is one tap. Before Meta is wired the card says so and
 * asks nothing.
 */

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <WhatsAppCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const optedOut: WhatsAppMeResponse = { configured: true, phoneOnFile: '(850) 555-0100', consent: null };
const optedIn: WhatsAppMeResponse = {
  configured: true,
  phoneOnFile: '(850) 555-0100',
  consent: { status: 'OPTED_IN', phone: '18505550100', optedInAt: '2026-10-01T12:00:00.000Z', optedOutAt: null },
};

beforeEach(() => {
  vi.mocked(getMyWhatsApp).mockReset();
  vi.mocked(setWhatsAppConsent).mockReset();
});

describe('WhatsAppCard', () => {
  it('turns on only after the consent box is ticked, with the number on file', async () => {
    vi.mocked(getMyWhatsApp).mockResolvedValue(optedOut);
    vi.mocked(setWhatsAppConsent).mockResolvedValue(optedIn);
    renderCard();
    const button = await screen.findByRole('button', { name: /turn on/i });
    expect(button).toBeDisabled();
    expect(screen.getByDisplayValue('(850) 555-0100')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /I agree to receive Alto People messages on WhatsApp/i }));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(setWhatsAppConsent).toHaveBeenCalledWith({ optIn: true, phone: '(850) 555-0100' });
    expect(await screen.findByText(/On for …0100 since/)).toBeInTheDocument();
  });

  it('turns off with one tap', async () => {
    vi.mocked(getMyWhatsApp).mockResolvedValue(optedIn);
    vi.mocked(setWhatsAppConsent).mockResolvedValue({ ...optedIn, consent: { ...optedIn.consent!, status: 'OPTED_OUT', optedOutAt: '2026-10-02T12:00:00.000Z' } });
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /turn off/i }));
    expect(setWhatsAppConsent).toHaveBeenCalledWith({ optIn: false });
    expect(await screen.findByRole('button', { name: /turn on/i })).toBeInTheDocument();
  });

  it('says it is coming soon while Meta is not wired, and asks nothing', async () => {
    vi.mocked(getMyWhatsApp).mockResolvedValue({ configured: false, phoneOnFile: null, consent: null });
    renderCard();
    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
