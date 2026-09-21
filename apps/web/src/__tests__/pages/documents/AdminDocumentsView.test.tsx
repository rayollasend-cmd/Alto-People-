import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { AdminDocumentsView } from '@/pages/documents/AdminDocumentsView';

/**
 * The vault's job is "clear what has waited longest".
 *
 * It could not do that: the list arrived capped and newest-first, the page
 * sorted whatever it held, and the rows were then regrouped by associate —
 * so sorting by age ordered the GROUPS by their oldest document, and the
 * second-oldest thing in the vault could sit halfway down inside someone
 * else's group. Sorting and paging belong to the server now, and the queue
 * is flat unless you actually ask for people.
 */

const doc = (over: { id: string; filename: string; name: string; createdAt: string }) => ({
  id: over.id,
  associateId: `a-${over.name}`,
  associateName: over.name,
  kind: 'ID' as const,
  status: 'UPLOADED' as const,
  filename: over.filename,
  mimeType: 'image/png',
  size: 1024,
  createdAt: over.createdAt,
  uploadedByName: null,
  verifiedAt: null,
  verifiedByName: null,
  rejectionReason: null,
  expiresAt: null,
});

const STATS = {
  total: 120,
  uploaded: 90,
  verified: 20,
  rejected: 6,
  expired: 4,
  oldestPendingAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
};

/** Oldest first, and deliberately from three different people — the old
 *  grouping would have pulled these apart. */
const PAGE = [
  doc({ id: 'd1', filename: 'oldest.png', name: 'Ada Lovelace', createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString() }),
  doc({ id: 'd2', filename: 'middle.png', name: 'Grace Hopper', createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }),
  doc({ id: 'd3', filename: 'newest.png', name: 'Ada Lovelace', createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString() }),
];

let lastListUrl = '';

function routes(docs = PAGE, total = 120) {
  lastListUrl = '';
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/documents/admin/stats')) return STATS as never;
    if (path.startsWith('/documents/admin')) {
      lastListUrl = path;
      return { documents: docs, total, page: 0, pageSize: 50 } as never;
    }
    throw new Error(`unexpected ${path}`);
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
});

describe('the document vault', () => {
  it('asks the server to sort and page, rather than sorting what it was given', async () => {
    routes();
    renderVault();
    await screen.findByText('oldest.png');
    expect(lastListUrl).toMatch(/sort=uploaded_desc/);
    expect(lastListUrl).toMatch(/pageSize=50/);
    // "Action needed" (uploads to review + expired to renew) is ONE query
    // now. It used to fetch the whole vault and narrow in the browser,
    // which is what forced the 200-row load in the first place.
    expect(decodeURIComponent(lastListUrl)).toMatch(/status=UPLOADED,EXPIRED/);
  });

  it('keeps the queue flat, so the oldest row really is at the top', async () => {
    routes();
    renderVault();
    await screen.findByText('oldest.png');

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    // One header row, then one row per document — no per-associate header
    // rows breaking the age order into person-sized chunks.
    expect(rows).toHaveLength(1 + PAGE.length);
    const order = within(table)
      .getAllByText(/oldest\.png|middle\.png|newest\.png/)
      .map((n) => n.textContent);
    expect(order).toEqual(['oldest.png', 'middle.png', 'newest.png']);
  });

  it('takes its totals from the vault, not from the page it happens to hold', async () => {
    routes();
    renderVault();
    // 90 awaiting review across the whole vault. This page holds exactly
    // three documents and all three are UPLOADED, so a page-derived tally
    // would read 3 — which is what it used to do past the row cap.
    await screen.findByText('oldest.png');
    // 90 and 20 exist only in the stats response; nothing on this page of
    // three documents could produce either number.
    expect(screen.getAllByText('90').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20').length).toBeGreaterThan(0);
  });

  it('offers a way through a vault bigger than one page', async () => {
    routes();
    renderVault();
    expect(await screen.findByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(lastListUrl).toMatch(/page=1/);
  });

  it('offers a retry when the list fails, instead of only a page reload', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.startsWith('/documents/admin/stats')) return STATS as never;
      throw new Error('nope');
    });
    renderVault();
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('an associate’s folder shows the documents, not a list of filenames', () => {
  /**
   * Reviewing a six-document folder meant opening each one and closing it
   * again — twelve clicks to learn what a glance would have told you.
   */
  const FOLDER = [
    doc({ id: 'f1', filename: 'id-front.png', name: 'Jannis Balanta', createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString() }),
    { ...doc({ id: 'f2', filename: 'agreement.pdf', name: 'Jannis Balanta', createdAt: new Date().toISOString() }), kind: 'SIGNED_AGREEMENT' as const, mimeType: 'application/pdf' },
  ];

  function folderRoutes() {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.startsWith('/documents/admin/stats')) return STATS as never;
      if (path.includes('associateId=')) return { documents: FOLDER, total: 2 } as never;
      if (path.startsWith('/documents/admin')) return { documents: PAGE, total: 3 } as never;
      throw new Error(`unexpected ${path}`);
    });
  }

  it('renders each document inline rather than waiting to be clicked', async () => {
    folderRoutes();
    renderVault();
    // Open Ada's folder from the queue.
    // Ada owns two rows in the queue; either opens her folder.
    await userEvent.click((await screen.findAllByRole('button', { name: /Ada Lovelace/ }))[0]!);

    // The thumbnail carries alt="" on purpose — the kind and status sit
    // beside it as text, so the image is decorative to a screen reader.
    // That also means it has no img role, hence the direct query.
    await screen.findByText('Signed agreement');
    const img = document.querySelector('img[src*="/documents/f1/download"]');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', expect.stringContaining('inline=1'));
    // Lazy, so a thirty-document folder does not pull all thirty to show
    // the first few.
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('can blur the identity documents without hiding the rest', async () => {
    folderRoutes();
    renderVault();
    await userEvent.click((await screen.findAllByRole('button', { name: /Ada Lovelace/ }))[0]!);
    const toggle = await screen.findByRole('button', { name: /Blur identity documents/ });
    await userEvent.click(toggle);
    // The ID blurs; the signed agreement is not an identity document.
    const img = document.querySelector('img[src*="/documents/f1/download"]');
    expect(img?.className).toContain('blur');
    expect(document.querySelector('object')?.className ?? '').not.toContain('blur');
    expect(
      await screen.findByRole('button', { name: /Show identity documents/ }),
    ).toBeInTheDocument();
  });
});

describe('a misfiled document is moved, not rejected', () => {
  /**
   * "Wrong document type" was one of three canned reject reasons, and
   * rejecting was the only thing the row offered for it — so a passport
   * filed under SSN card went back to the associate with an email and a
   * reopened task, to be re-uploaded unchanged. The file was always fine;
   * only its label was wrong.
   */
  it('moves it to the right kind without troubling the associate', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { body?: unknown }) => {
      calls.push({ path, body: init?.body });
      if (path.startsWith('/documents/admin/stats')) return STATS as never;
      if (path.includes('/reclassify')) return PAGE[0] as never;
      if (path.startsWith('/documents/admin')) return { documents: PAGE, total: 3 } as never;
      throw new Error(`unexpected ${path}`);
    });
    renderVault();
    await screen.findByText('oldest.png');

    await userEvent.click(
      (await screen.findAllByRole('button', { name: /^Move .* to another kind$/ }))[0]!,
    );
    await userEvent.selectOptions(
      await screen.findByLabelText('New document kind'),
      'SSN_CARD',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Move it' }));

    const move = calls.find((c) => c.path.includes('/reclassify'));
    expect(move).toBeTruthy();
    expect(move!.body).toEqual({ kind: 'SSN_CARD' });
    // Crucially NOT a rejection: no email, no reopened task.
    expect(calls.some((c) => c.path.includes('/reject'))).toBe(false);
  });
});
