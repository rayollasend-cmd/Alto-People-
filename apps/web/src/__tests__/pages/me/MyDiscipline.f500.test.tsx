import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  listMyDisciplinaryActions: vi.fn(),
  acknowledgeDisciplinaryAction: vi.fn(),
  respondToDisciplinaryAction: vi.fn(async () => ({ ok: true, employeeRespondedAt: '2026-10-22T15:00:00.000Z' })),
}));
vi.mock('@/lib/discipline118Api', async (orig) => ({ ...(await orig<typeof import('@/lib/discipline118Api')>()), ...api }));
import { MyDiscipline } from '@/pages/me/MyDiscipline';

/**
 * Notices on file (F500 G5): titled so it isn't a second "My record(s)";
 * the not-agreeing sentence sits by the signature; the employee can write
 * their side; a dead deep link says so; the empty state is plain.
 */

const action = {
  id: '00000000-0000-4000-8000-000000000a01',
  associateName: 'Maria Lopez',
  kind: 'WRITTEN_WARNING',
  status: 'ACTIVE',
  incidentDate: '2026-10-01',
  effectiveDate: '2026-10-02',
  suspensionDays: null,
  description: 'Late three times in a week.',
  expectedAction: null,
  issuedByEmail: null,
  acknowledgedAt: null,
  acknowledgedSig: null,
  rescindedAt: null,
  rescindedReason: null,
  employeeResponse: null,
  employeeRespondedAt: null,
};

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/me/discipline" element={<MyDiscipline />} />
          <Route path="/me/discipline/:actionId" element={<MyDiscipline />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.respondToDisciplinaryAction.mockClear();
});

describe('notices on file', () => {
  it('is titled "Notices on file", says acknowledging is not agreeing by the signature, and takes the employee’s side', async () => {
    api.listMyDisciplinaryActions.mockResolvedValue({ actions: [action] });
    const user = userEvent.setup();
    renderAt('/me/discipline');
    expect(await screen.findByRole('heading', { level: 1, name: 'Notices on file' })).toBeInTheDocument();
    expect(await screen.findByTestId('record-not-agree')).toHaveTextContent('it does not mean you agree with it');
    await user.click(screen.getByRole('button', { name: 'Add your response' }));
    await user.type(screen.getByLabelText(/Your side/), 'The bus schedule changed that week.');
    expect(screen.getByText('1965 characters left')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save response' }));
    await waitFor(() => expect(api.respondToDisciplinaryAction).toHaveBeenCalledWith(action.id, 'The bus schedule changed that week.'));
  });

  it('shows a saved response with a way to edit it, and none on a rescinded notice', async () => {
    api.listMyDisciplinaryActions.mockResolvedValue({
      actions: [
        { ...action, status: 'ACKNOWLEDGED', acknowledgedAt: '2026-10-03T12:00:00.000Z', acknowledgedSig: 'Maria Lopez', employeeResponse: 'My side.', employeeRespondedAt: '2026-10-03T12:05:00.000Z' },
        { ...action, id: '00000000-0000-4000-8000-000000000a02', status: 'RESCINDED', rescindedAt: '2026-10-04T12:00:00.000Z', rescindedReason: 'Error' },
      ],
    });
    renderAt('/me/discipline');
    const responses = await screen.findAllByTestId('record-response');
    expect(responses).toHaveLength(1);
    expect(within(responses[0]!).getByText('My side.')).toBeInTheDocument();
    expect(within(responses[0]!).getByRole('button', { name: 'Edit your response' })).toBeInTheDocument();
  });

  it('a deep link to a notice no longer on the record says so; nothing on file is said plainly', async () => {
    api.listMyDisciplinaryActions.mockResolvedValue({ actions: [] });
    renderAt('/me/discipline/00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByTestId('record-missing')).toHaveTextContent('That notice isn’t on your record any more.');
    expect(screen.getByText('You have no disciplinary notices.')).toBeInTheDocument();
    expect(screen.queryByText(/Keep it that way/)).not.toBeInTheDocument();
  });
});
