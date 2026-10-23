import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (v: string) => `data:image/png;base64,${btoa(v)}`) } }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn(async () => ({ statusPageUrl: null })) }));
import { Install } from '@/pages/Install';

/** On a desktop the install page says what to do and gives a phone a way here: a QR of the page (F500 G5). */
describe('/install on a desktop', () => {
  it('says to open it on a phone, with a QR code of this page — not "the instructions above"', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Install />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Open this page on your phone to add the app.')).toBeInTheDocument();
    expect(screen.queryByText(/instructions above/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('install-qr').querySelector('img')).toHaveAttribute('src', `data:image/png;base64,${btoa(`${window.location.origin}/install`)}`));
  });
});
