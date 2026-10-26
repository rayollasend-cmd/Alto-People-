import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Notification } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/communicationsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/communicationsApi')>()),
  listMyInbox: vi.fn(),
  markRead: vi.fn().mockResolvedValue({}),
  markAllRead: vi.fn().mockResolvedValue({ updated: 0 }),
  markKindRead: vi.fn().mockResolvedValue({ updated: 0 }),
  listAdmin: vi.fn(),
  listChannels: vi.fn().mockResolvedValue({ channels: [] }),
  listSuppressions: vi.fn().mockResolvedValue({ suppressions: [] }),
}));
vi.mock('@/lib/dirCommsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/dirCommsApi')>()),
  myBroadcasts: vi.fn(),
  markBroadcastRead: vi.fn().mockResolvedValue({}),
  listBroadcasts: vi.fn().mockResolvedValue({ broadcasts: [] }),
  listBroadcastTemplates: vi.fn().mockResolvedValue({ broadcasts: [] }),
}));
vi.mock('@/lib/whatsappApi', () => ({ getWhatsAppOverview: vi.fn(), listWhatsAppMessages: vi.fn() }));

import { listAdmin, listMyInbox, markAllRead, markRead } from '@/lib/communicationsApi';
import { markBroadcastRead, myBroadcasts } from '@/lib/dirCommsApi';
import { AssociateInboxView, INBOX_PAGE, collapseRepeats, previewOf, type InboxEntry } from '@/pages/communications/AssociateInboxView';
import { CommunicationsHome } from '@/pages/communications/CommunicationsHome';
import { AdminCommsView, deliveryOf, groupSends, statusLabelOf } from '@/pages/communications/AdminCommsView';
import { DirCommsHome, directoryRedirectTarget } from '@/pages/dirComms/DirCommsHome';

/**
 * F500 G4 · /communications ("Notifications"):
 *  - one-line rows (dot · subject · preview · time), the message in a
 *    reading pane on a wide screen and under its row on a phone;
 *  - pick several and mark them read; 50 at a time;
 *  - one header titled Notifications with the tabs under it;
 *  - the sent log: one row per message across channels, and an email that
 *    went nowhere says "Not sent", in grey;
 *  - /directory is retired and its links land on the right home.
 */

const note = (id: string, over: Partial<Notification> = {}): Notification => ({
  id,
  channel: 'IN_APP',
  status: 'SENT',
  recipientUserId: 'u1',
  recipientPhone: null,
  recipientEmail: null,
  subject: `Subject ${id}`,
  body: `First line of ${id}\nSecond line of ${id}`,
  category: null,
  externalRef: null,
  failureReason: null,
  sentAt: '2026-10-22T14:00:00.000Z',
  readAt: null,
  senderUserId: null,
  senderEmail: null,
  linkUrl: null,
  createdAt: '2026-10-22T14:00:00.000Z',
  ...over,
});

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.mocked(listMyInbox).mockReset();
  vi.mocked(myBroadcasts).mockReset().mockResolvedValue({ broadcasts: [] } as never);
  vi.mocked(markRead).mockClear();
  vi.mocked(markAllRead).mockClear();
  vi.mocked(markBroadcastRead).mockClear();
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('the notifications list', () => {
  it('previews the first line that says something', () => {
    expect(previewOf('\n  • Workers Comp overdue\nmore')).toBe('Workers Comp overdue');
    expect(previewOf('Hi Maria,\n\nYour onboarding is 0% complete.')).toBe('Your onboarding is 0% complete.');
    expect(previewOf('Hi Maria,')).toBe('Hi Maria,');
  });

  it('shows one-line rows, opens the message in the reading pane and marks it read', async () => {
    vi.mocked(listMyInbox).mockResolvedValue({
      notifications: [note('a', { linkUrl: '/compliance?tab=scorecard' }), note('b', { readAt: '2026-10-22T15:00:00.000Z' })],
      total: 2,
    });
    renderAs('HR_ADMINISTRATOR', <AssociateInboxView />);
    expect(await screen.findByText('Subject a')).toBeInTheDocument();
    // The preview is the first line only; the rest of the body waits for the reader.
    expect(screen.getByText('First line of a')).toBeInTheDocument();
    expect(screen.queryByText(/Second line of a/)).not.toBeInTheDocument();
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    expect(screen.getByText('Pick a notification to read it here.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Subject a/ }));
    const pane = screen.getByRole('heading', { name: 'Subject a' }).closest('article')!;
    expect(within(pane).getByText(/Second line of a/)).toBeInTheDocument();
    expect(within(pane).getByRole('button', { name: /Open/ })).toBeInTheDocument();
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('a'));
  });

  it('on a phone the message opens under its row', async () => {
    window.matchMedia = ((q: string) => ({ ...realMatchMedia(q), matches: false })) as typeof window.matchMedia;
    vi.mocked(listMyInbox).mockResolvedValue({ notifications: [note('a')], total: 1 });
    renderAs('ASSOCIATE', <AssociateInboxView />);
    const row = await screen.findByRole('button', { name: /Subject a/ });
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Second line of a/)).toBeInTheDocument();
    expect(screen.queryByText('Pick a notification to read it here.')).not.toBeInTheDocument();
  });

  it('marks the picked ones read in one request, broadcasts by their own route', async () => {
    vi.mocked(listMyInbox).mockResolvedValue({ notifications: [note('a'), note('b'), note('c')], total: 3 });
    vi.mocked(myBroadcasts).mockResolvedValue({
      broadcasts: [{ id: 'bc1', title: 'Holiday hours', body: 'We close at 6.', sentAt: '2026-10-22T13:00:00.000Z', readAt: null }],
    } as never);
    renderAs('HR_ADMINISTRATOR', <AssociateInboxView />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select “Subject a”' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select “Subject c”' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select “Holiday hours”' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(markAllRead).toHaveBeenCalledWith(['a', 'c']));
    expect(markBroadcastRead).toHaveBeenCalledWith('bc1');
    expect(markRead).not.toHaveBeenCalled();
  });

  it(`shows ${INBOX_PAGE} at a time`, async () => {
    const many = Array.from({ length: 60 }, (_, i) => note(`n${i}`, { createdAt: new Date(Date.UTC(2026, 9, 22, 12, 0, 60 - i)).toISOString() }));
    vi.mocked(listMyInbox).mockResolvedValue({ notifications: many, total: 60 });
    renderAs('HR_ADMINISTRATOR', <AssociateInboxView />);
    await screen.findByText('Subject n0');
    expect(document.querySelectorAll('[data-inbox-row]')).toHaveLength(50);
    await userEvent.click(screen.getByRole('button', { name: 'Show 10 more' }));
    expect(document.querySelectorAll('[data-inbox-row]')).toHaveLength(60);
  });
});

describe('the Notifications page', () => {
  it('has one header, titled Notifications, with the tabs under it', async () => {
    vi.mocked(listMyInbox).mockResolvedValue({ notifications: [note('a')], total: 1 });
    renderAs('HR_ADMINISTRATOR', <CommunicationsHome />, '/communications');
    const h1s = await screen.findAllByRole('heading', { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(['Notifications']);
    const tabs = screen.getByRole('tablist');
    // The title comes first, then the tabs: they used to sit above it.
    expect(h1s[0]!.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The Notifications tab carries the unread count.
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Notifications1', 'SendsSends & broadcasts', 'WhatsApp']));
  });

  it('puts Send and New broadcast in the header on the sends tab', async () => {
    vi.mocked(listMyInbox).mockResolvedValue({ notifications: [], total: 0 });
    vi.mocked(listAdmin).mockResolvedValue({ notifications: [], total: 0 });
    renderAs('HR_ADMINISTRATOR', <CommunicationsHome />, '/communications?tab=sends');
    expect(await screen.findByRole('button', { name: /^Send$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New broadcast/ })).toBeInTheDocument();
    expect(await screen.findByText('Nothing sent yet')).toBeInTheDocument();
  });

  it('an associate gets their notifications, no tabs', async () => {
    vi.mocked(listMyInbox).mockResolvedValue({ notifications: [note('a')], total: 1 });
    renderAs('ASSOCIATE', <CommunicationsHome />, '/communications?tab=sends');
    expect(await screen.findByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});

describe('the sent log', () => {
  it('is one row per message across its channels, and counts an email with no provider as not sent', () => {
    const email = (id: string, over: Partial<Notification> = {}) => note(id, { channel: 'EMAIL', recipientEmail: `${id}@x.com`, ...over });
    const groups = groupSends([
      note('1', { recipientUserId: 'ua', subject: 'Reminder', createdAt: '2026-10-22T14:05:10.000Z' }),
      email('2', { recipientUserId: 'ua', subject: 'Reminder', createdAt: '2026-10-22T14:05:40.000Z', externalRef: 'STUB-EMAIL-x', loggedOnly: true }),
      note('3', { recipientUserId: 'ub', subject: 'Reminder', createdAt: '2026-10-22T14:05:12.000Z', readAt: '2026-10-22T15:00:00.000Z' }),
      email('4', { recipientUserId: 'ub', subject: 'Reminder', createdAt: '2026-10-22T14:05:13.000Z', status: 'FAILED' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ channels: ['IN_APP', 'EMAIL'], people: 2, sent: 1, read: 1, notSent: 1, failed: 1 });
    const logged = groups[0]!.rows[1]!;
    expect(deliveryOf(logged)).toBe('notSent');
    expect(statusLabelOf(logged)).toBe('Not sent: no email provider');
  });

  it('shows a logged-only email as not sent, in grey, never "Sent"', async () => {
    vi.mocked(listAdmin).mockResolvedValue({
      notifications: [note('9', { channel: 'EMAIL', recipientEmail: 'ana@x.com', recipientName: 'Ana Reyes', recipientUserId: null, externalRef: 'STUB-EMAIL-abc', loggedOnly: true })],
      total: 1,
    });
    renderAs('HR_ADMINISTRATOR', <AdminCommsView canManage />, '/communications?tab=sends');
    const badge = await screen.findByText('Not sent: no email provider');
    expect(badge.className).not.toMatch(/success|alert|destructive/);
    expect(within(screen.getByRole('table')).queryByText(/^Sent$/)).not.toBeInTheDocument();
  });

  it('keeps the channel and status filters in the URL and asks the API with them', async () => {
    vi.mocked(listAdmin).mockResolvedValue({ notifications: [], total: 0 });
    renderAs('HR_ADMINISTRATOR', <AdminCommsView canManage />, '/communications?tab=sends&channel=EMAIL&status=NOT_CONFIGURED');
    await waitFor(() => expect(listAdmin).toHaveBeenCalledWith({ channel: 'EMAIL', status: 'NOT_CONFIGURED' }));
    expect(await screen.findByText('Nothing matches these filters')).toBeInTheDocument();
  });
});

describe('/directory is retired', () => {
  it('sends each old link to its one home', () => {
    expect(directoryRedirectTarget('')).toBe('/people');
    expect(directoryRedirectTarget('?q=ana')).toBe('/people?q=ana');
    expect(directoryRedirectTarget('?tab=broadcasts')).toBe('/communications?tab=sends&view=broadcasts');
    expect(directoryRedirectTarget('?tab=broadcasts&broadcast=b1')).toBe('/communications?tab=sends&view=broadcasts&broadcast=b1');
    expect(directoryRedirectTarget('?tab=surveys')).toBe('/pulse');
  });

  it('redirects in the router', async () => {
    function Where() {
      const l = useLocation();
      return <p>at {l.pathname + l.search}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/directory?tab=broadcasts&broadcast=b1']}>
        <Routes>
          <Route path="/directory" element={<DirCommsHome />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('at /communications?tab=sends&view=broadcasts&broadcast=b1')).toBeInTheDocument();
  });
});

describe('repeated notifications (F500 2026-10-26)', () => {
  const e = (key: string, over: Partial<InboxEntry> = {}): InboxEntry => ({
    key,
    kind: 'message',
    sourceId: key,
    subject: 'Escalated: Coastal Resort Holdings is still waiting',
    body: 'Workforce was reminded yesterday.',
    createdAt: '2026-10-25T21:06:00.000Z',
    readAt: null,
    senderEmail: null,
    linkUrl: null,
    category: 'relay.escalation',
    ...over,
  });

  it('collapses identical copies into one row that counts them, newest first, unread while any copy is', () => {
    const rows = collapseRepeats([
      e('a'),
      e('b', { readAt: '2026-10-25T22:00:00.000Z' }),
      e('c', { subject: 'Onboarding stalled' }),
      e('d'),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['a', 'c']);
    expect(rows[0]!.copies.map((c) => c.key)).toEqual(['a', 'b', 'd']);
    expect(rows[0]!.readAt).toBeNull();
    expect(rows[1]!.copies).toHaveLength(1);
  });

  it('a repeat whose text moved on ("847h past", then "828h past") is still the same alert', () => {
    const rows = collapseRepeats([e('a', { body: 'Still open, 847h past its reply-by.' }), e('b', { body: 'Still open, 828h past its reply-by.' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Still open, 847h past its reply-by.');
  });
});
