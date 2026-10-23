import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/communicationsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/communicationsApi')>()),
  listChannels: vi.fn(),
  sendTestEmail: vi.fn(),
  listSuppressions: vi.fn().mockResolvedValue({ suppressions: [] }),
}));
vi.mock('@/lib/whatsappApi', () => ({
  getWhatsAppOverview: vi.fn().mockResolvedValue({
    configured: false,
    webhookConfigured: false,
    apiVersion: 'v21.0',
    phoneNumberId: null,
    consent: { optedIn: 0, optedOut: 0 },
    last7Days: { sent: 0, delivered: 0, read: 0, failed: 0, questions: 0, handoffs: 0 },
    templates: [{ key: 'alto_notice', metaName: 'alto_notice', metaCategory: 'UTILITY', params: ['subject', 'message'], description: 'Any notice.', body: { en: 'x', es: 'x', tr: 'x' } }],
  }),
  listWhatsAppMessages: vi.fn(),
}));

import { listChannels, sendTestEmail } from '@/lib/communicationsApi';
import { CommunicationsSettings } from '@/pages/settings/CommunicationsSettings';

/**
 * F500 G4 · Settings › Communications: no dead end. A channel that isn't
 * connected says who connects it (not "set one up in Settings ›
 * Communications" — this page), the setting names wait under "For
 * developers", a test email tells the truth, and the WhatsApp templates
 * to register live here, not on the WhatsApp tab.
 */

const notConnected = 'Not connected for this organization yet. Alto People support connects it.';

beforeEach(() => {
  vi.mocked(listChannels).mockResolvedValue({
    channels: [
      { channel: 'IN_APP', available: true, reason: null, developerNote: null },
      { channel: 'EMAIL', available: false, reason: notConnected, developerNote: 'Set RESEND_API_KEY and RESEND_FROM on the API.' },
      { channel: 'SMS', available: false, reason: notConnected, developerNote: 'Texting isn’t connected — set TWILIO_ACCOUNT_SID on the API to send texts.' },
    ],
  });
  vi.mocked(sendTestEmail).mockReset();
});

describe('Settings › Communications', () => {
  it('says who connects a channel, with the setting names folded away for developers', async () => {
    renderAs('HR_ADMINISTRATOR', <CommunicationsSettings />);
    expect((await screen.findAllByText(notConnected)).length).toBe(2);
    expect(screen.getByRole('link', { name: 'Ask Alto People support' })).toHaveAttribute('href', '/support');
    const dev = screen.getByText('For developers').closest('details')!;
    expect(dev).not.toHaveAttribute('open');
    expect(dev).toHaveTextContent('RESEND_API_KEY');
    expect(dev).toHaveTextContent('TWILIO_ACCOUNT_SID');
    expect(screen.queryByText(/set one up in Settings › Communications/)).not.toBeInTheDocument();
    expect(await screen.findByText('alto_notice')).toBeInTheDocument();
  });

  it('a test email with no provider says nothing went out', async () => {
    vi.mocked(sendTestEmail).mockResolvedValue({
      delivered: false,
      to: 'me@example.com',
      notification: { failureReason: null, loggedOnly: true } as never,
    });
    renderAs('HR_ADMINISTRATOR', <CommunicationsSettings />);
    await userEvent.click(await screen.findByRole('button', { name: /Send test email/ }));
    expect(await screen.findByText(/No email went to me@example.com: there's no email provider connected/)).toBeInTheDocument();
    expect(sendTestEmail).toHaveBeenCalledTimes(1);
  });
});
