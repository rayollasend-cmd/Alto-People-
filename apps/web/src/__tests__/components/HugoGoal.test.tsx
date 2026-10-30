import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HugoGoalView, HugoTaskView } from '@alto-people/shared';

/**
 * A goal on the Tasks tab (components/assistant/HugoGoalCard): his words as
 * the title, the plan as a checklist (done / now / next), what he would like
 * to do next with Approve / Not this / Stop — and, once approved, how it went,
 * right on the card. "Give Hugo a goal" with role examples, and the chat's
 * Start card for one.
 */

const startHugoTask = vi.fn();
vi.mock('@/lib/hugoApi', () => ({ startHugoTask: (...a: unknown[]) => startHugoTask(...a) }));
const auth = vi.hoisted(() => ({ user: { id: 'u1', role: 'ASSOCIATE', associateId: 'a1' } as Record<string, unknown>, desk: false }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: auth.user, can: () => auth.desk }) }));

import { I18nProvider } from '@/lib/i18n';
import { HugoGoalCard } from '@/components/assistant/HugoGoalCard';
import { HugoGoalOfferCard } from '@/components/assistant/HugoGoalOffer';
import { HugoGoalStart } from '@/components/assistant/HugoGoalStart';

const ID = '33333333-3333-4333-8333-333333333333';
// Midday, so "two hours from now" is still today (after 10 PM it was tomorrow, and the card said so).
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0));
afterAll(() => {
  vi.useRealTimers();
});
const now = new Date();
const later = new Date(now.getTime() + 2 * 3_600_000);

function goalTask(over: Partial<HugoTaskView> = {}, goal: Partial<HugoGoalView> = {}): HugoTaskView {
  return {
    id: ID,
    kind: 'GOAL',
    status: 'WORKING',
    needs: null,
    choices: [],
    subject: { goal: 'Get me 40 hours next week' },
    progress: { done: 1, total: 3 },
    result: null,
    linkUrl: null,
    source: 'panel',
    seen: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    events: [
      { id: 'e1', code: 'STARTED', data: {}, at: now.toISOString() },
      { id: 'e2', code: 'STEP', data: { tier: 'deep' }, at: now.toISOString() },
      { id: 'e3', code: 'PLANNED', data: { count: 3 }, at: now.toISOString() },
      { id: 'e4', code: 'WATCH_STARTED', data: { kind: 'WATCH_OPEN_SHIFTS', taskId: 'x' }, at: now.toISOString() },
    ],
    goal: {
      text: 'Get me 40 hours next week',
      plan: [
        { text: 'Find open shifts that fit', state: 'done' },
        { text: 'Ask for the best one', state: 'doing' },
        { text: 'Check it was approved', state: 'todo' },
      ],
      pending: null,
      last: null,
      lastCheckInAt: now.toISOString(),
      nextCheckAt: later.toISOString(),
      thinking: false,
      steps: { used: 2, max: 12 },
      paused: null,
      outcome: null,
      summary: null,
      ...goal,
    },
    ...over,
  };
}

function mount(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  startHugoTask.mockReset();
  auth.user = { id: 'u1', role: 'ASSOCIATE', associateId: 'a1' };
  auth.desk = false;
  window.localStorage.setItem('alto.lang', 'en');
});
afterEach(() => {
  window.localStorage.removeItem('alto.lang');
});

describe('HugoGoalCard', () => {
  it('shows the goal as its title, the plan as done / now / next, and when he looks again', () => {
    mount(<HugoGoalCard task={goalTask()} busy={null} onRespond={vi.fn()} onStop={vi.fn()} />);
    const card = screen.getByTestId('hugo-goal');
    expect(within(card).getByText('Get me 40 hours next week')).toBeInTheDocument();
    const steps = within(screen.getByTestId('hugo-goal-plan')).getAllByRole('listitem');
    expect(steps.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'doing', 'todo']);
    // The state is read out, not only drawn.
    expect(steps[0]).toHaveTextContent('Done: Find open shifts that fit');
    expect(steps[1]).toHaveTextContent('Now: Ask for the best one');
    expect(steps[2]).toHaveTextContent('Next: Check it was approved');
    expect(screen.getByTestId('hugo-goal-now')).toHaveTextContent(/^Next check-in: today/);
    // No proposal, nothing to approve.
    expect(screen.queryByTestId('hugo-goal-proposal')).toBeNull();
    // The trail hides each step of thinking: Started, the plan, the watch.
    fireEvent.click(screen.getByRole('button', { name: /what I did|Show/i }));
    const trail = within(screen.getByTestId('hugo-goal-trail')).getAllByRole('listitem');
    expect(trail.map((li) => li.textContent)).toEqual([
      expect.stringContaining('You gave me this goal'),
      expect.stringContaining('Made a plan (3 steps)'),
      expect.stringContaining('Watching for open shifts that fit you'),
    ]);
  });

  it('a proposal: what he wants to do and why, with Approve / Not this / Stop (Stop asks first)', async () => {
    const onRespond = vi.fn();
    const task = goalTask(
      { status: 'NEEDS_YOU', needs: 'GOAL_APPROVAL', choices: ['APPROVE', 'DECLINE', 'STOP'] },
      { pending: { action: 'PICK_UP_SHIFT', title: 'Ask for the open Stocker shift, Sat, Oct 31, 7:00 AM', detail: 'Walmart 1234. Your manager approves it.', why: 'It adds eight hours.', at: now.toISOString() }, nextCheckAt: null },
    );
    mount(<HugoGoalCard task={task} busy={null} onRespond={onRespond} onStop={vi.fn()} />);
    const proposal = screen.getByTestId('hugo-goal-proposal');
    expect(proposal).toHaveTextContent('I’d like to do this next');
    expect(proposal).toHaveTextContent('Ask for the open Stocker shift');
    expect(proposal).toHaveTextContent('Walmart 1234. Your manager approves it.');
    expect(proposal).toHaveTextContent('It adds eight hours.');
    expect(proposal).toHaveTextContent('Nothing happens until you approve it.');
    expect(screen.getByTestId('hugo-goal-now')).toHaveTextContent('Waiting for your answer');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Approve' }));
    expect(onRespond).toHaveBeenLastCalledWith('APPROVE');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Not this' }));
    expect(onRespond).toHaveBeenLastCalledWith('DECLINE');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Stop goal' }));
    expect(onRespond).toHaveBeenCalledTimes(2);
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    expect(dialog).toHaveTextContent('Anything I started for it stops too.');
    fireEvent.click(within(dialog).getAllByRole('button').find((b) => /stop/i.test(b.textContent ?? '') && !/keep/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(onRespond).toHaveBeenLastCalledWith('STOP'));
  });

  it('while one answer is in flight the others wait; Keep going when it used its steps', () => {
    const task = goalTask(
      { status: 'NEEDS_YOU', needs: 'KEEP_GOING', choices: ['KEEP_GOING', 'STOP'] },
      { pending: { action: 'KEEP_GOING', title: 'Keep working on this goal', detail: "I've taken 12 steps on it. I can take up to 12 more.", why: null, at: now.toISOString() }, steps: { used: 12, max: 12 } },
    );
    const onRespond = vi.fn();
    mount(<HugoGoalCard task={task} busy={null} onRespond={onRespond} onStop={vi.fn()} />);
    expect(screen.getByTestId('hugo-goal-now')).toHaveTextContent('I’ve taken 12 steps on this. Want me to keep going?');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(onRespond).toHaveBeenCalledWith('KEEP_GOING');
  });

  it('the result of an approved step, in place: done with a link, sent for approval, or the plain refusal', () => {
    const { rerender } = mount(
      <HugoGoalCard task={goalTask({}, { last: { action: 'PICK_UP_SHIFT', title: 'Ask for the open Stocker shift', outcome: 'done', code: null, at: now.toISOString(), linkUrl: '/marketplace' }, thinking: true })} busy={null} onRespond={vi.fn()} onStop={vi.fn()} />,
    );
    let result = screen.getByTestId('hugo-goal-result');
    expect(result).toHaveAttribute('data-outcome', 'done');
    expect(result).toHaveTextContent('Done');
    expect(within(result).getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/marketplace');
    expect(screen.getByTestId('hugo-goal-now')).toHaveTextContent('Working out the next step…');

    const qc = new QueryClient();
    const again = (t: HugoTaskView) =>
      rerender(
        <QueryClientProvider client={qc}>
          <I18nProvider>
            <MemoryRouter>
              <HugoGoalCard task={t} busy={null} onRespond={vi.fn()} onStop={vi.fn()} />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    again(goalTask({}, { last: { action: 'REQUEST_TIME_OFF', title: 'Request time off, Sat, Nov 7', outcome: 'pending', code: null, at: now.toISOString(), linkUrl: '/time-off' } }));
    expect(screen.getByTestId('hugo-goal-result')).toHaveTextContent('Sent for approval');
    again(goalTask({}, { last: { action: 'PICK_UP_SHIFT', title: 'Ask for the open Stocker shift', outcome: 'refused', code: 'shift_not_available', at: now.toISOString(), linkUrl: null } }));
    result = screen.getByTestId('hugo-goal-result');
    expect(result).toHaveAttribute('data-outcome', 'refused');
    expect(result).toHaveTextContent('That didn’t go through');
    expect(result).toHaveTextContent('That shift isn’t open any more.');
    expect(within(result).queryByRole('link')).toBeNull();
    again(goalTask({}, { last: { action: 'MESSAGE_CREW', title: 'Text 3 people', outcome: 'refused', code: 'weird_code', at: now.toISOString(), linkUrl: null } }));
    expect(screen.getByTestId('hugo-goal-result')).toHaveTextContent('The app said no. Open it to try it yourself.');
  });

  it('a pause says why and until when; a finished goal shows its summary', () => {
    const { unmount } = mount(<HugoGoalCard task={goalTask({ status: 'WAITING' }, { paused: { why: 'allowance', until: new Date(now.getTime() + 5 * 86_400_000).toISOString() } })} busy={null} onRespond={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByTestId('hugo-goal-now')).toHaveTextContent(/I’ve used this month’s thinking time — I’ll pick this up on/);
    unmount();
    mount(<HugoGoalCard task={goalTask({ status: 'DONE', completedAt: now.toISOString() }, { outcome: 'DONE', summary: 'You have 40 hours next week.', nextCheckAt: null })} busy={null} onRespond={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText('You have 40 hours next week.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('reads in the person’s language', async () => {
    window.localStorage.setItem('alto.lang', 'es');
    const task = goalTask({ status: 'NEEDS_YOU', needs: 'GOAL_APPROVAL', choices: ['APPROVE', 'DECLINE', 'STOP'] }, { pending: { action: 'PICK_UP_SHIFT', title: 'Pedir el turno abierto de Stocker', detail: null, why: null, at: now.toISOString() }, nextCheckAt: null });
    mount(<HugoGoalCard task={task} busy={null} onRespond={vi.fn()} onStop={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Aprobar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Esto no' })).toBeInTheDocument();
    expect(screen.getByTestId('hugo-goal-proposal')).toHaveTextContent('No pasa nada hasta que lo apruebes.');
  });
});

describe('Give Hugo a goal', () => {
  it('an associate sees their examples; one fills the box, Start sends it', async () => {
    startHugoTask.mockResolvedValue({ task: goalTask(), existing: false });
    const onStarted = vi.fn();
    mount(<HugoGoalStart name="Hugo" onStarted={onStarted} />);
    expect(screen.getByRole('textbox', { name: 'Give Hugo a goal' })).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Get me 40 hours next week' }));
    expect(screen.getByRole('textbox', { name: 'Give Hugo a goal' })).toHaveValue('Get me 40 hours next week');
    expect(startHugoTask).not.toHaveBeenCalled();
    fireEvent.click(start);
    await waitFor(() => expect(startHugoTask).toHaveBeenCalledWith({ kind: 'GOAL', goal: 'Get me 40 hours next week' }, 'panel'));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(ID));
  });

  it('a desk sees its own examples; an SSN is stopped before it is sent; a refusal reads plainly', async () => {
    auth.user = { id: 'u2', role: 'OPERATIONS_MANAGER', associateId: null };
    auth.desk = true;
    startHugoTask.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'too_many_goals' }));
    mount(<HugoGoalStart name="Hugo" onStarted={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Keep tomorrow fully staffed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get me 40 hours next week' })).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Give Hugo a goal' });
    fireEvent.change(box, { target: { value: 'Fix pay for 123-45-6789' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Leave out Social Security and account numbers.');
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Keep tomorrow fully staffed' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('You have as many goals open as I can take.');
  });
});

describe('the chat’s Start card for a goal', () => {
  it('shows the goal and what Hugo will do; Start starts it and points to the Tasks tab', async () => {
    startHugoTask.mockResolvedValue({ task: goalTask(), existing: false });
    const onSeeTasks = vi.fn();
    mount(<HugoGoalOfferCard offer={{ task: { kind: 'GOAL', goal: 'Get me 40 hours next week' }, subject: { goal: 'Get me 40 hours next week' } }} onSeeTasks={onSeeTasks} />);
    const card = screen.getByTestId('hugo-goal-offer');
    expect(card).toHaveTextContent('Get me 40 hours next week');
    expect(card).toHaveTextContent('check with you before changing anything');
    fireEvent.click(within(card).getByRole('button', { name: /Start/ }));
    await waitFor(() => expect(startHugoTask).toHaveBeenCalledWith({ kind: 'GOAL', goal: 'Get me 40 hours next week' }, 'chat'));
    fireEvent.click(await within(card).findByRole('button', { name: /See|task/i }));
    expect(onSeeTasks).toHaveBeenCalledWith(ID);
  });
});
