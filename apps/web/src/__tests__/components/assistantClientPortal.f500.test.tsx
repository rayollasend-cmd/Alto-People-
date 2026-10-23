import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** A client account has no assistant: the app never asks GET /hugo for it (a refused request on every page load — F500 G5). */

const getHugo = vi.fn(async () => ({ name: 'Hugo' }));
vi.mock('@/lib/hugoApi', () => ({ getHugo: () => getHugo(), askHugo: vi.fn(), handoffToPerson: vi.fn(), decideAssistantAction: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'CLIENT_PORTAL', email: 'store@example.com' }, can: () => false }),
}));

import { AssistantProvider, useAssistant } from '@/lib/assistantContext';

function Probe() {
  const { available } = useAssistant() as unknown as { available: boolean };
  return <span data-testid="available">{String(available)}</span>;
}

describe('the assistant for a client account', () => {
  it('is not asked for at all', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/portal']}>
          <AssistantProvider>
            <Probe />
          </AssistantProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('available')).toHaveTextContent('false');
    expect(getHugo).not.toHaveBeenCalled();
  });
});
