import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/Tooltip';

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { AdminDocumentsView } from '@/pages/documents/AdminDocumentsView';
import { AssociateDocumentsView } from '@/pages/documents/AssociateDocumentsView';

/**
 * The document vault (F500 2026-10-22): numbers that are the queue's
 * filters (Action needed, Awaiting review, Expiring in 30 days), one
 * primary action — Request document — an honest empty vault, and sibling
 * pages as links. The associate's page has one way to upload: a sheet.
 */

const STATS = { total: 12, uploaded: 3, verified: 7, rejected: 1, expired: 1, expiring30: 2, oldestPendingAt: new Date(Date.now() - 4 * 86_400_000).toISOString() };
const EMPTY_STATS = { total: 0, uploaded: 0, verified: 0, rejected: 0, expired: 0, expiring30: 0, oldestPendingAt: null };

let listUrls: string[] = [];
let posts: Array<{ path: string; body: unknown }> = [];

function routes(stats: typeof STATS | typeof EMPTY_STATS = STATS) {
  listUrls = [];
  posts = [];
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST') {
      posts.push({ path, body: init.body });
      return { ok: true } as never;
    }
    if (path.startsWith('/documents/admin/stats')) return stats as never;
    if (path.startsWith('/documents/admin')) {
      listUrls.push(path);
      return { documents: [], total: 0, page: 0, pageSize: 50 } as never;
    }
    if (path.startsWith('/directory') || path.startsWith('/people')) return { associates: [{ id: 'a1', firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com' }], people: [], total: 1 } as never;
    if (path.startsWith('/documents/me')) return { documents: [] } as never;
    if (path.startsWith('/letters')) return { letters: [] } as never;
    return {} as never;
  });
}

function renderVault() {
  const caps = ROLE_CAPABILITIES.HR_ADMINISTRATOR;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'hr@altohr.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null },
          role: 'HR_ADMINISTRATOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <TooltipProvider>
            <MemoryRouter>
              <AdminDocumentsView canManage />
            </MemoryRouter>
          </TooltipProvider>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  try {
    localStorage.clear();
  } catch {
    /* jsdom without storage */
  }
});

describe('the document vault (admin)', () => {
  it('opens on tiles that are the queue’s filters — Expiring in 30 days asks the server for exactly those', async () => {
    routes();
    renderVault();
    const strip = await screen.findByRole('group', { name: 'Documents at a glance' });
    await within(strip).findByText('3 to review · 1 expired');
    expect(within(strip).getByText('Oldest waiting 4d')).toBeInTheDocument();
    const expiring = within(strip).getByText('Expiring in 30 days').closest('button')!;
    expect(expiring).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(expiring);
    await waitFor(() => expect(listUrls.at(-1)).toMatch(/expiringWithin=30/));
    expect(within(strip).getByText('Expiring in 30 days').closest('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('has one primary action, Request a document, and the sibling pages as links', async () => {
    routes();
    renderVault();
    expect(await screen.findByRole('link', { name: 'Verification letters' })).toHaveAttribute('href', '/documents?tab=letters');
    expect(screen.getByRole('link', { name: 'Document templates' })).toHaveAttribute('href', '/templates');
    // One request button, one label (it read "Request document" here and "Request a document" below it).
    expect(screen.getAllByRole('button', { name: /Request a document/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Request document/ })).not.toBeInTheDocument();
  });

  it('says an empty vault is empty — not "switch the filter" — and offers to request a document', async () => {
    routes(EMPTY_STATS);
    renderVault();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(screen.queryByText(/Switch the filter/)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Documents at a glance' })).not.toBeInTheDocument();
    // No filters over an empty vault.
    expect(screen.queryByRole('button', { name: /Awaiting review/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /Request a document/ })[0]!);
    expect(await screen.findByRole('dialog', { name: 'Request a document' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
  });
});

describe('my documents (associate)', () => {
  it('has one way to upload: the header button opens the upload sheet; no form sits on the page', async () => {
    routes();
    render(
      <I18nProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <AssociateDocumentsView />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText('No documents uploaded')).toBeInTheDocument();
    expect(screen.getByText('Tap Upload to share IDs, tax forms, or onboarding paperwork. HR will review each upload.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Kind$/)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /^Upload$/ })[0]!);
    const sheet = await screen.findByRole('dialog', { name: 'Upload' });
    expect(within(sheet).getByText('Kind')).toBeInTheDocument();
  });
});
