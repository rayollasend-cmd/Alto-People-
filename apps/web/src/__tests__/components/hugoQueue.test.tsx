import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HugoTaskView } from '@alto-people/shared';

/**
 * Muse phase 5 in the Tasks tab: one "Waiting for you" list of everything
 * that waits on the person (every kind, the most urgent first, each with its
 * own answers on the row), Upcoming for recurring briefs (when, next, last
 * sent; pause, change time, stop), "Repeat something", and the activity log
 * ("See everything Hugo did", grouped by day, paged). The home's "I need a
 * quick answer" line and the badge land on Waiting for you.
 */

const api = vi.hoisted(() => ({
  getHugo: vi.fn(),
  getHugoSummary: vi.fn(),
  listHugoTasks: vi.fn(),
  listHugoNotes: vi.fn(),
  markHugoSeen: vi.fn(),
  respondToHugoTask: vi.fn(),
  cancelHugoTask: vi.fn(),
  startHugoTask: vi.fn(),
  changeHugoRecurring: vi.fn(),
  listHugoActivity: vi.fn(),
}));
vi.mock('@/lib/hugoApi', async (orig) => ({ ...(await orig<typeof import('@/lib/hugoApi')>()), ...api }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ASSOCIATE', email: 'a@example.com', associateId: 'a1' }, can: () => false }),
}));

import { AssistantProvider, useAssistant } from '@/lib/assistantContext';
import { HugoTasksPanel } from '@/components/assistant/HugoTasksPanel';
import { HugoSeat } from '@/components/home/HugoSeat';
import { waitingOrder } from '@/components/assistant/hugoQueue';

const H = 3_600_000;
const iso = (h: number) => new Date(Date.now() + h * H).toISOString();
const uuid = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function task(over: Partial<HugoTaskView> & Pick<HugoTaskView, 'id' | 'kind'>): HugoTaskView {
  return {
    status: 'WAITING',
    needs: null,
    choices: [],
    subject: {},
    progress: null,
    result: null,
    linkUrl: null,
    source: 'panel',
    seen: true,
    createdAt: iso(-48),
    updatedAt: iso(-1),
    completedAt: null,
    expiresAt: iso(24 * 100),
    events: [{ id: `${over.id}-s`, code: 'STARTED', data: {}, at: iso(-48) }],
    ...over,
  };
}

const hours = task({
  id: uuid(1),
  kind: 'RECURRING',
  subject: { recurring: { what: 'MY_HOURS', cadence: 'WEEKLY', weekday: 5, time: '17:00', timezone: 'America/Chicago', paused: false } },
  result: { recurring: { nextAt: '2026-11-06T23:00:00.000Z', lastAt: iso(-24), deliveries: 1 } },
  events: [
    { id: 'h1', code: 'STARTED', data: {}, at: iso(-200) },
    { id: 'h2', code: 'DELIVERED', data: { what: 'MY_HOURS', text: 'This week you’ve worked 30 hours so far, with 8 more scheduled.' }, at: iso(-24) },
  ],
});

/** Four things waiting on the person, given out of order. */
const waiting = [
  task({ id: uuid(2), kind: 'WATCH_DOCUMENT', status: 'NEEDS_YOU', needs: 'REUPLOAD', choices: ['GOT_IT'], subject: { documents: [{ id: 'd1', name: 'id-card.jpg', kind: 'ID' }] }, result: { documents: [{ id: 'd1', name: 'id-card.jpg', status: 'REJECTED', reason: 'Blurry' }] }, events: [{ id: 'w2', code: 'DOC_REJECTED', data: { document: 'id-card.jpg' }, at: iso(-2) }] }),
  task({
    id: uuid(3),
    kind: 'FIND_COVER',
    status: 'NEEDS_YOU',
    needs: 'NO_ONE_LEFT',
    choices: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
    subject: { shift: { id: 's1', startsAt: iso(72), endsAt: iso(80), timezone: 'America/New_York', site: 'Walmart 1234', position: 'Cashier' } },
    events: [{ id: 'w3', code: 'NO_ONE_LEFT', data: { asked: 2 }, at: iso(-1) }],
  }),
  task({
    id: uuid(4),
    kind: 'RECURRING',
    status: 'NEEDS_YOU',
    needs: 'KEEP_GOING',
    choices: ['KEEP_GOING', 'STOP'],
    expiresAt: '2026-11-05T15:00:00.000Z',
    subject: { recurring: { what: 'SCHEDULE', cadence: 'DAILY', weekday: null, time: '07:00', timezone: 'America/Chicago', paused: false } },
    events: [{ id: 'w4', code: 'STARTED', data: {}, at: iso(-30) }],
  }),
  task({
    id: uuid(5),
    kind: 'FIND_COVER',
    status: 'NEEDS_YOU',
    needs: 'MANAGER_REJECTED',
    choices: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
    subject: { shift: { id: 's2', startsAt: iso(20), endsAt: iso(28), timezone: 'America/New_York', site: 'Walmart 1234', position: 'Cashier' } },
    events: [{ id: 'w5', code: 'REJECTED', data: { name: 'Ben M.' }, at: iso(-3) }],
  }),
];

function Probe() {
  const { open, tab, openWaiting, toggle } = useAssistant();
  return (
    <>
      <span data-testid="probe">{`${open}:${tab}`}</span>
      <button onClick={openWaiting}>to waiting</button>
      <button onClick={toggle}>spark</button>
    </>
  );
}

function PanelWhenOpen() {
  const { open, tab } = useAssistant();
  return open && tab === 'tasks' ? <HugoTasksPanel hugo onNavigate={() => {}} /> : null;
}

function mount(ui: React.ReactNode = <HugoTasksPanel hugo onNavigate={() => {}} />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <AssistantProvider>
          <Probe />
          {ui}
        </AssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getHugo.mockResolvedValue({ name: 'Hugo', audience: 'associate', intro: 'Hi', can: [{ key: 'SCHEDULE', label: 'Your next shifts', example: "What's my schedule?" }, { key: 'PAYDAY', label: 'Your next payday', example: 'When is payday?' }], model: false });
  api.getHugoSummary.mockResolvedValue({ working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 });
  api.listHugoTasks.mockResolvedValue({ tasks: [] });
  api.listHugoNotes.mockResolvedValue({ notes: [] });
  api.markHugoSeen.mockResolvedValue({ tasks: 0, notes: 0 });
});

describe('Waiting for you', () => {
  it('orders by urgency: the soonest shift first, then the oldest ask', () => {
    expect([...waiting].sort(waitingOrder).map((x) => x.id)).toEqual([uuid(5), uuid(3), uuid(4), uuid(2)]);
  });

  it('is one list at the top of the tab, with its count, each row with its own answers', async () => {
    api.listHugoTasks.mockResolvedValue({ tasks: [hours, ...waiting] });
    api.respondToHugoTask.mockResolvedValue({ task: { ...waiting[2], status: 'WAITING', needs: null, choices: [] } });
    mount();
    const section = await screen.findByTestId('hugo-sec-waiting');
    expect(within(section).getByRole('heading', { name: /Waiting for you/ })).toBeInTheDocument();
    expect(within(section).getByLabelText('4 waiting for you')).toHaveTextContent('4');
    const rows = within(section).getAllByRole('article');
    expect(rows.map((r) => r.id)).toEqual([uuid(5), uuid(3), uuid(4), uuid(2)].map((id) => `hugo-task-${id}`));
    // It comes before everything else in the tab.
    const all = screen.getByTestId('hugo-tasks');
    expect(all.firstElementChild).toBe(section);
    // The brief that asks to keep going: its question and its answer, on the row.
    const brief = rows[2]!;
    expect(brief).toHaveTextContent('Your next shifts · Every day at 7:00 AM');
    expect(brief).toHaveTextContent(/This ends on Thu, Nov 5\. Keep it coming\?/);
    fireEvent.click(within(brief).getByRole('button', { name: 'Keep going' }));
    await waitFor(() => expect(api.respondToHugoTask).toHaveBeenCalledWith(uuid(4), 'KEEP_GOING'));
    // The cover rows keep their own answers.
    expect(within(rows[0]!).getByRole('button', { name: 'Keep trying' })).toBeInTheDocument();
    expect(within(rows[3]!).getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('the home’s "I need a quick answer from you" opens the tab at it, and so does the badge', async () => {
    api.getHugoSummary.mockResolvedValue({ working: 0, needsYou: 4, unseenDone: 0, newNotes: 0 });
    api.listHugoTasks.mockResolvedValue({ tasks: waiting });
    mount(
      <>
        <HugoSeat />
        <PanelWhenOpen />
      </>,
    );
    const line = await screen.findByRole('button', { name: 'I need a quick answer from you' });
    fireEvent.click(line);
    expect(screen.getByTestId('probe')).toHaveTextContent('true:tasks');
    const section = await screen.findByTestId('hugo-sec-waiting');
    await waitFor(() => expect(document.activeElement).toBe(section));
  });

  it('opening the pane while something waits lands on the Tasks tab', async () => {
    api.getHugoSummary.mockResolvedValue({ working: 0, needsYou: 1, unseenDone: 0, newNotes: 0 });
    mount(<PanelWhenOpen />);
    await waitFor(() => expect(api.getHugoSummary).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByText('spark'));
    expect(screen.getByTestId('probe')).toHaveTextContent('true:tasks');
  });
});

describe('Upcoming', () => {
  it('shows what, when and next — and pauses, changes the time and stops it', async () => {
    api.listHugoTasks.mockResolvedValue({ tasks: [hours] });
    api.changeHugoRecurring.mockResolvedValue({ task: hours });
    api.cancelHugoTask.mockResolvedValue({ task: { ...hours, status: 'CANCELLED' } });
    mount();
    const row = await screen.findByRole('article', { name: 'Your hours this week' });
    expect(within(screen.getByTestId('hugo-sec-upcoming')).getByRole('heading', { name: 'Upcoming' })).toBeInTheDocument();
    expect(within(row).getByTestId('hugo-upcoming-when')).toHaveTextContent('Every Friday at 5:00 PM · next Fri, Nov 6');
    expect(row).toHaveTextContent('This week you’ve worked 30 hours so far');
    // Not "working on it".
    expect(screen.queryByRole('heading', { name: 'Working on it' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Pause: Your hours this week' }));
    await waitFor(() => expect(api.changeHugoRecurring).toHaveBeenCalledWith(uuid(1), { paused: true }));

    fireEvent.click(within(row).getByRole('button', { name: 'Change time: Your hours this week' }));
    fireEvent.click(within(row).getByRole('radio', { name: 'Every day' }));
    fireEvent.change(within(row).getByLabelText('Time'), { target: { value: '06:30' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.changeHugoRecurring).toHaveBeenLastCalledWith(uuid(1), { cadence: 'DAILY', time: '06:30' }));

    fireEvent.click(within(row).getByRole('button', { name: 'Stop: Your hours this week' }));
    expect(await screen.findByText('I won’t send it any more. You can start it again any time.')).toBeInTheDocument();
    expect(api.cancelHugoTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    await waitFor(() => expect(api.cancelHugoTask).toHaveBeenCalledWith(uuid(1)));
  });

  it('a paused brief says so and offers Resume', async () => {
    const paused = { ...hours, subject: { recurring: { ...hours.subject.recurring!, paused: true } }, result: { recurring: { nextAt: null, lastAt: null, deliveries: 1 } } };
    api.listHugoTasks.mockResolvedValue({ tasks: [paused] });
    api.changeHugoRecurring.mockResolvedValue({ task: hours });
    mount();
    const row = await screen.findByRole('article', { name: 'Your hours this week' });
    expect(row).toHaveAttribute('data-paused', 'true');
    expect(within(row).getByTestId('hugo-upcoming-when')).toHaveTextContent(/^Every Friday at 5:00 PM$/);
    fireEvent.click(within(row).getByRole('button', { name: 'Resume: Your hours this week' }));
    await waitFor(() => expect(api.changeHugoRecurring).toHaveBeenCalledWith(uuid(1), { paused: false }));
  });

  it('"Repeat something": what this person can have, how often, what time — Start sets it up', async () => {
    api.startHugoTask.mockResolvedValue({ task: hours, existing: false });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Repeat something on a schedule' }));
    const form = screen.getByTestId('hugo-repeat-form');
    const what = within(form).getByLabelText('What') as HTMLSelectElement;
    // The answers GET /hugo offers this associate, and their own hours — no free question without a model.
    expect([...what.options].map((o) => o.textContent)).toEqual(['Your next shifts', 'Your next payday', 'Your hours this week']);
    fireEvent.change(what, { target: { value: 'MY_HOURS' } });
    fireEvent.click(within(form).getByRole('radio', { name: 'Once a week' }));
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Time'), { target: { value: '16:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.startHugoTask).toHaveBeenCalledWith({ kind: 'RECURRING', what: 'MY_HOURS', cadence: 'WEEKLY', time: '16:00', weekday: 5 }, 'panel'));
  });
});

describe('See everything Hugo did', () => {
  it('groups his history by day in plain words, and pages back with "Show earlier"', async () => {
    const today = new Date();
    today.setHours(9, 15, 0, 0);
    const yesterday = new Date(today.getTime() - 24 * H);
    // Three days back: a weekday heading in the reader's words (no date bomb — the day follows the clock).
    const older = new Date(today.getTime() - 3 * 24 * H);
    const olderHeading = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(older.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}) }).format(older);
    api.listHugoActivity
      .mockResolvedValueOnce({
        items: [
          { id: 'a1', at: today.toISOString(), kind: 'task', code: 'DELIVERED', data: { what: 'MY_HOURS', text: 'You’ve worked 30 hours so far.' }, linkUrl: '/time', task: { id: uuid(1), kind: 'RECURRING', subject: hours.subject } },
          { id: 'a2', at: yesterday.toISOString(), kind: 'note', code: 'DISMISSED', data: {}, linkUrl: null, note: { id: 'n1', kind: 'DIRECT_DEPOSIT_MISSING', data: { payday: '2026-10-30' } } },
        ],
        next: `${yesterday.toISOString()}~a2`,
      })
      .mockResolvedValueOnce({
        items: [{ id: 'a3', at: older.toISOString(), kind: 'action', code: 'SENT_FOR_APPROVAL', data: { title: 'Call out of Fri, Oct 30', action: 'call_out' }, linkUrl: '/' }],
        next: null,
      });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'See everything Hugo did' }));
    const view = await screen.findByTestId('hugo-activity');
    expect(within(view).getByRole('heading', { name: 'What Hugo did' })).toBeInTheDocument();
    const todayGroup = await within(view).findByRole('region', { name: 'Today' });
    expect(todayGroup).toHaveTextContent('Your hours this week · Every Friday at 5:00 PM');
    expect(todayGroup).toHaveTextContent('Sent: You’ve worked 30 hours so far.');
    expect(within(view).getByRole('region', { name: 'Yesterday' })).toHaveTextContent('You put away something I noticed');
    expect(api.listHugoActivity).toHaveBeenCalledWith(null, 30);

    fireEvent.click(within(view).getByRole('button', { name: 'Show earlier' }));
    await waitFor(() => expect(api.listHugoActivity).toHaveBeenLastCalledWith(`${yesterday.toISOString()}~a2`, 30));
    const old = await within(view).findByRole('region', { name: olderHeading });
    expect(old).toHaveTextContent('Sent for approval, as you confirmed');
    expect(old).toHaveTextContent('Call out of Fri, Oct 30');
    expect(within(view).queryByRole('button', { name: 'Show earlier' })).toBeNull();

    fireEvent.click(within(view).getByRole('button', { name: 'Back to tasks' }));
    expect(await screen.findByTestId('hugo-tasks')).toBeInTheDocument();
  });
});

describe('a brief offered in the chat, and the link to the queue', () => {
  it('the Start card says what, when and how it comes — nothing starts until the tap', async () => {
    const { HugoTaskOfferCard } = await import('@/components/assistant/HugoTaskOffer');
    api.startHugoTask.mockResolvedValue({ task: hours, existing: false });
    const offer = { task: { kind: 'RECURRING' as const, what: 'MY_HOURS' as const, cadence: 'WEEKLY' as const, weekday: 5, time: '17:00' }, subject: hours.subject };
    mount(<HugoTaskOfferCard offer={offer} onSeeTasks={() => {}} />);
    const card = await screen.findByRole('group', { name: 'Task to start: Your hours this week · Every Friday at 5:00 PM' });
    expect(card).toHaveTextContent('I’ll send it as a notification. Pause it, change the time or stop it any time.');
    expect(api.startHugoTask).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.startHugoTask).toHaveBeenCalledWith(offer.task, 'chat'));
  });

  it('?hugo=waiting opens the Tasks tab at Waiting for you', async () => {
    api.listHugoTasks.mockResolvedValue({ tasks: waiting });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/payroll?hugo=waiting']}>
          <AssistantProvider>
            <Probe />
            <PanelWhenOpen />
          </AssistantProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('true:tasks'));
    const section = await screen.findByTestId('hugo-sec-waiting');
    await waitFor(() => expect(document.activeElement).toBe(section));
  });
});
