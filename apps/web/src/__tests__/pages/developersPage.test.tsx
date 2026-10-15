import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'vitest-axe';

/**
 * Brief 2-4 step 6 — the developer reference renders the spec it is served:
 * operations grouped by tag, scopes, the body and response fields, and the
 * search narrows them. Axe-clean like every page.
 */

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Alto People API', version: '1.0.0' },
  paths: {
    '/workers': {
      get: { tags: ['Workers'], summary: 'List workers', security: [{ oauth2: ['workers:read'] }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Worker' } } } } } },
    },
    '/shifts': {
      post: {
        tags: ['Schedules'],
        summary: 'Create a shift at a site',
        security: [{ oauth2: ['schedules:write'] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { siteId: { type: 'string', format: 'uuid' } }, required: ['siteId'] } } } },
        responses: { '201': { description: 'OK' } },
      },
    },
  },
  components: { schemas: { Worker: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } } },
};

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async () => SPEC),
}));

import { DevelopersPage } from '@/pages/integrations/DevelopersPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DevelopersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DevelopersPage', () => {
  it('lists the served operations by tag with their scopes and fields, and is axe-clean', async () => {
    const { container } = renderPage();
    expect(await screen.findByText('List workers')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Schedules' })).toBeTruthy();
    expect(screen.getByText('/v1/shifts')).toBeTruthy();
    expect(screen.getByText('schedules:write')).toBeTruthy();
    expect(screen.getByText('siteId')).toBeTruthy();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);
  });

  it('search narrows the operations', async () => {
    renderPage();
    await screen.findByText('List workers');
    fireEvent.change(screen.getByLabelText('Search operations'), { target: { value: 'shift' } });
    expect(screen.queryByText('List workers')).toBeNull();
    expect(screen.getByText('Create a shift at a site')).toBeTruthy();
  });
});
