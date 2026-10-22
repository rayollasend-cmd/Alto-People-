import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BackgroundCheck } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * 2026-10-21 system audit, Tier 1 #3 and #14 on the screen: a background
 * check that never ran says so (it used to read "Passed"); the FCRA
 * adverse-action worklist leads the Background tab; and the voluntary EEO
 * form sends exactly what the person chose — or nothing, when declined.
 */

vi.mock('@/lib/complianceApi', () => ({
  listBackgroundChecks: vi.fn(),
  getBackgroundCheckDetail: vi.fn(),
  listPendingBackgroundChecks: vi.fn(),
  bulkInitiateBackgroundChecks: vi.fn(),
  initiateBackgroundCheck: vi.fn(),
  updateBackgroundCheck: vi.fn(),
  listAdverseActions: vi.fn(),
  sendPreAdverse: vi.fn(),
  sendFinalAdverse: vi.fn(),
  withdrawAdverse: vi.fn(),
}));
vi.mock('@/pages/compliance/providers/BackgroundProviderPanel', () => ({ BackgroundProviderPanel: () => null }));

import { listAdverseActions, listBackgroundChecks } from '@/lib/complianceApi';
import { BackgroundTab } from '@/pages/compliance/BackgroundTab';
import { EeoSelfIdCard } from '@/pages/onboarding/EeoSelfIdCard';

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function check(over: Partial<BackgroundCheck>): BackgroundCheck {
  return {
    id: ID(1),
    associateId: ID(2),
    associateName: 'Pat Hopeful',
    clientId: null,
    provider: 'none',
    externalId: null,
    status: 'NOT_RUN',
    initiatedAt: '2026-10-20T12:00:00.000Z',
    completedAt: null,
    reportCount: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(listBackgroundChecks).mockReset();
  vi.mocked(listAdverseActions).mockReset();
});

describe('Background tab', () => {
  it('shows a check that never ran as “Not run — no provider”, and leads with the adverse-action worklist', async () => {
    vi.mocked(listBackgroundChecks).mockResolvedValue({
      checks: [check({}), check({ id: ID(3), associateId: ID(4), associateName: 'Lee Screened', provider: 'Sterling', status: 'NEEDS_REVIEW', adjudication: 'PRE_ADVERSE', adverseWaitUntil: '2026-10-19T00:00:00.000Z' })],
    });
    vi.mocked(listAdverseActions).mockResolvedValue({
      rows: [
        { checkId: ID(3), associateId: ID(4), associateName: 'Lee Screened', stage: 'FINAL_DUE', waitUntil: '2026-10-19T00:00:00.000Z', preAdverseSentAt: '2026-10-12T00:00:00.000Z', adverseSentAt: null, result: null, status: 'NEEDS_REVIEW', viaProvider: false },
      ],
    });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, '/compliance?tab=background');

    expect(await screen.findByText('Adverse actions')).toBeInTheDocument();
    expect(screen.getByText('Final notice due')).toBeInTheDocument();
    expect((await screen.findAllByText('Not run — no provider')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Passed', { selector: 'span' })).toBeNull();
  });

  it('hides the worklist when nothing is in the adverse-action flow', async () => {
    vi.mocked(listBackgroundChecks).mockResolvedValue({ checks: [check({ status: 'PASSED', provider: 'Sterling' })] });
    vi.mocked(listAdverseActions).mockResolvedValue({ rows: [] });
    renderAs('HR_ADMINISTRATOR', <BackgroundTab canManage />, '/compliance?tab=background');
    await waitFor(() => expect(listAdverseActions).toHaveBeenCalled());
    expect(screen.queryByText('Adverse actions')).toBeNull();
  });
});

describe('the voluntary EEO card', () => {
  it('sends the answers chosen, blanks as null', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(<EeoSelfIdCard answered={false} onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'FEMALE');
    await userEvent.selectOptions(screen.getByLabelText('Veteran status'), 'DECLINE');
    await userEvent.click(screen.getByRole('button', { name: 'Save my answers' }));
    expect(onSubmit).toHaveBeenCalledWith({ gender: 'FEMALE', ethnicity: null, veteranStatus: 'DECLINE', disabilityStatus: null });
    expect(await screen.findByText(/Your answers are saved/)).toBeInTheDocument();
  });

  it('declining the form sends nothing but the decline', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(<EeoSelfIdCard answered={false} onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'MALE');
    await userEvent.click(screen.getByRole('button', { name: "I'd rather not answer" }));
    expect(onSubmit).toHaveBeenCalledWith({ declined: true });
  });

  it('an answered form just says thank you', () => {
    render(<EeoSelfIdCard answered onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Save my answers' })).toBeNull();
    expect(screen.getByText(/Your answers are saved/)).toBeInTheDocument();
  });
});
