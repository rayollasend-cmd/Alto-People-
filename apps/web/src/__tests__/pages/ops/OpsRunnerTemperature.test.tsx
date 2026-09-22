import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/opsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/opsApi')>()),
  getOpsShift: vi.fn(),
  patchOpsTask: vi.fn(),
}));

import { getOpsShift, patchOpsTask, type OpsShiftDetail, type OpsTaskRow } from '@/lib/opsApi';
import { OpsRunner } from '@/pages/ops/OpsRunner';

/** A freezer check as the Walmart SOP seeds it: the band is below zero. */
const freezerTask = (): OpsTaskRow =>
  ({
    id: 't1', source: 'SOP', section: 'Food safety', order: 1,
    title: 'Freezer case temperature', instructions: null, priority: 'MEDIUM', status: 'OPEN',
    responseType: 'TEMPERATURE', required: true, photoRequired: false,
    tempLabel: 'Freezer °F', tempMin: -30, tempMax: 0,
    metricKey: null, unit: null, parentTaskId: null, answerChoice: null, answerNumber: null,
    answerText: null, tempOutOfRange: false, note: null, blockedReason: null, completedAt: null,
    doneAssociate: null, photos: [],
  }) as OpsTaskRow;

function detail(tasks: OpsTaskRow[]): OpsShiftDetail {
  return {
    shift: {
      id: 'sop1', clientId: 'c1', clientName: 'Coastal', department: 'Frozen & Dairy',
      period: 'MORNING', position: 'Morning shift', dateKey: '2026-09-18', status: 'ACTIVE',
      openedAt: new Date().toISOString(), closedAt: null, scheduledHeadcount: 4,
      actualHeadcount: 4, templateName: 'Frozen & Dairy — Morning', sopTotal: tasks.length,
      sopDone: 0, taskTotal: tasks.length, taskDone: 0, closedIncomplete: false, tempAlerts: 0,
      closingSummary: null, windowLabel: 'Morning', locationName: 'Front Beach 218',
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    tasks,
    handoverOut: [],
    handoverIn: [],
    clockedIn: [],
  } as OpsShiftDetail;
}

function renderRunner() {
  vi.mocked(getOpsShift).mockResolvedValue(detail([freezerTask()]));
  vi.mocked(patchOpsTask).mockResolvedValue({ task: freezerTask(), followUp: null });
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

const field = () =>
  screen.getByRole('textbox', { name: 'Freezer case temperature — temperature' });

describe('<OpsRunner> — a freezer reading is below zero', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('records -30 typed straight in', async () => {
    const user = renderRunner();
    await user.type(await screen.findByRole('textbox', { name: /temperature$/ }), '-30');
    await user.click(screen.getByRole('button', { name: /^Record$/ }));
    await waitFor(() =>
      expect(patchOpsTask).toHaveBeenCalledWith('t1', { answerNumber: -30, status: 'DONE' }),
    );
  });

  it('the tablet keypad has no minus key — ± supplies the sign', async () => {
    const user = renderRunner();
    await user.type(await screen.findByRole('textbox', { name: /temperature$/ }), '30');
    const sign = screen.getByRole('button', { name: /below zero \(minus\)/ });
    expect(sign).toHaveAttribute('aria-pressed', 'false');
    await user.click(sign);
    expect(field()).toHaveValue('-30');
    expect(sign).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /^Record$/ }));
    await waitFor(() =>
      expect(patchOpsTask).toHaveBeenCalledWith('t1', { answerNumber: -30, status: 'DONE' }),
    );
    // And it flips back — a cooler reading typed into the same field.
    await user.click(sign);
    expect(field()).toHaveValue('30');
  });

  it('a Unicode minus — pasted from a log, or an iOS keyboard — still parses', async () => {
    const user = renderRunner();
    // U+2212, the real minus sign — not the hyphen Number() understands.
    await user.type(await screen.findByRole('textbox', { name: /temperature$/ }), '\u221230');
    await user.click(screen.getByRole('button', { name: /^Record$/ }));
    await waitFor(() =>
      expect(patchOpsTask).toHaveBeenCalledWith('t1', { answerNumber: -30, status: 'DONE' }),
    );
  });

  it('a lone minus is not a reading — nothing is sent', async () => {
    const user = renderRunner();
    await user.click(await screen.findByRole('button', { name: /below zero \(minus\)/ }));
    await user.click(screen.getByRole('button', { name: /^Record$/ }));
    expect(patchOpsTask).not.toHaveBeenCalled();
  });
});
