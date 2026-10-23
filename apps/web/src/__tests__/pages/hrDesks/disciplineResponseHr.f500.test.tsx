import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/discipline118Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/discipline118Api')>()),
  listDisciplinaryActions: vi.fn(),
  getDisciplineSummary: vi.fn(async () => ({ inForce: 1, awaitingAck: 0, finalWarningPeople: 0, issued90d: 1 })),
}));
import { listDisciplinaryActions } from '@/lib/discipline118Api';
import { DisciplineHome } from '@/pages/discipline/DisciplineHome';

/** HR reads the employee's own response on the action (F500 G5). */
describe('Discipline — the employee’s response', () => {
  it('is on the action’s detail, in their words', async () => {
    vi.mocked(listDisciplinaryActions).mockResolvedValue({
      actions: [
        { id: 'd1', associateId: 'a1', associateName: 'Ana Reyes', associateEmail: 'ana@example.com', kind: 'WRITTEN_WARNING', status: 'ACKNOWLEDGED', incidentDate: '2026-10-01', effectiveDate: '2026-10-02', suspensionDays: null, description: 'x', expectedAction: null, issuedByEmail: null, acknowledgedAt: '2026-10-03T12:00:00.000Z', acknowledgedSig: 'Ana Reyes', rescindedAt: null, rescindedReason: null, rescindedByEmail: null, employeeResponse: 'The bus schedule changed that week.', employeeRespondedAt: '2026-10-03T12:05:00.000Z' },
      ],
    } as never);
    renderAs('HR_ADMINISTRATOR', <DisciplineHome />, '/discipline');
    await userEvent.click((await screen.findAllByText('Ana Reyes'))[0]!);
    const block = await screen.findByTestId('discipline-employee-response');
    expect(within(block).getByText('The bus schedule changed that week.')).toBeInTheDocument();
  });
});
