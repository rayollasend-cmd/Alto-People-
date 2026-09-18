import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/opsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/opsApi')>()),
  getOpsOpenOptions: vi.fn(),
  openOpsShift: vi.fn(),
}));

import { getOpsOpenOptions, openOpsShift } from '@/lib/opsApi';
import { OpsRunner } from '@/pages/ops/OpsRunner';

function renderPicker() {
  vi.mocked(getOpsOpenOptions).mockResolvedValue({
    clientId: 'c1',
    dateKey: '2026-09-17',
    resumeShift: null,
    positions: [
      { position: 'F&D Morning Shift', scheduledCount: 6, department: 'F&D', period: 'MORNING' },
      { position: 'Pool Attendant', scheduledCount: 2, department: null, period: 'EVENING' },
    ],
    departments: ['F&D', 'Grocery'],
  });
  vi.mocked(openOpsShift).mockResolvedValue({ shiftId: 's1' } as never);
  return render(
    <MemoryRouter>
      <OpsRunner />
    </MemoryRouter>,
  );
}

describe('<OpsRunner> — starting a shift', () => {
  it('frames the day the way the floor says it', async () => {
    renderPicker();
    expect(await screen.findByText(/Your floor · Thursday, Sep 17/)).toBeInTheDocument();
  });

  it('asks for a department only when an unlinked position is opened', async () => {
    const user = userEvent.setup();
    renderPicker();
    await screen.findByText('Pool Attendant');
    // No picker in the grid until someone opens that position.
    expect(screen.queryByLabelText('Department for Pool Attendant')).not.toBeInTheDocument();
    expect(screen.getByText('No SOP department yet')).toBeInTheDocument();

    const opens = screen.getAllByRole('button', { name: /open shift/i });
    await user.click(opens[1]!);
    const picker = screen.getByLabelText('Department for Pool Attendant');
    const confirm = screen.getByRole('button', { name: /open with this department/i });
    expect(confirm).toBeDisabled();
    await user.selectOptions(picker, 'Grocery');
    await user.click(confirm);
    await waitFor(() =>
      expect(openOpsShift).toHaveBeenCalledWith({ position: 'Pool Attendant', department: 'Grocery' }),
    );
  });

  it('opens a linked position in one tap', async () => {
    const user = userEvent.setup();
    renderPicker();
    await screen.findByText('F&D Morning Shift');
    await user.click(screen.getAllByRole('button', { name: /open shift/i })[0]!);
    await waitFor(() => expect(openOpsShift).toHaveBeenCalledWith({ position: 'F&D Morning Shift' }));
  });
});
