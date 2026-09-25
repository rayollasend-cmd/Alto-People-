import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/opsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/opsApi')>()),
  listOpsReportRecipients: vi.fn(),
  emailOpsReport: vi.fn(),
}));
vi.mock('@/pages/ops/opsTime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/ops/opsTime')>()),
  // Wednesday Sep 23, 2026 on the ops clock.
  opsToday: () => '2026-09-23',
}));

import { emailOpsReport, listOpsReportRecipients } from '@/lib/opsApi';
import { OpsReportButton, reportRange } from '@/pages/ops/OpsReportButton';

const stores = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Walmart Santa Rosa Beach' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Walmart Destin' },
];

describe('reportRange', () => {
  it('yesterday, the completed Sat–Fri week, and the last 7 days', () => {
    expect(reportRange('yesterday', '2026-09-23')).toEqual({ from: '2026-09-22', to: '2026-09-22' });
    expect(reportRange('last-7', '2026-09-23')).toEqual({ from: '2026-09-16', to: '2026-09-22' });
    expect(reportRange('last-week', '2026-09-23')).toEqual({ from: '2026-09-12', to: '2026-09-18' });
    expect(reportRange('last-week', '2026-09-26')).toEqual({ from: '2026-09-19', to: '2026-09-25' });
    expect(reportRange('custom', '2026-09-23')).toBeNull();
  });
});

describe('OpsReportButton', () => {
  it('opens on the board’s store, defaults to last week, ticks the store accounts and builds the download link', async () => {
    vi.mocked(listOpsReportRecipients).mockResolvedValue({
      recipients: [
        { userId: 'u-store', name: 'Dana Manager', email: 'manager@store.com', scope: 'store' },
        { userId: 'u-market', name: 'Market', email: 'market@client.com', scope: 'client' },
      ],
    });
    vi.mocked(emailOpsReport).mockResolvedValue({ sent: 1, filename: 'store-ops-report.pdf' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <OpsReportButton stores={stores} storeId={stores[0]!.id} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Store report/ }));
    expect(await screen.findByText('Dana Manager')).toBeInTheDocument();
    expect(screen.getByTestId('report-range')).toHaveTextContent('Walmart Santa Rosa Beach');
    expect(screen.getByTestId('report-download')).toHaveAttribute(
      'href',
      `/api/ops/report.pdf?from=2026-09-12&to=2026-09-18&locationId=${stores[0]!.id}`,
    );
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /Email report/ }));
    expect(emailOpsReport).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: stores[0]!.id, from: '2026-09-12', to: '2026-09-18', recipientUserIds: ['u-store'] }),
    );
  });
});
