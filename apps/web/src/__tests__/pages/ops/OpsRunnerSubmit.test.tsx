import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/opsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/opsApi')>()),
  getOpsShift: vi.fn(),
  closeOpsShift: vi.fn(),
  addOpsHandover: vi.fn(),
  decideOpsHandover: vi.fn(),
}));

import { addOpsHandover, closeOpsShift, decideOpsHandover, getOpsShift, type OpsShiftDetail, type OpsTaskRow } from '@/lib/opsApi';
import { OpsRunner } from '@/pages/ops/OpsRunner';

const task = (id: string, title: string, status: OpsTaskRow['status']): OpsTaskRow => ({
  id, source: 'SOP', section: 'Open', order: 1, title, instructions: null, priority: 'MEDIUM', status,
  responseType: 'CHECK', required: true, photoRequired: false, tempLabel: null, tempMin: null, tempMax: null,
  metricKey: null, unit: null, parentTaskId: null, answerChoice: null, answerNumber: null, answerText: null,
  tempOutOfRange: false, note: null, blockedReason: null, completedAt: null, doneAssociate: null, photos: [],
} as OpsTaskRow);

const note = (id: string, body: string) => ({
  id, kind: 'NOTE' as const, body, priority: 'MEDIUM' as const, status: 'PENDING' as const,
  createdAt: new Date().toISOString(), decidedAt: null, decidedByEmail: null,
  from: { shiftId: 'prev', position: 'Overnight shift', period: 'OVERNIGHT' as const, dateKey: '2026-09-18' },
});

function detail(tasks: OpsTaskRow[], handoverIn: ReturnType<typeof note>[] = []): OpsShiftDetail {
  return {
    shift: {
      id: 'sop1', clientId: 'c1', clientName: 'Coastal', department: 'F&D', period: 'EVENING',
      position: 'Swing shift', dateKey: '2026-09-18', status: 'ACTIVE', openedAt: new Date().toISOString(),
      closedAt: null, scheduledHeadcount: 6, actualHeadcount: 5, templateName: 'Swing Standard',
      sopTotal: tasks.length, sopDone: tasks.filter((t) => t.status === 'DONE').length, taskTotal: tasks.length,
      taskDone: tasks.filter((t) => t.status === 'DONE').length, closedIncomplete: false, tempAlerts: 0,
      closingSummary: null, windowLabel: 'Swing', locationName: 'Front Beach 218',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    tasks,
    handoverOut: [],
    handoverIn,
    clockedIn: [],
  } as OpsShiftDetail;
}

function renderRunner(d: OpsShiftDetail) {
  vi.mocked(getOpsShift).mockResolvedValue(d);
  vi.mocked(closeOpsShift).mockResolvedValue({ shift: d.shift });
  vi.mocked(addOpsHandover).mockResolvedValue(undefined as never);
  const caps = ROLE_CAPABILITIES.SHIFT_SUPERVISOR;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@altohr.com', role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', clientId: 'c1', associateId: 'a' },
          role: 'SHIFT_SUPERVISOR',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter initialEntries={['/ops?tab=shift&shift=sop1']}>
          <OpsRunner />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe('<OpsRunner> — timed blocks', () => {
  it('each block says when it is due; a late one is overdue and the header counts it', async () => {
    const mins = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
    renderRunner(
      detail([
        { ...task('t1', 'Bins scanned and capped', 'DONE'), section: 'Backroom · 7:30–9:30', dueAt: mins(-15) },
        { ...task('t2', 'Priority picks worked', 'OPEN'), section: 'Backroom · 7:30–9:30', dueAt: mins(-15) },
        { ...task('t3', 'Milk and eggs full', 'OPEN'), section: 'Sales floor · 9:30–11:00', dueAt: mins(90) },
        { ...task('t4', 'Final zone', 'OPEN'), section: 'End of shift', dueAt: mins(300) },
      ]),
    );
    expect(await screen.findByText(/Overdue — was due/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 overdue/ })).toBeInTheDocument();
    // The late block is the one to work now; the blocks after it just say when.
    expect(screen.getAllByText(/^Due by \d{1,2}:\d{2}\s?[AP]M$/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Backroom · 7:30–9:30/, current: 'step' })).toBeInTheDocument();
  });
});

describe('<OpsRunner> — submitting the shift SOP', () => {
  it('says when it is due and that it gates the clock-out', async () => {
    renderRunner(detail([task('t1', 'Walk the floor', 'DONE')]));
    expect(await screen.findByText(/Due by .* · submit it before you clock out/)).toBeInTheDocument();
  });

  it('every submit hands over — a note, or "nothing to hand over" said out loud', async () => {
    const user = renderRunner(detail([task('t1', 'Walk the floor', 'DONE')]));
    await user.click((await screen.findAllByRole('button', { name: /submit sop/i }))[0]!);
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Submit SOP' });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Nothing to hand over to the next shift'));
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(closeOpsShift).toHaveBeenCalledWith('sop1', { summary: undefined, handoverNone: true, incompleteReason: undefined }),
    );
  });

  it('with required items open it is "Submit incomplete" — and it needs the reason', async () => {
    const user = renderRunner(detail([task('t1', 'Walk the floor', 'DONE'), task('t2', 'Check the coolers', 'OPEN')]));
    await user.click((await screen.findAllByRole('button', { name: /submit sop/i }))[0]!);
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Submit incomplete' });
    // The unfinished item is handed over by default — that's the handover;
    // what's missing is the reason.
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Why can't it be finished?"), 'Cooler 2 down — maintenance called.');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() =>
      expect(closeOpsShift).toHaveBeenCalledWith('sop1', {
        summary: undefined,
        handoverNone: false,
        incompleteReason: 'Cooler 2 down — maintenance called.',
      }),
    );
    expect(addOpsHandover).toHaveBeenCalledWith('sop1', [
      expect.objectContaining({ kind: 'UNFINISHED_TASK', body: 'Check the coolers' }),
    ]);
  });

  it('is named for the store and shift being run', async () => {
    renderRunner(detail([task('t1', 'Walk the floor', 'DONE')]));
    expect(await screen.findByText('Front Beach 218')).toBeInTheDocument();
    expect(screen.getByText(/· Swing shift/)).toBeInTheDocument();
    expect(screen.getByText('Swing Standard')).toBeInTheDocument();
  });

  it("the previous shift's notes are read first — one tap each, or all at once — then it submits", async () => {
    vi.mocked(decideOpsHandover).mockResolvedValue({ ok: true } as never);
    const user = renderRunner(
      detail([task('t1', 'Walk the floor', 'DONE')], [note('n1', 'Freezer 3 seal torn.'), note('n2', 'Two pallets in staging.')]),
    );
    expect(await screen.findByText('Freezer 3 seal torn.')).toBeInTheDocument();
    await user.click((await screen.findAllByRole('button', { name: /submit sop/i }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 notes from the previous shift to read first')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Submit SOP' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Back to the notes' }));

    await user.click(screen.getByRole('button', { name: 'Got it on all 2' }));
    await waitFor(() => expect(decideOpsHandover).toHaveBeenCalledTimes(2));
    expect(decideOpsHandover).toHaveBeenCalledWith('n1', { action: 'REVIEW', shiftId: 'sop1' });
    expect(decideOpsHandover).toHaveBeenCalledWith('n2', { action: 'REVIEW', shiftId: 'sop1' });
  });
});

describe('<OpsRunner> — a floor supervisor helping on their shift supervisor\'s SOP', () => {
  it('checks items off, reads the notes in — and leaves the submit to whoever runs it', async () => {
    const d = detail([task('t1', 'Walk the floor', 'OPEN')], [note('n1', 'Freezer 3 seal torn.')]);
    renderRunner({
      ...d,
      access: 'help',
      shift: { ...d.shift, runBy: { id: 'u-dana', name: 'Dana Reyes' } },
    });
    expect(await screen.findByText(/Dana Reyes is running this SOP/)).toBeInTheDocument();
    expect(screen.getByText(/Due by .* · Dana submits it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit sop/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add task/ })).not.toBeInTheDocument();
    // The previous shift's note is there to read; acknowledging it isn't theirs.
    expect(screen.getByText('Freezer 3 seal torn.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
    expect(screen.getByText(/Dana acknowledges these/)).toBeInTheDocument();
  });

  it('covering for their shift supervisor: runs it, and the header says for whom', async () => {
    const d = detail([task('t1', 'Walk the floor', 'DONE')]);
    renderRunner({
      ...d,
      access: 'run',
      shift: {
        ...d.shift,
        runBy: { id: 'u-marcus', name: 'Marcus Hill' },
        coveringFor: { id: 'u-dana', name: 'Dana Reyes' },
      },
    });
    expect(await screen.findByText('Marcus Hill · covering for Dana Reyes')).toBeInTheDocument();
    expect((await screen.findAllByRole('button', { name: /submit sop/i })).length).toBeGreaterThan(0);
  });
});
