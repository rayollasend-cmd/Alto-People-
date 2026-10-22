import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { CloseListResponse, ClosePeriodDetail, CloseTaskView } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  listCloseMonths: vi.fn(),
  getCloseMonth: vi.fn(),
  updateCloseTask: vi.fn(),
  markCloseReady: vi.fn(),
  unmarkCloseReady: vi.fn(),
  signOffClose: vi.fn(),
  requestCloseReopen: vi.fn(),
  listAccruals: vi.fn(),
  createAccrual: vi.fn(),
  listAccountOptions: vi.fn(),
  finalizeCloseStatements: vi.fn(),
  postCloseHistory: vi.fn(),
}));
vi.mock('@/lib/books/closeApi', () => api);

import { ClosePage } from '@/pages/books/close/ClosePage';
import { ClosePeriodPage } from '@/pages/books/close/ClosePeriodPage';

/**
 * The close pages: months as rows with where each stands, and one month's
 * checklist — automatic steps say what's left and link to it, hand steps
 * are ticked, the preparer marks it ready and a second person signs it.
 */

const task = (o: Partial<CloseTaskView>): CloseTaskView => ({
  key: 'budget_review',
  title: 'Review the month against budget',
  detail: 'Profit and loss read against the budget.',
  auto: false,
  status: 'OPEN',
  passing: null,
  summary: null,
  items: [],
  link: '/books/budgets',
  note: null,
  doneAt: null,
  doneByName: null,
  ...o,
});

const detail = (o: Partial<ClosePeriodDetail> = {}): ClosePeriodDetail => ({
  periodKey: '2026-09',
  label: 'September 2026',
  status: 'OPEN',
  tasksTotal: 2,
  tasksDone: 0,
  preparedByName: null,
  signedOffByName: null,
  closedAt: null,
  reopenedAt: null,
  ended: true,
  pendingReopen: false,
  tasks: [
    task({ key: 'bank_reconciled', title: 'Reconcile bank and card accounts', auto: true, passing: false, summary: '1 account not reconciled through month end.', items: [{ label: 'Reconcile Operating ••4410', link: '/books/bank/f1/reconcile' }], link: '/books/bank' }),
    task({}),
  ],
  preparedById: null,
  signedOffById: null,
  signedOffAt: null,
  reopenReason: null,
  liabilities: [{ accountId: 'a1', code: '2110', name: 'Federal income tax withheld', balance: 4120.5 }],
  can: { edit: true, ready: false, unready: false, signOff: false, reopen: false, why: '2 steps are still open.' },
  ...o,
});

const atMonth = (role: 'FINANCE_ACCOUNTANT' | 'EXECUTIVE_CHAIRMAN' = 'FINANCE_ACCOUNTANT') =>
  renderAs(
    role,
    <Routes>
      <Route path="/books/close/:periodKey" element={<ClosePeriodPage />} />
    </Routes>,
    '/books/close/2026-09',
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listAccruals.mockResolvedValue({ periodKey: '2026-09', accruals: [] });
  api.listAccountOptions.mockResolvedValue({ accounts: [] });
});

describe('ClosePage', () => {
  it('lists the months with their state and opens the next one to close', async () => {
    const list: CloseListResponse = {
      nextToClose: '2026-09',
      months: [
        { periodKey: '2026-10', label: 'October 2026', status: 'OPEN', tasksTotal: 10, tasksDone: 3, preparedByName: null, signedOffByName: null, closedAt: null, reopenedAt: null, ended: false, pendingReopen: false },
        { periodKey: '2026-09', label: 'September 2026', status: 'READY', tasksTotal: 10, tasksDone: 10, preparedByName: 'Fin Ance', signedOffByName: null, closedAt: null, reopenedAt: null, ended: true, pendingReopen: false },
        { periodKey: '2026-08', label: 'August 2026', status: 'CLOSED', tasksTotal: 10, tasksDone: 10, preparedByName: 'Fin Ance', signedOffByName: 'Owen Owner', closedAt: '2026-09-05T15:00:00.000Z', reopenedAt: null, ended: true, pendingReopen: false },
      ],
    };
    api.listCloseMonths.mockResolvedValue(list);
    renderAs('FINANCE_ACCOUNTANT', <ClosePage />, '/books/close');
    expect(await screen.findByText('August 2026')).toBeInTheDocument();
    expect(screen.getAllByText('Ready to sign off').length).toBeGreaterThan(0);
    expect(screen.getByText('Owen Owner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close September 2026/ })).toBeInTheDocument();
  });
});

describe('ClosePeriodPage', () => {
  it('shows what an automatic step found and where to fix it, and ticks a hand step with a note', async () => {
    const ticked = detail({ tasksDone: 1, tasks: [detail().tasks[0]!, task({ status: 'DONE', note: 'Within 2%', doneByName: 'Fin Ance' })] });
    // The page re-reads the month after a change: the second read is the ticked one.
    api.getCloseMonth.mockResolvedValueOnce(detail()).mockResolvedValue(ticked);
    api.updateCloseTask.mockResolvedValue(ticked);
    const user = userEvent.setup();
    atMonth();
    expect(await screen.findByRole('heading', { name: 'September 2026 close' })).toBeInTheDocument();
    expect(screen.getByText('1 account not reconciled through month end.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Reconcile Operating ••4410/ })).toHaveAttribute('href', '/books/bank/f1/reconcile');
    // Ready is held back, with why.
    expect(screen.getByRole('button', { name: /Ready to close/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Ready to close/ })).toHaveAttribute('title', '2 steps are still open.');

    // A note is optional and inline — no dialog in the way.
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Note for/ }), 'Within 2%');
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(api.updateCloseTask).toHaveBeenCalledWith('2026-09', 'budget_review', { status: 'DONE', note: 'Within 2%' }));
    expect(await screen.findByText('Within 2%')).toBeInTheDocument();
  });

  it('finalizes the month’s statements from the checklist itself, with no page change (finance walk 16)', async () => {
    const statements = task({ key: 'statements_final', title: 'Finalize the month’s statements', auto: true, passing: false, summary: '2 statements for the month still in draft.', items: [{ label: 'Harbor Grill — draft statement', link: '/clients/c1?tab=statements' }], link: '/clients/statements', action: { kind: 'finalize_statements', label: 'Finalize 2 statements' } });
    const after = detail({ tasksDone: 1, tasks: [task({ key: 'statements_final', title: 'Finalize the month’s statements', auto: true, status: 'DONE', passing: true, summary: 'Every statement for the month is final.', action: null }), task({})] });
    api.getCloseMonth.mockResolvedValueOnce(detail({ tasks: [statements, task({})] })).mockResolvedValue(after);
    api.finalizeCloseStatements.mockResolvedValue({ finalized: 2, failed: [], month: after });
    const user = userEvent.setup();
    atMonth();
    await user.click(await screen.findByRole('button', { name: 'Finalize 2 statements' }));
    await waitFor(() => expect(api.finalizeCloseStatements).toHaveBeenCalledWith('2026-09'));
    expect(await screen.findByText('Every statement for the month is final.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalize 2 statements' })).toBeNull();
  });

  it('the executive sees the step but not its button', async () => {
    api.getCloseMonth.mockResolvedValue(detail({ can: { edit: false, ready: false, unready: false, signOff: false, reopen: false, why: 'Only someone who keeps the books can work the close.' }, tasks: [task({ key: 'nothing_to_post', auto: true, passing: false, summary: '1 item not posted to the ledger yet.', action: { kind: 'post_history', label: 'Post history' } })] }));
    atMonth('EXECUTIVE_CHAIRMAN');
    expect(await screen.findByText('1 item not posted to the ledger yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post history' })).toBeNull();
  });

  it('marks a hand step done in one click', async () => {
    api.getCloseMonth.mockResolvedValue(detail());
    api.updateCloseTask.mockResolvedValue(detail());
    const user = userEvent.setup();
    atMonth();
    await user.click(await screen.findByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(api.updateCloseTask).toHaveBeenCalledWith('2026-09', 'budget_review', { status: 'DONE', note: null }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a second person signs off a month waiting for it; the executive only reads', async () => {
    const waiting = detail({
      status: 'READY',
      tasksDone: 2,
      preparedByName: 'Fin Ance',
      preparedById: 'someone-else',
      tasks: detail().tasks.map((t) => ({ ...t, status: 'DONE' as const, passing: t.auto ? true : null, items: [] })),
      can: { edit: false, ready: false, unready: true, signOff: true, reopen: false, why: null },
    });
    const closed: ClosePeriodDetail = { ...waiting, status: 'CLOSED', signedOffByName: 'Owen Owner', can: { ...waiting.can, signOff: false, unready: false, reopen: true } };
    api.getCloseMonth.mockResolvedValueOnce(waiting).mockResolvedValue(closed);
    api.signOffClose.mockResolvedValue(closed);
    const user = userEvent.setup();
    atMonth();
    expect(await screen.findByText(/Prepared by Fin Ance — waiting for a second person/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sign off and close/ }));
    await waitFor(() => expect(api.signOffClose).toHaveBeenCalledWith('2026-09'));
    expect(await screen.findByRole('button', { name: /Ask to reopen/ })).toBeInTheDocument();
  });

  it('the liabilities tab shows the balances to tie out', async () => {
    api.getCloseMonth.mockResolvedValue(detail({ can: { edit: false, ready: false, unready: false, signOff: false, reopen: false, why: 'Only someone who keeps the books can work the close.' } }));
    const user = userEvent.setup();
    atMonth('EXECUTIVE_CHAIRMAN');
    await screen.findByRole('heading', { name: 'September 2026 close' });
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Payroll liabilities/ }));
    expect(await screen.findByText('Federal income tax withheld')).toBeInTheDocument();
    expect(screen.getByText('$4,120.50')).toBeInTheDocument();
  });
});
