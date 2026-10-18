import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const askHugo = vi.fn();
const handoffToPerson = vi.fn();
const decideAssistantAction = vi.fn();
vi.mock('@/lib/hugoApi', () => ({
  getHugo: vi.fn(async () => ({
    name: 'Hugo',
    audience: 'associate',
    intro: "I'm Hugo, the AI assistant. I'm not a person.",
    can: [{ key: 'SCHEDULE', label: 'Your next shifts', example: "What's my schedule?" }],
    model: false,
  })),
  askHugo: (...a: unknown[]) => askHugo(...a),
  handoffToPerson: (...a: unknown[]) => handoffToPerson(...a),
  decideAssistantAction: (...a: unknown[]) => decideAssistantAction(...a),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ASSOCIATE', email: 'a@example.com' }, can: () => true }),
}));

import { AssistantProvider, useAssistant } from '@/lib/assistantContext';
import { AssistantPane } from '@/components/assistant/AssistantPane';

function Opener() {
  const { toggle, ask } = useAssistant();
  return (
    <>
      <button onClick={toggle}>spark</button>
      <button onClick={() => ask('from the seat')}>seat</button>
    </>
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/me']}>
        <AssistantProvider>
          <Opener />
          <AssistantPane />
        </AssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  askHugo.mockReset();
  handoffToPerson.mockReset();
  window.sessionStorage.clear();
});

describe('<AssistantPane>', () => {
  it('opens from the spark and ⌘J, sends the page along, and keeps the thread', async () => {
    askHugo.mockResolvedValue({ intent: 'SCHEDULE', reply: 'Tomorrow 9–5 at Walmart 1234.', linkUrl: '/scheduling', handoff: null, source: 'rules' });
    mount();
    expect(screen.queryByTestId('assistant-pane')).toBeNull();
    fireEvent.click(await screen.findByText('spark'));
    await screen.findByTestId('assistant-pane');
    fireEvent.click(screen.getByRole('button', { name: "What's my schedule?" }));
    await screen.findByText('Tomorrow 9–5 at Walmart 1234.');
    expect(askHugo).toHaveBeenCalledWith("What's my schedule?", expect.objectContaining({ page: expect.objectContaining({ path: '/me' }) }));
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/scheduling');

    // ⌘J closes and reopens; the thread is still there.
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(screen.queryByTestId('assistant-pane')).toBeNull();
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    await screen.findByText('Tomorrow 9–5 at Walmart 1234.');
  });

  it('a seat hands its question to the pane', async () => {
    askHugo.mockResolvedValue({ intent: 'MODEL', reply: 'Here you go.', linkUrl: null, handoff: null, source: 'model' });
    mount();
    fireEvent.click(await screen.findByText('seat'));
    await screen.findByText('from the seat');
    await screen.findByText('Here you go.');
  });

  it('a hand-off is offered as a button and sent only on confirmation', async () => {
    askHugo.mockResolvedValue({ intent: 'HANDOFF', reply: 'Want me to pass it to Dana?', linkUrl: null, handoff: { summary: 'my badge broke', who: 'Dana Reyes' }, source: 'rules' });
    handoffToPerson.mockResolvedValue({ reply: 'I have passed this to Dana Reyes.', linkUrl: '/messages/c1', sent: true });
    mount();
    fireEvent.click(await screen.findByText('seat'));
    const send = await screen.findByRole('button', { name: 'Send to Dana Reyes' });
    expect(handoffToPerson).not.toHaveBeenCalled();
    fireEvent.click(send);
    await waitFor(() => expect(handoffToPerson).toHaveBeenCalledWith('my badge broke'));
    await screen.findByText('I have passed this to Dana Reyes.');
    expect(screen.queryByRole('button', { name: 'Send to Dana Reyes' })).toBeNull();
  });

  it('an action is a card: nothing happens until Confirm, and the result lands in place', async () => {
    askHugo.mockResolvedValue({
      intent: 'MODEL',
      reply: 'I can call you out of tomorrow’s shift — tap Call out to do it.',
      linkUrl: null,
      handoff: null,
      source: 'model',
      actions: [{ id: 'a1', token: 'a1.sig', kind: 'call_out', title: 'Call out of Cashier at Front Beach', detail: 'Reason: sick.', confirmLabel: 'Call out', expiresAt: new Date(Date.now() + 600_000).toISOString() }],
      tables: [],
    });
    decideAssistantAction.mockResolvedValue({ status: 'done', title: 'Call out of Cashier at Front Beach', message: 'Done.', linkUrl: '/' });
    mount();
    fireEvent.click(screen.getByText('spark'));
    const input = await screen.findByLabelText(/ask hugo/i);
    fireEvent.change(input, { target: { value: 'I am sick tomorrow' } });
    fireEvent.submit(input.closest('form')!);
    const card = await screen.findByRole('group', { name: /proposed: call out of cashier/i });
    expect(decideAssistantAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Call out' }));
    await waitFor(() => expect(decideAssistantAction).toHaveBeenCalledWith('a1.sig', 'confirm'));
    expect(await screen.findByText(/Done\./)).toBeInTheDocument();
    expect(card.querySelector('button')?.textContent).not.toBe('Call out');
  });
});
