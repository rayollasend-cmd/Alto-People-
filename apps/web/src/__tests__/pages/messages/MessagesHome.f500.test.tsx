import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/messagesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/messagesApi')>()),
  listConversations: vi.fn(),
  getDirect: vi.fn(),
  startConversation: vi.fn(),
  getThread: vi.fn(),
  markRead: vi.fn(async () => ({})),
  messageDirectory: vi.fn(async () => ({ people: [] })),
  searchMessages: vi.fn(async () => ({ results: [] })),
}));
import { getDirect, getThread, listConversations, startConversation } from '@/lib/messagesApi';
import { MessagesHome } from '@/pages/messages/MessagesHome';

/**
 * The messenger, F500 G5: /messages?to= opens the thread or a first-message
 * draft — it never creates an empty thread (it made two); the thread header
 * says role · site, not the name again; the copy fits who is reading; no
 * search box over an empty list; a new conversation needs its first message.
 */

const ana = { id: 'u-ana', name: 'Ana Reyes', named: true, role: 'ASSOCIATE', roleLabel: 'Associate', siteName: 'Front Beach 218', photoUrl: null };

function page(role: Parameters<typeof renderAs>[0], route: string) {
  return renderAs(
    role,
    <Routes>
      <Route path="/messages" element={<MessagesHome />} />
      <Route path="/messages/:id" element={<MessagesHome />} />
    </Routes>,
    route,
  );
}

beforeEach(() => {
  vi.mocked(listConversations).mockReset();
  vi.mocked(getDirect).mockReset();
  vi.mocked(startConversation).mockReset();
  vi.mocked(getThread).mockReset();
  vi.mocked(listConversations).mockResolvedValue({ conversations: [] });
});

describe('MessagesHome (F500)', () => {
  it('?to= with no thread yet opens a draft; the thread is made only by the first message', async () => {
    vi.mocked(getDirect).mockResolvedValue({ conversationId: null, person: ana });
    vi.mocked(startConversation).mockResolvedValue({ id: 'c-new' });
    vi.mocked(getThread).mockResolvedValue({ id: 'c-new', kind: 'DIRECT', title: 'Ana Reyes', participants: [{ ...ana, lastReadAt: null }], seenUpTo: null, hasMore: false, messages: [] });
    page('HR_ADMINISTRATOR', '/messages?to=u-ana');
    const draft = await screen.findByTestId('message-draft');
    expect(within(draft).getByRole('heading', { name: 'Ana Reyes' })).toBeInTheDocument();
    expect(draft).toHaveTextContent('Associate · Front Beach 218');
    expect(startConversation).not.toHaveBeenCalled();
    await userEvent.type(within(draft).getByRole('textbox'), 'Can you cover Friday?');
    await userEvent.click(within(draft).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(startConversation).toHaveBeenCalledWith({ participantIds: ['u-ana'], body: 'Can you cover Friday?' }));
    expect(startConversation).toHaveBeenCalledTimes(1);
  });

  it('?to= with a thread opens it, and its header says role · site — not the name again', async () => {
    vi.mocked(getDirect).mockResolvedValue({ conversationId: 'c-1', person: ana });
    vi.mocked(getThread).mockResolvedValue({ id: 'c-1', kind: 'DIRECT', title: 'Ana Reyes', participants: [{ ...ana, lastReadAt: null }], seenUpTo: null, hasMore: false, messages: [] });
    page('HR_ADMINISTRATOR', '/messages?to=u-ana');
    expect(await screen.findByTestId('thread-subtitle')).toHaveTextContent(/^Associate · Front Beach 218$/);
    expect(startConversation).not.toHaveBeenCalled();
    // No second back arrow in the card (the phone's top bar has Back).
    expect(screen.queryByRole('button', { name: 'Back to messages' })).toBeNull();
  });

  it('speaks to who is reading, and shows no search box over an empty list', async () => {
    page('HR_ADMINISTRATOR', '/messages');
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
    expect(screen.getByText('Message your team. Every thread is kept as a record.')).toBeInTheDocument();
    expect(screen.getByText('Start a message to reach someone directly.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Search messages' })).toBeNull();
  });

  it('an empty inbox is one empty state with one labelled "New message" — no second pane, no icon-only button', async () => {
    page('ASSOCIATE', '/messages');
    await screen.findByText('No conversations yet');
    expect(screen.getAllByRole('button', { name: 'New message' })).toHaveLength(1);
    expect(screen.getByTestId('msg-new')).toHaveTextContent('New message');
    // The "pick a conversation" pane only shows beside a list.
    expect(screen.queryByText('Pick a conversation')).toBeNull();
  });

  it('with conversations, the header carries the one labelled "New message"', async () => {
    vi.mocked(listConversations).mockResolvedValue({
      conversations: [
        { id: 'c1', kind: 'DIRECT', title: 'Ana Reyes', participants: [ana], unread: 0, lastPreview: 'See you Friday', lastMessageAt: new Date().toISOString() },
      ],
    } as unknown as Awaited<ReturnType<typeof listConversations>>);
    page('ASSOCIATE', '/messages');
    await screen.findByText('See you Friday');
    expect(screen.getAllByRole('button', { name: 'New message' })).toHaveLength(1);
    expect(screen.queryByText('No conversations yet')).toBeNull();
  });

  it('a new conversation needs its first message', async () => {
    const { messageDirectory } = await import('@/lib/messagesApi');
    vi.mocked(messageDirectory).mockResolvedValue({ people: [{ ...ana, clientName: null }] });
    page('HR_ADMINISTRATOR', '/messages');
    await screen.findByText('No conversations yet');
    await userEvent.click(screen.getAllByRole('button', { name: 'New message' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByText('Ana Reyes'));
    const start = within(dialog).getByRole('button', { name: /Start/ });
    expect(start).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'First message' }), 'Hi Ana');
    expect(start).toBeEnabled();
  });
});
