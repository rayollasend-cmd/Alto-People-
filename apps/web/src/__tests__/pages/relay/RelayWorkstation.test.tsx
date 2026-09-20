import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { WorkFile, WorkRequest } from '@/pages/relay/workTypes';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { RelayRequests } from '@/pages/relay/RelayRequests';
import { RelayFiles } from '@/pages/relay/RelayFiles';

/**
 * The workstation: ask another desk with a document attached, answer on
 * the thread, and keep the work's documents on a shelf you can search.
 */

const FILE: WorkFile = {
  id: 'f1',
  name: 'handbook-2026.pdf',
  mime: 'application/pdf',
  size: 248_000,
  createdAt: new Date().toISOString(),
  uploadedBy: { userId: 'u-hr', name: 'Hana Reed', photoUrl: null },
  desk: 'HR',
  tags: ['policy'],
  about: null,
  requestId: null,
  url: '/api/relay/files/f1/download',
};

const REQUEST: WorkRequest = {
  id: 'r1',
  kind: 'ASK',
  status: 'OPEN',
  subject: 'Does Maria need a new I-9?',
  body: 'She worked for us in 2024 — does the old one still count?',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dueAt: null,
  answeredAt: null,
  from: { userId: 'u-wf', name: 'Wes Ford', photoUrl: null },
  toDesk: 'HR',
  toUser: null,
  claimedBy: null,
  about: { associateId: 'a1', name: 'Maria Lopez' },
  files: [FILE],
  replies: 0,
  mine: true,
};

function harness(ui: React.ReactElement) {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (path.startsWith('/relay/requests?')) return { requests: [REQUEST], counts: { inbox: 1, sent: 0, unanswered: 1 } } as never;
    if (path === '/relay/requests') return { request: { ...REQUEST, id: 'r2' } } as never;
    if (path === '/relay/requests/r1') return { request: { ...REQUEST, messages: [] } } as never;
    if (path === '/relay/requests/r1/messages') return { message: { id: 'm1', body: 'A new one.', createdAt: new Date().toISOString(), author: null, files: [] } } as never;
    if (path.startsWith('/relay/files')) return { files: [FILE], tags: ['policy', 'walmart'] } as never;
    throw new Error(`unexpected ${path}`);
  });
  const caps = ROLE_CAPABILITIES.WORKFORCE_MANAGER;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u-wf', email: 'wes@altohr.com', role: 'WORKFORCE_MANAGER', status: 'ACTIVE' as const, clientId: null, associateId: null },
          role: 'WORKFORCE_MANAGER',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});

describe('requests between desks', () => {
  it('shows what is on your desk, who it is about, and what came with it', async () => {
    harness(<RelayRequests desks={{ HR: [{ userId: 'u-hr', name: 'Hana Reed', photoUrl: null }] }} myDesk="WORKFORCE" openId={null} onOpen={() => {}} />);
    expect(await screen.findByText('Does Maria need a new I-9?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'On my desk (1)' })).toBeInTheDocument();
    expect(screen.getByText(/about Maria Lopez/)).toBeInTheDocument();
    expect(screen.getByText('HR')).toBeInTheDocument();
  });

  it('sends a question to a desk, with a person and a deadline', async () => {
    const calls = harness(
      <RelayRequests desks={{ HR: [{ userId: 'u-hr', name: 'Hana Reed', photoUrl: null }] }} myDesk="WORKFORCE" openId={null} onOpen={() => {}} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Send to a desk/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Send to another desk' });
    await userEvent.selectOptions(within(dialog).getByLabelText('To which desk'), 'HR');
    await userEvent.selectOptions(within(dialog).getByLabelText('Anyone there, or someone in particular'), 'u-hr');
    await userEvent.type(within(dialog).getByLabelText('Subject'), 'Which form for a rehire?');
    await userEvent.type(within(dialog).getByLabelText('Your question'), 'Maria is coming back on Monday.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/relay/requests' && c.method === 'POST')?.body).toMatchObject({
        kind: 'ASK',
        toDesk: 'HR',
        toUserId: 'u-hr',
        subject: 'Which form for a rehire?',
      }),
    );
  });

  it('a thread opens with the ask, its files, and a reply box', async () => {
    const calls = harness(<RelayRequests desks={{}} myDesk="HR" openId="r1" onOpen={() => {}} />);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('heading', { name: 'Does Maria need a new I-9?' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'handbook-2026.pdf' })).toHaveAttribute('href', '/api/relay/files/f1/download');
    await userEvent.type(within(drawer).getByLabelText('Your reply'), 'A new one — the old I-9 expired.');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Reply' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/relay/requests/r1/messages')?.body).toMatchObject({ body: 'A new one — the old I-9 expired.' }),
    );
    // Whoever holds the desk can pick it up and answer it.
    expect(within(drawer).getByRole('button', { name: /I’ve got it/ })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /Mark answered/ })).toBeInTheDocument();
  });
});

describe('the work shelf', () => {
  it('lists documents with their shelf, tags and a download', async () => {
    harness(<RelayFiles myDesk="WORKFORCE" />);
    expect(await screen.findByRole('link', { name: 'handbook-2026.pdf' })).toBeInTheDocument();
    expect(screen.getByText('242 KB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'policy' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download handbook-2026.pdf' })).toHaveAttribute('href', '/api/relay/files/f1/download');
    // Someone else put it there — not this viewer's to remove.
    expect(screen.queryByRole('button', { name: /Take handbook-2026.pdf off/ })).not.toBeInTheDocument();
  });

  it('puts a document on a desk’s shelf', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ file: FILE }) });
    vi.stubGlobal('fetch', fetchMock);
    harness(<RelayFiles myDesk="WORKFORCE" />);
    await userEvent.click(await screen.findByRole('button', { name: /Add a document/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a work document' });
    await userEvent.upload(within(dialog).getByLabelText('Choose a file'), new File(['x'], 'checklist.pdf', { type: 'application/pdf' }));
    await userEvent.type(within(dialog).getByLabelText('Tags (optional)'), 'walmart');
    await userEvent.click(within(dialog).getByRole('button', { name: /Put it on the shelf/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/relay/files', expect.objectContaining({ method: 'POST' })));
    const body = fetchMock.mock.calls[0]![1].body as FormData;
    expect((body.get('file') as File).name).toBe('checklist.pdf');
    expect(body.get('desk')).toBe('WORKFORCE');
    expect(body.get('tags')).toBe('walmart');
  });
});

describe('the relay says what it does not know', () => {
  /**
   * Both lists rendered an EmptyState on failure. "Nothing on your desk"
   * when the request actually failed is not a cosmetic problem: it tells
   * a desk it is clear when nobody has any idea whether it is.
   */
  function broken(ui: React.ReactElement) {
    vi.mocked(apiFetch).mockImplementation(async () => {
      throw new Error('the network, briefly');
    });
    const caps = ROLE_CAPABILITIES.WORKFORCE_MANAGER;
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u-wf', email: 'wes@altohr.com', role: 'WORKFORCE_MANAGER', status: 'ACTIVE' as const, clientId: null, associateId: null },
            role: 'WORKFORCE_MANAGER',
            capabilities: new Set<Capability>(caps),
            signIn: vi.fn(),
            signOut: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <ConfirmProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ConfirmProvider>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
  }

  it('never reports an empty inbox it could not load', async () => {
    broken(<RelayRequests desks={undefined} myDesk="HR" openId={null} onOpen={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('Nothing on your desk')).not.toBeInTheDocument();
  });

  it('never reports an empty shelf it could not load', async () => {
    broken(<RelayFiles myDesk="HR" />);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('Nothing on this shelf yet')).not.toBeInTheDocument();
  });
});

describe('finding one thing among a desk’s traffic', () => {
  it('searches the requests on screen, and offers a way back', async () => {
    harness(<RelayRequests desks={undefined} myDesk="HR" openId={null} onOpen={vi.fn()} />);
    await screen.findByText('Does Maria need a new I-9?');
    // It also says what the desk owes somebody, which is the number a
    // desk actually runs on.
    expect(screen.getByText(/request needs an answer/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Search requests'), 'payroll');
    await waitFor(() => expect(screen.getByText('Nothing matches')).toBeInTheDocument());
    // Not "no requests yet" — the box has one, it just isn't this.
    expect(screen.queryByText('Nothing on your desk')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Does Maria need a new I-9?')).toBeInTheDocument();
  });
});
