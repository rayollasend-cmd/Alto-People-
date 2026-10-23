import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/hrCases123Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/hrCases123Api')>()),
  getCaseSummary: vi.fn(),
  listCaseQueue: vi.fn(),
  listMyCases: vi.fn(),
  listCaseStaff: vi.fn().mockResolvedValue({ staff: [] }),
}));

import { getCaseSummary, listCaseQueue, listMyCases } from '@/lib/hrCases123Api';
import { HrCasesHome } from '@/pages/hrCases/HrCasesHome';

/**
 * The HR case desk (F500 2026-10-22): counts first (Open · Past SLA ·
 * Unassigned · Median first reply), the filters in one row and in the URL,
 * SLA targets in More, and one "New case" for an associate.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCaseSummary).mockResolvedValue({
    openTotal: 7,
    unassigned: 3,
    byStatus: {},
    byPriority: {},
    byCategory: {},
    sla: { breached: 2, atRisk: 1 },
    firstReply: { medianHours: 4, replied: 9, filed: 12, days: 90 },
  });
  vi.mocked(listCaseQueue).mockResolvedValue({ cases: [], total: 0, hasMore: false });
  vi.mocked(listMyCases).mockResolvedValue({ cases: [] });
});

describe('HR cases desk', () => {
  it('leads with the desk’s counts, and the tiles are the filters', async () => {
    renderAs('HR_ADMINISTRATOR', <><HrCasesHome /><Where /></>, '/hr-cases');
    const strip = await screen.findByRole('group', { name: 'The case desk' });
    expect(within(strip).getByText('4 h')).toBeInTheDocument();
    expect(within(strip).getByText('Cases filed in the last 90 days · 9 of 12 answered')).toBeInTheDocument();
    expect(within(strip).getByText('1 more due within 4 hours')).toBeInTheDocument();
    // The default view is every open case.
    await waitFor(() => expect(listCaseQueue).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' }), 0));
    await userEvent.click(within(strip).getByRole('button', { name: /Past SLA/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('sla=breached');
    await waitFor(() => expect(listCaseQueue).toHaveBeenCalledWith(expect.objectContaining({ sla: 'breached' }), 0));
    await userEvent.click(within(strip).getByRole('button', { name: /Unassigned/ }));
    await waitFor(() => expect(listCaseQueue).toHaveBeenCalledWith(expect.objectContaining({ unassigned: true }), 0));
    // An empty result says so plainly — not "Nothing pending. Nice."
    expect(screen.queryByText(/Nice\./)).not.toBeInTheDocument();
  });

  it('keeps SLA targets out of the filter row (in More), with one primary New case', async () => {
    renderAs('HR_ADMINISTRATOR', <HrCasesHome />, '/hr-cases');
    await screen.findByRole('group', { name: 'The case desk' });
    expect(screen.queryByRole('button', { name: 'SLA targets' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New case/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('No open cases')).toBeInTheDocument();
  });

  it('lands the Inbox’s past-SLA link on the queue, filtered, even for staff with their own record', async () => {
    renderAs('HR_ADMINISTRATOR', <HrCasesHome />, '/hr-cases?sla=breached', { associateId: 'me' });
    await waitFor(() => expect(listCaseQueue).toHaveBeenCalledWith(expect.objectContaining({ sla: 'breached' }), 0));
    expect(listMyCases).not.toHaveBeenCalled();
  });

  it('gives an associate one view and one New case — no one-option switch', async () => {
    renderAs('ASSOCIATE', <HrCasesHome />, '/hr-cases', { associateId: 'a1' });
    expect(await screen.findByText('No cases yet')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Case view' })).not.toBeInTheDocument();
    expect(screen.queryByText('File a case')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New case/ }).length).toBeGreaterThan(0);
    expect(getCaseSummary).not.toHaveBeenCalled();
  });

  it('opens the New case form from ?new=1 — for an associate, their own', async () => {
    renderAs('ASSOCIATE', <><HrCasesHome /><Where /></>, '/hr-cases?new=1', { associateId: 'a1' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Consumed once: Back or a reload doesn't reopen it.
    await waitFor(() => expect(screen.getByTestId('where')).not.toHaveTextContent('new=1'));
  });

  it('opens the for-someone form from ?new=1 for desk staff with no record of their own', async () => {
    renderAs('HR_ADMINISTRATOR', <HrCasesHome />, '/hr-cases?new=1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Open a case for someone')).toBeInTheDocument();
  });
});
