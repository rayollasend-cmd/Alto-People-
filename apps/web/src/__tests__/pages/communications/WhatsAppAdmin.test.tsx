import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WhatsAppMessageRow, WhatsAppOverview } from '@alto-people/shared';

vi.mock('@/lib/whatsappApi', () => ({ getWhatsAppOverview: vi.fn(), listWhatsAppMessages: vi.fn() }));
vi.mock('@/lib/directoryApi', () => ({ listDirectory: vi.fn().mockResolvedValue({ associates: [] }) }));

import { getWhatsAppOverview, listWhatsAppMessages } from '@/lib/whatsappApi';
import { WhatsAppAdmin } from '@/pages/communications/WhatsAppAdmin';

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

describe('WhatsAppAdmin', () => {
  it('shows the wiring, the week, the templates to register, and the record with its receipt', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <WhatsAppAdmin />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Sending configured')).toBeInTheDocument();
    expect(screen.getByText('Webhook not configured')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText('12 opted in · 2 opted out')).toBeInTheDocument();
    expect(screen.getByText('alto_notice')).toBeInTheDocument();
    expect(await screen.findByText('Maria Lopez')).toBeInTheDocument();
    // 'Delivered' is both the week's stat tile and the row's status badge.
    expect(screen.getAllByText('Delivered').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('alto_shift_assigned · es')).toBeInTheDocument();
    expect(listWhatsAppMessages).toHaveBeenCalledWith({ associateId: undefined, limit: 100 });
  });
});
