import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WhatsAppMessageRow, WhatsAppOverview } from '@alto-people/shared';

vi.mock('@/lib/whatsappApi', () => ({ getWhatsAppOverview: vi.fn(), listWhatsAppMessages: vi.fn() }));
vi.mock('@/lib/directoryApi', () => ({ listDirectory: vi.fn().mockResolvedValue({ associates: [] }) }));

import { getWhatsAppOverview, listWhatsAppMessages } from '@/lib/whatsappApi';
import { WhatsAppAdmin, WhatsAppTemplatesCard } from '@/pages/communications/WhatsAppAdmin';

const overview: WhatsAppOverview = {
  configured: true,
  webhookConfigured: false,
  apiVersion: 'v21.0',
  phoneNumberId: '…4321',
  consent: { optedIn: 12, optedOut: 2 },
  last7Days: { sent: 40, delivered: 37, read: 30, failed: 1, questions: 6, handoffs: 2 },
  templates: [
    {
      key: 'alto_notice',
      metaName: 'alto_notice',
      metaCategory: 'UTILITY',
      params: ['subject', 'message'],
      description: 'Any notice.',
      body: { en: '{{1}}\n\n{{2}}', es: '{{1}}\n\n{{2}}', tr: '{{1}}\n\n{{2}}' },
    },
  ],
};

const row: WhatsAppMessageRow = {
  id: 'm1',
  associateId: 'a1',
  associateName: 'Maria Lopez',
  phone: '…0100',
  direction: 'OUTBOUND',
  kind: 'TEMPLATE',
  templateName: 'alto_shift_assigned',
  language: 'es',
  body: 'Nuevo turno: Server en Northgate, sáb 17 oct, 9:00–17:00.',
  category: 'shift_assigned',
  status: 'DELIVERED',
  statusAt: '2026-10-13T12:01:00.000Z',
  failureReason: null,
  conversationId: null,
  createdAt: '2026-10-13T12:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(getWhatsAppOverview).mockReset().mockResolvedValue(overview);
  vi.mocked(listWhatsAppMessages).mockReset().mockResolvedValue({ messages: [row] });
});

const renderIt = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('WhatsAppAdmin', () => {
  it('shows the wiring, the week and the record with its receipt — not the setup instructions', async () => {
    renderIt(<WhatsAppAdmin />);
    expect(await screen.findByText('Sending configured')).toBeInTheDocument();
    expect(screen.getByText('Webhook not configured')).toBeInTheDocument();
    // The tiles count up from 0; the value's title carries the settled number.
    expect(await screen.findByTitle('40')).toBeInTheDocument();
    expect(screen.getByTitle('37')).toBeInTheDocument();
    expect(screen.getByText('12 opted in · 2 opted out')).toBeInTheDocument();
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    // 'Delivered' is both the week's stat tile and the row's status badge.
    expect(screen.getAllByText('Delivered').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('alto_shift_assigned · es')).toBeInTheDocument();
    expect(listWhatsAppMessages).toHaveBeenCalledWith({ associateId: undefined, limit: 100 });
    // Template registration is setup: it moved to Settings › Communications.
    expect(screen.queryByText('alto_notice')).not.toBeInTheDocument();
  });

  it('a quiet week with nothing connected is one line and a way to set it up, not four zero tiles', async () => {
    vi.mocked(getWhatsAppOverview).mockResolvedValue({
      ...overview,
      configured: false,
      last7Days: { sent: 0, delivered: 0, read: 0, failed: 0, questions: 0, handoffs: 0 },
    });
    vi.mocked(listWhatsAppMessages).mockResolvedValue({ messages: [] });
    renderIt(<WhatsAppAdmin />);
    expect(await screen.findByText('Nothing went out or came in by WhatsApp in the last 7 days.')).toBeInTheDocument();
    expect(screen.queryByText('Sent (7 days)')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set it up in Settings › Communications' })).toHaveAttribute('href', '/admin/communications#whatsapp');
  });
});

describe('WhatsAppTemplatesCard (Settings › Communications)', () => {
  it('lists each template to register, by its Meta name, with the parameters', async () => {
    renderIt(<WhatsAppTemplatesCard />);
    expect(await screen.findByText('alto_notice')).toBeInTheDocument();
    expect(screen.getByText('Parameters: {{1}} subject · {{2}} message')).toBeInTheDocument();
    expect(screen.getByText(/Sending is connected · API v21.0/)).toBeInTheDocument();
  });
});
