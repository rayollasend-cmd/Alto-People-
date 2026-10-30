import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HugoAdminUsage, HugoAllowanceView, HugoProfileView, HugoThreadView } from '@alto-people/shared';

/**
 * One Hugo per account, on screen: the conversation comes from the server
 * (the tab's copy is only first paint), no history is sent with a question,
 * Start over clears it for every device, read-aloud follows the profile,
 * and the person's allowance shows as a meter in the ⋯ menu, a quiet line
 * from 80%, a calm banner when used up, and the home seat's idle line. The
 * admin's "thinking time" card shows the month's spend.
 */

const api = vi.hoisted(() => ({
  me: { name: 'Hugo', audience: 'associate', intro: "I'm Hugo, your assistant.", can: [{ key: 'SCHEDULE', label: 'Your next shifts', example: "What's my schedule?" }], model: true },
  askHugo: vi.fn(),
  getHugoThread: vi.fn(),
  clearHugoThread: vi.fn(),
  getHugoProfile: vi.fn(),
  setHugoReadAloud: vi.fn(),
  getHugoAllowance: vi.fn(),
  getHugoAdminUsage: vi.fn(),
  can: true,
}));
vi.mock('@/lib/hugoApi', () => ({
  getHugo: vi.fn(async () => api.me),
  askHugo: (...a: unknown[]) => api.askHugo(...a),
  handoffToPerson: vi.fn(),
  decideAssistantAction: vi.fn(),
  getHugoSummary: vi.fn(async () => ({ working: 0, needsYou: 0, unseenDone: 0, newNotes: 0 })),
  listHugoTasks: vi.fn(async () => ({ tasks: [] })),
  listHugoNotes: vi.fn(async () => ({ notes: [] })),
  markHugoSeen: vi.fn(async () => ({ tasks: 0, notes: 0 })),
  getHugoThread: () => api.getHugoThread(),
  clearHugoThread: () => api.clearHugoThread(),
  getHugoProfile: () => api.getHugoProfile(),
  setHugoReadAloud: (on: boolean) => api.setHugoReadAloud(on),
  getHugoAllowance: () => api.getHugoAllowance(),
  getHugoAdminUsage: () => api.getHugoAdminUsage(),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ASSOCIATE', email: 'a@example.com', firstName: 'Ana' }, can: () => api.can }),
  useTerm: () => (k: string) => (k === 'workers' ? 'Associates' : k),
}));

import { ApiError } from '@/lib/api';
import { AssistantProvider, useAssistant } from '@/lib/assistantContext';
import { AssistantPane } from '@/components/assistant/AssistantPane';
import { HUGO_PROFILE_KEY, HUGO_THREAD_KEY, mergeThread } from '@/components/assistant/HugoThread';
import { isSensitiveQueryKey } from '@/lib/queryPersist';
import { HugoAllowanceAdminSection } from '@/components/assistant/HugoAllowanceAdmin';
import { HugoSeat } from '@/components/home/HugoSeat';

const thread = (turns: HugoThreadView['turns'], clearedAt: string | null = null): HugoThreadView => ({ turns, clearedAt, retentionDays: 90 });
const turn = (id: string, role: 'user' | 'assistant', text: string, intent: string | null = null) => ({ id, role, text, intent, linkUrl: null, createdAt: '2026-11-10T15:00:00.000Z' });
const allowance = (over: Partial<HugoAllowanceView> = {}): HugoAllowanceView => ({
  on: true,
  allowanceClass: 'floor',
  usedPercent: 23,
  exhausted: false,
  periodStart: '2026-10-28T18:00:00.000Z',
  renewsAt: '2026-11-27T18:00:00.000Z',
  ...over,
});
const profile = (over: Partial<HugoProfileView> = {}): HugoProfileView => ({ readAloud: null, threadClearedAt: null, retentionDays: 90, ...over });

function Opener() {
  const { toggle } = useAssistant();
  return <button onClick={toggle}>spark</button>;
}

function mount(children: React.ReactNode = <AssistantPane />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/me']}>
        <AssistantProvider>
          <Opener />
          {children}
        </AssistantProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openPane() {
  fireEvent.click(await screen.findByText('spark'));
  return screen.findByTestId('assistant-pane');
}

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  api.me = { ...api.me, model: true };
  api.can = true;
  api.askHugo.mockReset();
  api.getHugoThread.mockReset().mockResolvedValue(thread([]));
  api.clearHugoThread.mockReset().mockResolvedValue({ clearedAt: '2026-11-10T16:00:00.000Z', removed: 2 });
  api.getHugoProfile.mockReset().mockResolvedValue(profile());
  api.setHugoReadAloud.mockReset().mockImplementation(async (on: boolean) => profile({ readAloud: on }));
  api.getHugoAllowance.mockReset().mockResolvedValue(allowance());
  api.getHugoAdminUsage.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('the conversation follows the account', () => {
  it('loads from the server; the tab’s old copy is only first paint', async () => {
    // This tab remembers a line the server never kept (or another device cleared).
    window.sessionStorage.setItem('alto:assistant:thread:u1', JSON.stringify([{ id: '1-u', role: 'user', text: 'a stale line', localAt: 1 }]));
    api.getHugoThread.mockResolvedValue(thread([turn('t1', 'user', 'When is payday?'), turn('t2', 'assistant', 'Friday, Nov 14.', 'PAYDAY')]));
    mount();
    await openPane();
    await screen.findByText('Friday, Nov 14.');
    expect(screen.getByText('When is payday?')).toBeInTheDocument();
    expect(screen.queryByText('a stale line')).toBeNull();
  });

  it('a question carries no history; the answer keeps the server’s ids and refreshes the meter', async () => {
    api.askHugo.mockResolvedValue({ intent: 'MODEL', reply: 'One shift fewer.', linkUrl: null, source: 'model', turns: { question: { id: 'q1', createdAt: '2026-11-10T15:00:00Z' }, answer: { id: 'a1', createdAt: '2026-11-10T15:00:01Z' } }, allowance: null });
    mount();
    await openPane();
    await waitFor(() => expect(api.getHugoAllowance).toHaveBeenCalledTimes(1));
    const input = await screen.findByLabelText(/ask hugo/i);
    fireEvent.change(input, { target: { value: 'Why was my check short?' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('One shift fewer.');
    const opts = api.askHugo.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.history).toBeUndefined();
    await waitFor(() => expect(api.getHugoAllowance).toHaveBeenCalledTimes(2));
    // The tab's copy now carries the server's ids — the next load lines up with it.
    const kept = JSON.parse(window.sessionStorage.getItem('alto:assistant:thread:u1') ?? '[]') as Array<{ id: string }>;
    expect(kept.map((k) => k.id)).toEqual(['q1', 'a1']);
  });

  it('Start over clears it on the server (every device) and here', async () => {
    api.getHugoThread.mockResolvedValue(thread([turn('t1', 'user', 'When is payday?'), turn('t2', 'assistant', 'Friday, Nov 14.', 'PAYDAY')]));
    mount();
    await openPane();
    await screen.findByText('Friday, Nov 14.');
    const menu = await openMenu();
    expect(within(menu).getByTestId('hugo-thread-kept')).toHaveTextContent('Our chat is kept 90 days, on every device you sign in on.');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Start over' }));
    await waitFor(() => expect(api.clearHugoThread).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Friday, Nov 14.')).toBeNull());
    expect(screen.queryByText('When is payday?')).toBeNull();
  });

  it('a failed Start over puts the conversation back and says so', async () => {
    api.getHugoThread.mockResolvedValue(thread([turn('t1', 'user', 'When is payday?'), turn('t2', 'assistant', 'Friday, Nov 14.', 'PAYDAY')]));
    api.clearHugoThread.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    mount();
    await openPane();
    await screen.findByText('Friday, Nov 14.');
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Start over' }));
    await screen.findByText("Couldn't start over. Try again.");
    expect(screen.getByText('Friday, Nov 14.')).toBeInTheDocument();
  });
});

describe('the conversation never touches the disk cache', () => {
  it('the thread is a sensitive query key (a chat can be about pay); the settings are not', () => {
    expect(isSensitiveQueryKey(HUGO_THREAD_KEY)).toBe(true);
    expect(isSensitiveQueryKey(HUGO_PROFILE_KEY)).toBe(false);
  });
});

describe('mergeThread', () => {
  it('server turns win; this tab’s extras ride along by id; only lines added after the fetch stay', () => {
    const local = [
      { id: 'old-e', role: 'assistant' as const, text: 'an old error', localAt: 100 },
      { id: 't2', role: 'assistant' as const, text: 'Friday.', actions: ['card'], localAt: 150 },
      { id: 'new-u', role: 'user' as const, text: 'on its way', localAt: 300 },
    ];
    const merged = mergeThread(thread([turn('t1', 'user', 'When?'), turn('t2', 'assistant', 'Friday.', 'PAYDAY')]), 200, local);
    expect(merged.map((m) => m.id)).toEqual(['t1', 't2', 'new-u']);
    expect(merged[1]).toMatchObject({ intent: 'PAYDAY', actions: ['card'] });
    // Cleared on another device: everything older than the fetch goes.
    expect(mergeThread(thread([], '2026-11-10T16:00:00Z'), 400, local)).toEqual([]);
  });
});

describe('read aloud follows the account', () => {
  const speech = () => {
    Object.assign(window, { speechSynthesis: { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] }, SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {} });
  };
  afterEach(() => {
    // Unmount first: the panel stops speaking as it closes.
    cleanup();
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
    delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
  });

  it('the profile’s choice is the menu’s; switching it goes to the server', async () => {
    speech();
    api.getHugoProfile.mockResolvedValue(profile({ readAloud: true }));
    mount();
    await openPane();
    await waitFor(() => expect(api.getHugoProfile).toHaveBeenCalled());
    const menu = await openMenu();
    const item = within(menu).getByRole('menuitemcheckbox', { name: 'Read answers aloud' });
    await waitFor(() => expect(item).toHaveAttribute('aria-checked', 'true'));
    await userEvent.click(item);
    await waitFor(() => expect(api.setHugoReadAloud).toHaveBeenCalledWith(false));
  });

  it('never chosen on any device: this browser’s earlier choice is carried up once', async () => {
    speech();
    window.localStorage.setItem('alto.hugo.readAloud', '1');
    mount();
    await openPane();
    await waitFor(() => expect(api.setHugoReadAloud).toHaveBeenCalledWith(true));
    expect(api.setHugoReadAloud).toHaveBeenCalledTimes(1);
  });
});

describe('the allowance on screen', () => {
  it('the ⋯ menu shows the share used and the renewal day; the office also sees dollars', async () => {
    mount();
    await openPane();
    await waitFor(() => expect(api.getHugoAllowance).toHaveBeenCalled());
    let menu = await openMenu();
    await waitFor(() => expect(within(menu).getByTestId('hugo-allowance-meter')).toHaveTextContent(/Thinking time this month: 23% used · renews .*Nov 27/));
    expect(within(menu).getByRole('meter', { name: 'Thinking time used' })).toHaveAttribute('aria-valuenow', '23');
    expect(within(menu).queryByText(/\$/)).toBeNull();
    await userEvent.keyboard('{Escape}');

    api.getHugoAllowance.mockResolvedValue(allowance({ allowanceClass: 'staff', usedPercent: 23, spentUsd: 2.3, capUsd: 10, renewsAt: '2026-12-01T05:00:00.000Z' }));
    mount();
    fireEvent.click(screen.getAllByText('spark')[1]!);
    await waitFor(() => expect(api.getHugoAllowance).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getAllByRole('button', { name: 'More options' })[0]!);
    menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getByText('$2.30 of $10.00')).toBeInTheDocument());
    // The office's month turns at midnight in the company's zone: the 1st, wherever the reader is.
    expect(within(menu).getByTestId('hugo-allowance-meter')).toHaveTextContent(/Dec 1/);
  });

  it('from 80% a quiet line above the input; nothing below it', async () => {
    api.getHugoAllowance.mockResolvedValue(allowance({ usedPercent: 85 }));
    mount();
    await openPane();
    await screen.findByText("You've used most of this month's thinking time.");
    expect(screen.queryByTestId('hugo-allowance-used-up')).toBeNull();
  });

  it('below 80%, and with no model, nothing', async () => {
    mount();
    await openPane();
    await waitFor(() => expect(api.getHugoAllowance).toHaveBeenCalled());
    expect(screen.queryByTestId('hugo-allowance-most')).toBeNull();
    expect(screen.queryByTestId('hugo-allowance-used-up')).toBeNull();
  });

  it('used up: a calm banner naming the day and what still works', async () => {
    api.getHugoAllowance.mockResolvedValue(allowance({ usedPercent: 100, exhausted: true }));
    mount();
    await openPane();
    const banner = await screen.findByTestId('hugo-allowance-used-up');
    expect(banner).toHaveTextContent(/^Until .*Nov 27 I can answer the basics — your payday, shifts, ride and documents\.$/);
    expect(banner).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('hugo-allowance-most')).toBeNull();
  });

  it('used up, the home seat’s idle line says it too', async () => {
    api.getHugoAllowance.mockResolvedValue(allowance({ usedPercent: 100, exhausted: true }));
    mount(<HugoSeat />);
    const line = await screen.findByTestId('hugo-mood');
    await waitFor(() => expect(line).toHaveAttribute('data-allowance', 'used-up'));
    expect(line).toHaveTextContent(/^Until .*Nov 27 I can answer the basics\.$/);
  });

  it('with no model the seat never asks', async () => {
    api.me = { ...api.me, model: false };
    mount(<HugoSeat />);
    await screen.findByTestId('hugo-mood');
    expect(api.getHugoAllowance).not.toHaveBeenCalled();
  });
});

describe('the admin’s thinking-time card', () => {
  const usage: HugoAdminUsage = {
    on: true,
    periodStart: '2026-11-01T04:00:00.000Z',
    periodEnd: '2026-12-01T05:00:00.000Z',
    totalUsd: 4.2,
    people: 3,
    byClass: { floor: 1.8, staff: 2.4 },
    byPurpose: { chat: 3, goal: 0.9, recurring: 0, whatsapp: 0.3 },
    exhaustedPeople: 2,
    capUsd: { floor: 1, staff: 10 },
    top: [
      { userId: 'u-hr', name: 'Hana Reyes', role: 'HR administrator', allowanceClass: 'staff', spentUsd: 2.4, usedPercent: 24, exhausted: false },
      { userId: 'u-ben', name: 'Ben Okafor', role: 'Associate', allowanceClass: 'floor', spentUsd: 1.2, usedPercent: 100, exhausted: true },
    ],
  };
  const mountCard = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <HugoAllowanceAdminSection />
      </QueryClientProvider>,
    );

  it('the month’s spend, what it was for, who has run out, and the top spenders', async () => {
    api.getHugoAdminUsage.mockResolvedValue(usage);
    mountCard();
    await screen.findByText('November 2026');
    const card = screen.getByTestId('hugo-admin-usage');
    expect(screen.getByRole('heading', { name: 'Hugo’s thinking time' })).toBeInTheDocument();
    expect(within(card).getByText('$4.20')).toBeInTheDocument();
    expect(within(card).getByText('Used up right now')).toBeInTheDocument();
    expect(within(card).getByText('Questions in the app')).toBeInTheDocument();
    const rows = within(card).getAllByTestId('hugo-usage-person');
    expect(rows.map((r) => within(r).getByText(/Reyes|Okafor/).textContent)).toEqual(['Hana Reyes', 'Ben Okafor']);
    expect(within(rows[1]!).getByText('Used up')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('100%')).toBeInTheDocument();
    expect(screen.getByText(/\$1\.00 every 30 days for associates, drivers and floor supervisors, \$10\.00 a month for the office/)).toBeInTheDocument();
  });

  it('nobody yet: says so plainly; no model: says nothing is spent', async () => {
    api.getHugoAdminUsage.mockResolvedValue({ ...usage, on: false, totalUsd: 0, people: 0, exhaustedPeople: 0, byClass: { floor: 0, staff: 0 }, byPurpose: { chat: 0, goal: 0, recurring: 0, whatsapp: 0 }, top: [] });
    mountCard();
    await screen.findByText('Nobody has used Hugo’s thinking yet this month.');
    expect(screen.getByText('No model is connected, so Hugo answers from your records alone and nothing is spent.')).toBeInTheDocument();
  });

  it('not for someone without manage:org, nor a store-bound admin the API refuses', async () => {
    api.can = false;
    const { container, unmount } = mountCard();
    expect(container).toBeEmptyDOMElement();
    expect(api.getHugoAdminUsage).not.toHaveBeenCalled();
    unmount();
    api.can = true;
    api.getHugoAdminUsage.mockRejectedValue(new ApiError(403, 'company_wide', 'Company-wide only.'));
    const second = mountCard();
    await waitFor(() => expect(api.getHugoAdminUsage).toHaveBeenCalled());
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });
});
