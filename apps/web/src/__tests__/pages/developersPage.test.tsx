import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
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
  apiFetch: vi.fn(async (path: string) => (path === '/v1/openapi.json' ? SPEC : path.startsWith('/api-clients') ? { clients: [] } : path.startsWith('/admin/users') ? { users: [] } : {})),
}));
vi.mock('@/lib/apiKeysWebhooks93Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiKeysWebhooks93Api')>()),
  listApiKeys: vi.fn(async () => ({ keys: [] })),
  listWebhooks: vi.fn(async () => ({ webhooks: [] })),
}));

import { DevelopersPage } from '@/pages/integrations/DevelopersPage';
import { IntegrationsHome } from '@/pages/integrations/IntegrationsHome';
import { renderAs } from './hrPack/harness';
import { Route, Routes, useLocation } from 'react-router-dom';

function renderPage(route = '/developers?tab=reference') {
  return renderAs('HR_ADMINISTRATOR', <DevelopersPage />, route);
}

let at = '';
function Where() {
  const l = useLocation();
  at = l.pathname + l.search;
  return null;
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

  it('is "API & webhooks": the apps, keys and webhooks that left Integrations, each a tab in the URL', async () => {
    renderPage('/developers');
    expect(screen.getByRole('heading', { level: 1, name: 'API & webhooks' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /API apps/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /API keys/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Webhooks/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Reference/ })).toBeTruthy();
  });

  it('an old Integrations tab link lands on the same tab here', async () => {
    renderAs(
      'HR_ADMINISTRATOR',
      <>
        <Routes>
          <Route path="/integrations" element={<IntegrationsHome />} />
          <Route path="/developers" element={<DevelopersPage />} />
        </Routes>
        <Where />
      </>,
      '/integrations?tab=webhooks',
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'API & webhooks' })).toBeTruthy();
    expect(at).toBe('/developers?tab=webhooks');
    expect(screen.getByRole('tab', { name: /Webhooks/ }).getAttribute('aria-selected')).toBe('true');
  });
});
