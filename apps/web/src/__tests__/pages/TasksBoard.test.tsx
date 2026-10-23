import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkTaskDetailView, WorkTaskSummary, WorkTaskView } from '@alto-people/shared';

vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  const auth = { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' }, can: () => true };
  return { AuthContext: React.createContext(auth), useAuth: () => auth, useTerm: () => (k: string) => (k === 'site' ? 'Site' : k), useTenant: () => ({ modules: {}, terminology: {} }) };
});
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: () => [{ id: 'loc-1', name: 'Front Beach 218' }] }));
vi.mock('@/lib/tasksApi', () => ({
  listTasks: vi.fn(),
  getTaskSummary: vi.fn(),
  getTask: vi.fn(),
  handOffTask: vi.fn(),
  autoAssignTask: vi.fn(),
  recordTaskEvent: vi.fn(),
  createTask: vi.fn(),
  getTaskDay: vi.fn(),
}));

import { listTasks, getTaskSummary, getTask, getTaskDay } from '@/lib/tasksApi';
import { TasksBoard } from '@/pages/tasks/TasksBoard';

/**
 * Brief 3-2: the board shows every task with who holds it, says why a
 * queued one waits, and the drawer reads the assignment's reasons.
 */

const base = {
  locationId: 'loc-1',
  locationName: 'Front Beach 218',
  area: 'Dock 3',
  windowStart: '2026-10-16T14:00:00.000Z',
  windowEnd: '2026-10-16T18:00:00.000Z',
  capability: 'unloading',
  risk: 'HIGH' as const,
  estimatedMinutes: 45,
  reference: 'Truck 4471',
  notes: null,
  queuedReason: null,
  createdAt: '2026-10-16T12:00:00.000Z',
  updatedAt: '2026-10-16T12:00:00.000Z',
};

const assigned: WorkTaskView = {
  ...base,
  id: 't-1',
  type: 'Unload the morning truck',
  status: 'ASSIGNED',
  assignment: {
    id: 'a-1',
    workerId: 'w-cal',
    workerType: 'PERSON',
    workerName: 'Cal Ortega',
    state: 'ACTIVE',
    decidedBy: 'ENGINE',
    decidedByUserId: null,
    score: 90,
    costCents: 1125,
    reasons: [
      { factor: 'capability', points: 40, note: 'Certified for unloading' },
      { factor: 'availability', points: 30, note: 'On shift 2:00 PM–10:00 PM as GM floor associate' },
      { factor: 'risk', points: 0, note: 'High-risk work: a person may hold it' },
      { factor: 'cost', points: 20, note: '$11.25 for this task' },
      { factor: 'load', points: 0, note: 'No other task in the window' },
    ],
    ranking: [],
    createdAt: '2026-10-16T12:00:01.000Z',
    releasedAt: null,
  },
};

const queued: WorkTaskView = {
  ...base,
  id: 't-2',
  type: 'Scan aisle 7 shelves',
  capability: 'shelf-scanning',
  risk: 'LOW',
  status: 'QUEUED',
  assignment: null,
  queuedReason: 'No certified worker is free in the window (6 weighed)',
};

const summary: WorkTaskSummary = { open: 0, queued: 1, assigned: 1, inProgress: 0, exceptions: 0, doneToday: 3 };

function renderBoard(initial = '/tasks') {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initial]}>
        <TasksBoard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listTasks).mockResolvedValue({ tasks: [assigned, queued] });
  vi.mocked(getTaskDay).mockResolvedValue({ day: '2026-10-16', timezone: 'America/Chicago' });
  vi.mocked(getTaskSummary).mockResolvedValue(summary);
  vi.mocked(getTask).mockResolvedValue({ ...assigned, events: [{ id: 'e-1', kind: 'ASSIGNED', at: '2026-10-16T12:00:01.000Z', note: 'Certified for unloading', byUserId: null, workerId: 'w-cal' }], history: [] } as WorkTaskDetailView);
});

describe('<TasksBoard>', () => {
  it('opens on the site’s day from the API, never the browser’s UTC date (F500 SH-4)', async () => {
    renderBoard();
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-10-16' })));
    expect(vi.mocked(listTasks).mock.calls.every(([f]) => !('from' in f) || !String(f.from ?? '').endsWith('Z'))).toBe(true);
    expect(screen.getByLabelText('Day')).toHaveValue('2026-10-16');
  });

  it('lists live tasks with who holds them, and the counts above come from the same day (F500 G2)', async () => {
    renderBoard();
    expect(await screen.findByText('Unload the morning truck')).toBeInTheDocument();
    expect(screen.getByText('Cal Ortega')).toBeInTheDocument();
    // The window reads on the site's clock (14:00Z is 9 AM in Chicago), not UTC's 2 PM.
    expect(screen.getByText(/^9:00\sAM – 1:00\sPM/)).toBeInTheDocument();
    // The queued task is not live; it waits under its own state.
    expect(screen.queryByText('Scan aisle 7 shelves')).not.toBeInTheDocument();
    // The tiles count the day's list the grid reads — not a rolling 24h summary.
    expect(getTaskSummary).not.toHaveBeenCalled();
    const live = screen.getByRole('button', { name: /Live/ });
    expect(live).toHaveAttribute('aria-pressed', 'true');
    expect(live).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Waiting for a person/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Exceptions/ })).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: /^Done/ })).toHaveTextContent('0');
  });

  it('the Waiting tile is the filter: it shows why a queued task waits for a person, and keeps it in the URL', async () => {
    renderBoard();
    await screen.findByText('Unload the morning truck');
    expect(screen.queryByRole('radio', { name: 'Waiting for a person' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Waiting for a person/ }));
    expect(await screen.findByText('Scan aisle 7 shelves')).toBeInTheDocument();
    expect(screen.getByText('No certified worker is free in the window (6 weighed)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Waiting for a person/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reads site, day and state from the URL (F500 G2)', async () => {
    renderBoard('/tasks?site=loc-1&day=2026-10-15&status=queued');
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ locationId: 'loc-1', day: '2026-10-15' })));
    expect(await screen.findByText('Scan aisle 7 shelves')).toBeInTheDocument();
    expect(screen.queryByText('Unload the morning truck')).not.toBeInTheDocument();
  });

  it('opens the task from the URL and reads the assignment’s reasons', async () => {
    renderBoard('/tasks?task=t-1');
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Certified for unloading')).toBeInTheDocument();
    expect(within(drawer).getByText('High-risk work: a person may hold it')).toBeInTheDocument();
    expect(within(drawer).getByText(/Assigned automatically/)).toBeInTheDocument();
    // A person holds it, so there is nothing to hand off.
    expect(within(drawer).queryByRole('button', { name: /Hand to a person/ })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /Done/ })).toBeInTheDocument();
  });
});
