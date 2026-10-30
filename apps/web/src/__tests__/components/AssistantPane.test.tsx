import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const askHugo = vi.fn();
const handoffToPerson = vi.fn();
const decideAssistantAction = vi.fn();
const getHugoSummary = vi.fn();
const listHugoTasks = vi.fn();
const listHugoNotes = vi.fn();
const startHugoTask = vi.fn();
const respondToHugoTask = vi.fn();
const cancelHugoTask = vi.fn();
const acceptHugoNote = vi.fn();
const dismissHugoNote = vi.fn();
const markHugoSeen = vi.fn();
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
  getHugoSummary: () => getHugoSummary(),
  listHugoTasks: () => listHugoTasks(),
  listHugoNotes: () => listHugoNotes(),
  startHugoTask: (...a: unknown[]) => startHugoTask(...a),
  respondToHugoTask: (...a: unknown[]) => respondToHugoTask(...a),
  cancelHugoTask: (...a: unknown[]) => cancelHugoTask(...a),
  acceptHugoNote: (...a: unknown[]) => acceptHugoNote(...a),
  dismissHugoNote: (...a: unknown[]) => dismissHugoNote(...a),
  markHugoSeen: (...a: unknown[]) => markHugoSeen(...a),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ASSOCIATE', email: 'a@example.com' }, can: () => true }),
}));

import { AssistantProvider, useAssistant } from '@/lib/assistantContext';
import { AssistantPane } from '@/components/assistant/AssistantPane';
import { HugoLauncher } from '@/components/assistant/HugoLauncher';

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
  for (const f of [startHugoTask, respondToHugoTask, cancelHugoTask, acceptHugoNote, dismissHugoNote, markHugoSeen]) f.mockReset();
  getHugoSummary.mockReset().mockResolvedValue({ working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 });
  listHugoTasks.mockReset().mockResolvedValue({ tasks: [] });
  listHugoNotes.mockReset().mockResolvedValue({ notes: [] });
  markHugoSeen.mockResolvedValue({ tasks: 0, notes: 0 });
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

/** A browser's speech recognition, driven by the test. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  onresult: ((e: { results: unknown }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {}
  say(words: string) {
    this.onresult?.({ results: { length: 1, 0: { isFinal: true, 0: { transcript: words } } } });
    this.onend?.();
  }
}

describe('Hugo, the agent', () => {
  it('stops a message carrying an SSN, says why — and always says not to share one', async () => {
    mount();
    fireEvent.click(screen.getByText('spark'));
    const input = await screen.findByLabelText(/ask hugo/i);
    expect(screen.getByText('Don’t share your SSN or bank details here.')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'my ssn is 123-45-6789, is my w2 right?' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/looks like a Social Security or bank number/);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.submit(input.closest('form')!);
    expect(askHugo).not.toHaveBeenCalled();
  });

  it('shows what he is doing: reading while the question is out, then where the answer came from', async () => {
    let answer!: (v: unknown) => void;
    askHugo.mockReturnValue(new Promise((r) => (answer = r)));
    mount();
    fireEvent.click(screen.getByText('spark'));
    const pane = await screen.findByTestId('assistant-pane');
    // On a desktop the cursor lands in the box as he opens: he is listening already.
    const input = screen.getByLabelText(/ask hugo/i);
    expect(pane.dataset.hugoStatus).toBe('listening');
    fireEvent.blur(input);
    expect(pane.dataset.hugoStatus).toBe('ready');
    fireEvent.change(input, { target: { value: 'when do I work next?' } });
    expect(pane.dataset.hugoStatus).toBe('listening');
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(pane.dataset.hugoStatus).toBe('reading'));
    expect(screen.getByTestId('hugo-status')).toHaveTextContent('Reading your records…');
    await act(async () => answer({ intent: 'SCHEDULE', reply: 'Tomorrow 9–5.', linkUrl: '/scheduling', handoff: null, source: 'rules' }));
    await screen.findByText('Tomorrow 9–5.');
    expect(pane.dataset.hugoStatus).toBe('answered');
    expect(screen.getByText('From your schedule')).toBeInTheDocument();
  });

  it('as the answer is made: the step he is on, then his words as he writes them, then the answer', async () => {
    let answer!: (v: unknown) => void;
    let emit!: (e: unknown) => void;
    askHugo.mockImplementation((_q: string, opts: { onEvent?: (e: unknown) => void }) => {
      emit = opts.onEvent!;
      return new Promise((r) => (answer = r));
    });
    mount();
    fireEvent.click(screen.getByText('spark'));
    const pane = await screen.findByTestId('assistant-pane');
    const input = screen.getByLabelText(/ask hugo/i);
    fireEvent.change(input, { target: { value: 'why is Saturday off?' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(askHugo).toHaveBeenCalled());
    await act(async () => emit({ t: 'step', step: 'schedule' }));
    expect(pane.dataset.hugoStatus).toBe('reading');
    expect(screen.getByTestId('hugo-status')).toHaveTextContent('Checking the schedule…');
    await act(async () => emit({ t: 'text', d: 'You asked ' }));
    await act(async () => emit({ t: 'text', d: 'for Saturday off.' }));
    expect(screen.getByTestId('hugo-live')).toHaveTextContent('You asked for Saturday off.');
    expect(pane.dataset.hugoStatus).toBe('answered');
    // A lead-in dropped ("let me check") empties the bubble back to the step line.
    await act(async () => emit({ t: 'clear' }));
    expect(screen.getByTestId('hugo-live')).not.toHaveTextContent('You asked');
    await act(async () => answer({ intent: 'MODEL', reply: 'You asked for Saturday off, and it was approved.', linkUrl: null, handoff: null, source: 'model', tier: 'fast' }));
    await screen.findByText('You asked for Saturday off, and it was approved.');
    expect(screen.queryByTestId('hugo-live')).toBeNull();
  });

  it('asks out loud where the browser can listen: what was said goes as the question, in the person’s language', async () => {
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    askHugo.mockResolvedValue({ intent: 'PAYDAY', reply: 'Friday.', linkUrl: null, handoff: null, source: 'rules' });
    try {
      mount();
      fireEvent.click(screen.getByText('spark'));
      const mic = await screen.findByRole('button', { name: 'Ask out loud' });
      fireEvent.click(mic);
      const pane = screen.getByTestId('assistant-pane');
      expect(pane.dataset.hugoStatus).toBe('hearing');
      expect(FakeRecognition.last?.lang).toBe('en-US');
      expect(screen.getByRole('button', { name: 'Stop listening' })).toHaveAttribute('aria-pressed', 'true');
      await act(async () => FakeRecognition.last!.say('when is payday'));
      await waitFor(() => expect(askHugo).toHaveBeenCalled());
      expect(askHugo.mock.calls[0]![0]).toBe('when is payday');
      await screen.findByText('Friday.');
    } finally {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    }
  });

  it('has no microphone where the browser cannot listen', async () => {
    mount();
    fireEvent.click(screen.getByText('spark'));
    await screen.findByLabelText(/ask hugo/i);
    expect(screen.queryByRole('button', { name: 'Ask out loud' })).toBeNull();
  });

  it('a phone opens him from the launcher, which steps aside while he is open', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/']}>
          <AssistantProvider>
            <HugoLauncher />
            <AssistantPane />
          </AssistantProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByTestId('hugo-launcher'));
    await screen.findByTestId('assistant-pane');
    expect(screen.queryByTestId('hugo-launcher')).toBeNull();
  });
});

/* ------------------------------------------------- Hugo works for you */

const T1 = '11111111-1111-4111-8111-111111111111';
const N1 = '22222222-2222-4222-8222-222222222222';
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function coverTask(over: Record<string, unknown> = {}) {
  return {
    id: T1,
    kind: 'FIND_COVER',
    status: 'NEEDS_YOU',
    needs: 'NO_ONE_LEFT',
    choices: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
    subject: { shift: { id: 's1', startsAt: '2026-10-31T11:00:00.000Z', endsAt: '2026-10-31T19:00:00.000Z', timezone: 'America/New_York', site: 'Walmart 1234', position: 'Cashier' } },
    progress: { done: 2, total: 2 },
    result: null,
    linkUrl: '/scheduling',
    source: 'chat',
    seen: false,
    createdAt: iso(-3),
    updatedAt: iso(-1),
    completedAt: null,
    expiresAt: iso(40),
    events: [
      { id: 'e1', code: 'STARTED', data: {}, at: iso(-3) },
      { id: 'e2', code: 'ASKED', data: { name: 'Cy D.' }, at: iso(-3) },
      { id: 'e3', code: 'DECLINED', data: { name: 'Cy D.' }, at: iso(-2) },
      { id: 'e4', code: 'ASKED', data: { name: 'Ben M.' }, at: iso(-2) },
      { id: 'e5', code: 'NO_ANSWER', data: { name: 'Ben M.' }, at: iso(-1) },
      { id: 'e6', code: 'NO_ONE_LEFT', data: { asked: 2 }, at: iso(-1) },
    ],
    ...over,
  };
}

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function mountAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AssistantProvider>
          <Opener />
          <Where />
          <AssistantPane />
        </AssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Hugo works for you', () => {
  it('a Start card hands him the work — nothing starts until the tap — and points to the Tasks tab', async () => {
    askHugo.mockResolvedValue({ intent: 'TASK_TELL_ME_WHEN', reply: 'I can take care of that.', linkUrl: null, handoff: null, source: 'rules', offers: [{ task: { kind: 'WATCH_PAYCHECK' }, subject: {} }] });
    const started = { ...coverTask(), id: T1, kind: 'WATCH_PAYCHECK', status: 'WAITING', needs: null, choices: [], subject: {}, progress: null, seen: true, events: [{ id: 'e1', code: 'STARTED', data: {}, at: iso(0) }] };
    startHugoTask.mockResolvedValue({ task: started, existing: false });
    mount();
    fireEvent.click(await screen.findByText('seat'));
    const card = await screen.findByRole('group', { name: 'Task to start: Your next paycheck' });
    expect(card).toHaveTextContent('I’ll tell you when your pay is in and your paystub is ready.');
    expect(startHugoTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(startHugoTask).toHaveBeenCalledWith({ kind: 'WATCH_PAYCHECK' }, 'chat'));
    await screen.findByText('On it — I’ll tell you when it’s done.');

    listHugoTasks.mockResolvedValue({ tasks: [started] });
    fireEvent.click(screen.getByRole('button', { name: 'See in Tasks' }));
    expect(screen.getByRole('tab', { name: /Tasks/ })).toHaveAttribute('aria-selected', 'true');
    const task = await screen.findByRole('article', { name: 'Your next paycheck' });
    expect(task).toHaveAttribute('data-status', 'WAITING');
    // The composer belongs to the chat.
    expect(screen.queryByLabelText(/ask hugo/i)).toBeNull();
  });

  it('what needs the person: the badge, the reason, the answers on offer — and the steps he took', async () => {
    getHugoSummary.mockResolvedValue({ working: 0, needsYou: 1, unseenDone: 0, newNotes: 0 });
    listHugoTasks.mockResolvedValue({ tasks: [coverTask()] });
    respondToHugoTask.mockResolvedValue({ task: coverTask({ status: 'WAITING', needs: null, choices: [] }) });
    mount();
    fireEvent.click(await screen.findByText('spark'));
    const tab = await screen.findByRole('tab', { name: 'Tasks, 1 new' });
    fireEvent.click(tab);
    const card = await screen.findByRole('article', { name: /^Cover for Sat, Oct 31/ });
    expect(card).toHaveTextContent('No one free could take it. You’re still on this shift.');
    expect(card).toHaveTextContent('Asked 2 of 2');
    expect(screen.getByRole('img', { name: 'New' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show steps (5)' }));
    const steps = screen.getByRole('list', { name: 'What I did' });
    expect(steps).toHaveTextContent('Asked Cy D.');
    expect(steps).toHaveTextContent('Cy D. can’t take it');
    expect(steps).toHaveTextContent('No answer from Ben M. — moved on');

    fireEvent.click(screen.getByRole('button', { name: 'Keep trying' }));
    await waitFor(() => expect(respondToHugoTask).toHaveBeenCalledWith(T1, 'KEEP_TRYING'));
    // Looking counts as seen — after a moment, so the dot is seen first.
    await waitFor(() => expect(markHugoSeen).toHaveBeenCalledWith({ tasks: [T1], notes: [] }), { timeout: 3000 });
  });

  it('stopping asks first, and a cover search says the request is withdrawn and the shift stays theirs', async () => {
    listHugoTasks.mockResolvedValue({ tasks: [coverTask({ status: 'WAITING', needs: null, choices: [], events: [{ id: 'e1', code: 'STARTED', data: {}, at: iso(-1) }, { id: 'e2', code: 'ASKED', data: { name: 'Cy D.' }, at: iso(-1) }] })] });
    cancelHugoTask.mockResolvedValue({ task: coverTask({ status: 'CANCELLED', needs: null, choices: [] }) });
    mount();
    fireEvent.click(await screen.findByText('spark'));
    fireEvent.click(await screen.findByRole('tab', { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Stop: Cover for/ }));
    expect(await screen.findByText('I’ll withdraw the request I sent. You stay on the shift.')).toBeInTheDocument();
    expect(cancelHugoTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    await waitFor(() => expect(cancelHugoTask).toHaveBeenCalledWith(T1));
  });

  it('what he noticed: one tap to act, or put away', async () => {
    listHugoNotes.mockResolvedValue({
      notes: [
        {
          id: N1,
          kind: 'OPEN_SHIFT_MATCH',
          status: 'NEW',
          data: { shift: { id: 'os1', startsAt: '2026-10-30T13:00:00.000Z', endsAt: '2026-10-30T21:00:00.000Z', timezone: 'America/New_York', site: 'Walmart 1234', position: 'Cashier' }, more: 0 },
          action: { kind: 'link', url: '/marketplace?shift=os1' },
          createdAt: iso(-1),
        },
      ],
    });
    acceptHugoNote.mockResolvedValue({ note: { id: N1 }, task: null, url: '/marketplace?shift=os1' });
    dismissHugoNote.mockResolvedValue({ note: { id: N1 } });
    mountAt('/me');
    fireEvent.click(await screen.findByText('spark'));
    fireEvent.click(await screen.findByRole('tab', { name: /Tasks/ }));
    const note = await screen.findByRole('article', { name: 'An open shift fits you' });
    expect(note).toHaveTextContent('Walmart 1234. Take it only if you want the hours.');
    fireEvent.click(screen.getByRole('button', { name: 'See the shift' }));
    await waitFor(() => expect(acceptHugoNote).toHaveBeenCalledWith(N1));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/marketplace?shift=os1'));
  });

  it('a link to a task opens the pane on it, wherever it lands, and the link tidies itself away', async () => {
    listHugoTasks.mockResolvedValue({ tasks: [coverTask()] });
    mountAt(`/payroll?hugo=task:${T1}`);
    const card = await screen.findByRole('article', { name: /^Cover for/ });
    expect(screen.getByRole('tab', { name: /Tasks/ })).toHaveAttribute('aria-selected', 'true');
    expect(card).toHaveClass('ring-2');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/payroll$/));
  });

  it('says when he is working in the background', async () => {
    getHugoSummary.mockResolvedValue({ working: 2, needsYou: 0, unseenDone: 0, newNotes: 0 });
    mount();
    fireEvent.click(await screen.findByText('spark'));
    // A desktop opens with the cursor in the box (he is listening); idle, he says what he is busy with.
    fireEvent.blur(await screen.findByLabelText(/ask hugo/i));
    await waitFor(() => expect(screen.getByTestId('hugo-status')).toHaveTextContent('Working on 2 tasks for you'));
  });
});

