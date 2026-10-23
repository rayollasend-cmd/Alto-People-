import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/discipline118Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/discipline118Api')>()),
  listDisciplinaryActions: vi.fn(),
  getDisciplineSummary: vi.fn(),
}));
vi.mock('@/lib/agreements122Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/agreements122Api')>()),
  listAgreements: vi.fn(),
  listMyAgreements: vi.fn(),
  getAgreementsSummary: vi.fn(),
}));

import { getDisciplineSummary, listDisciplinaryActions } from '@/lib/discipline118Api';
import { getAgreementsSummary, listAgreements, listMyAgreements } from '@/lib/agreements122Api';
import { DisciplineHome } from '@/pages/discipline/DisciplineHome';
import { AgreementsHome } from '@/pages/agreements/AgreementsHome';

/**
 * Discipline and Agreements (F500 2026-10-22) open on their numbers, and
 * each tile is the filter for the rows behind it, kept in the URL.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.search}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDisciplinaryActions).mockResolvedValue({ actions: [] });
  vi.mocked(getDisciplineSummary).mockResolvedValue({ inForce: 4, awaitingAck: 2, finalWarningPeople: 1, issued90d: 3 });
  vi.mocked(listAgreements).mockResolvedValue({ agreements: [] });
  vi.mocked(listMyAgreements).mockResolvedValue({ agreements: [] });
  vi.mocked(getAgreementsSummary).mockResolvedValue({ awaitingSignature: 5, signed30d: 2, expiring30d: 1 });
});

describe('Disciplinary actions', () => {
  it('shows the four numbers; Final warnings filters to final warnings in force', async () => {
    renderAs('HR_ADMINISTRATOR', <><DisciplineHome /><Where /></>, '/discipline');
    const strip = await screen.findByRole('group', { name: 'Disciplinary actions at a glance' });
    expect(within(strip).getByText('Person one step from termination')).toBeInTheDocument();
    // The default view is everything in force.
    await waitFor(() => expect(listDisciplinaryActions).toHaveBeenCalledWith({ status: undefined, state: 'in-force', kind: undefined }));
    await userEvent.click(within(strip).getByRole('button', { name: /Final warnings/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('kind=FINAL_WARNING');
    await waitFor(() => expect(listDisciplinaryActions).toHaveBeenCalledWith({ status: undefined, state: 'in-force', kind: 'FINAL_WARNING' }));
    await userEvent.click(within(strip).getByRole('button', { name: /Awaiting acknowledgment/ }));
    await waitFor(() => expect(listDisciplinaryActions).toHaveBeenCalledWith({ status: 'ACTIVE', state: undefined, kind: undefined }));
  });

  it('names the API’s ACTIVE status for what it is', async () => {
    vi.mocked(listDisciplinaryActions).mockResolvedValue({
      actions: [
        { id: 'd1', associateId: 'a1', associateName: 'Ana Reyes', associateEmail: 'ana@example.com', kind: 'WRITTEN_WARNING', status: 'ACTIVE', incidentDate: '2026-10-01', effectiveDate: '2026-10-02', suspensionDays: null, description: 'x', expectedAction: null, issuedByEmail: null, acknowledgedAt: null, acknowledgedSig: null, rescindedAt: null, rescindedReason: null, rescindedByEmail: null },
      ],
    } as never);
    renderAs('HR_ADMINISTRATOR', <DisciplineHome />, '/discipline');
    expect(await screen.findByText('Ana Reyes')).toBeInTheDocument();
    expect(screen.getAllByText('Awaiting acknowledgment').length).toBeGreaterThan(1);
  });
});

describe('Agreements', () => {
  it('opens HR on every agreement with the three numbers; a tile is the filter', async () => {
    renderAs('HR_ADMINISTRATOR', <><AgreementsHome /><Where /></>, '/agreements');
    const strip = await screen.findByRole('group', { name: 'Agreements at a glance' });
    await waitFor(() => expect(listAgreements).toHaveBeenCalledWith({ status: undefined }));
    expect(listMyAgreements).not.toHaveBeenCalled();
    await userEvent.click(within(strip).getByRole('button', { name: /Expiring in 30 days/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('status=EXPIRING30');
    await waitFor(() => expect(listAgreements).toHaveBeenCalledWith({ window: 'expiring30' }));
    // The primary action is in the header, on every tab.
    expect(screen.getAllByRole('button', { name: /Issue agreement/ }).length).toBeGreaterThan(0);
  });

  it('tells an associate what the page is for them, and opens on theirs', async () => {
    renderAs('ASSOCIATE', <AgreementsHome />, '/agreements', { associateId: 'a1' });
    expect(await screen.findByText("Agreements you've been asked to sign.")).toBeInTheDocument();
    expect(screen.queryByText(/equity grants/)).not.toBeInTheDocument();
    await waitFor(() => expect(listMyAgreements).toHaveBeenCalled());
    expect(getAgreementsSummary).not.toHaveBeenCalled();
  });
});
