import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkTaskDetailView, WorkTaskSummary, WorkTaskView } from '@alto-people/shared';

const authState = vi.hoisted(() => ({
  auth: { user: { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' } as Record<string, unknown>, can: () => true },
}));
vi.mock('@/lib/auth', async () => {
  const React = await import('react');
  return {
    AuthContext: React.createContext(authState.auth),
    useAuth: () => authState.auth,
    useTerm: () => (k: string) => (k === 'site' ? 'Site' : k),
    useTenant: () => ({ modules: {}, terminology: {} }),
  };
});
vi.mock('@/lib/useOrgSites', () => ({ useOrgSites: (enabled: boolean) => (enabled ? [{ id: 'loc-1', name: 'Front Beach 218' }] : null) }));
vi.mock('@/lib/clientsApi', () => ({ listClientLocations: vi.fn() }));
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
import { listClientLocations } from '@/lib/clientsApi';
import { TasksBoard, zonedDayBounds } from '@/pages/tasks/TasksBoard';

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
  authState.auth.user = { id: 'u1', role: 'HR_ADMINISTRATOR', email: 'hr@altohr.com' };
  vi.mocked(listTasks).mockReset();
  vi.mocked(getTaskDay).mockReset();
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

  it('the Inbox link (?needs=1) lists every open task waiting for a person on any day — the Inbox’s own count (FLOOR-8)', async () => {
    const oldQueued: WorkTaskView = { ...queued, id: 't-3', type: 'Unload the afternoon produce truck', windowStart: '2026-10-25T19:00:00.000Z', windowEnd: '2026-10-25T21:00:00.000Z' };
    const stalled: WorkTaskView = { ...assigned, id: 't-4', type: 'Mop the dairy aisle', status: 'STALLED' };
    vi.mocked(listTasks).mockImplementation(async (f) => ({
      tasks: f.status === 'QUEUED' ? [oldQueued] : f.status === 'STALLED' ? [stalled] : [],
    }));
    renderBoard('/tasks?needs=1');
    // Three days back still lists: no day bound, one call per state the Inbox counts.
    expect(await screen.findByText('Unload the afternoon produce truck')).toBeInTheDocument();
    expect(screen.getByText('Mop the dairy aisle')).toBeInTheDocument();
    const calls = vi.mocked(listTasks).mock.calls.map(([f]) => f);
    expect(calls.map((f) => f.status).sort()).toEqual(['FAILED', 'QUEUED', 'STALLED']);
    expect(calls.every((f) => !f.day && !f.from && !f.to)).toBe(true);
    expect(screen.getByRole('button', { name: /Waiting for a person/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: /Exceptions/ })).toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: /^Live/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Day')).not.toBeInTheDocument();
    // One tap back to the day's board.
    await userEvent.click(screen.getByRole('button', { name: /Back to the day’s board/ }));
    expect(await screen.findByLabelText('Day')).toBeInTheDocument();
  });

  it('a client-bound supervisor reads each task on its own store’s clock and the stores’ day, not the company’s (FLOOR-19)', async () => {
    authState.auth.user = { id: 'u2', role: 'SHIFT_SUPERVISOR', email: 'dana@altohr.com', clientId: 'c-1', clientName: 'Coastal' };
    vi.mocked(listClientLocations).mockResolvedValue({
      locations: [
        { id: 'loc-1', clientId: 'c-1', name: 'Front Beach 218', timezone: 'America/Chicago', isActive: true },
        { id: 'loc-2', clientId: 'c-1', name: 'Thomas Drive', timezone: 'America/Chicago', isActive: true },
      ],
    } as never);
    vi.mocked(getTaskDay).mockImplementation(async (loc) =>
      loc ? { day: '2026-10-27', timezone: 'America/Chicago' } : { day: '2026-10-28', timezone: 'America/New_York' },
    );
    // 04:00Z Oct 28 is 11 PM Oct 27 in Chicago (it read "12:00 AM EDT, Oct 28").
    const late: WorkTaskView = { ...assigned, windowStart: '2026-10-28T04:00:00.000Z', windowEnd: '2026-10-28T04:59:00.000Z' };
    vi.mocked(listTasks).mockResolvedValue({ tasks: [late] });
    renderBoard();
    expect(await screen.findByText(/^11:00\sPM – 11:59\sPM/)).toBeInTheDocument();
    // The day is the stores' (asked of one of them), bounded on Chicago's midnights.
    expect(getTaskDay).toHaveBeenCalledWith('loc-1');
    await waitFor(() =>
      expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-27T05:00:00.000Z', to: '2026-10-28T05:00:00.000Z' })),
    );
    expect(screen.getByLabelText('Day')).toHaveValue('2026-10-27');
  });
});

describe('zonedDayBounds', () => {
  it('is midnight to midnight on the zone’s clock, across a DST change', () => {
    expect(zonedDayBounds('2026-10-28', 'America/Chicago')).toEqual({ from: '2026-10-28T05:00:00.000Z', to: '2026-10-29T05:00:00.000Z' });
    // Fall back (Nov 1, 2026): a 25-hour day.
    expect(zonedDayBounds('2026-11-01', 'America/Chicago')).toEqual({ from: '2026-11-01T05:00:00.000Z', to: '2026-11-02T06:00:00.000Z' });
  });
});
