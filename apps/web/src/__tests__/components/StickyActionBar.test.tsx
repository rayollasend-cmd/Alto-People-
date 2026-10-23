import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplicationDetail } from '@alto-people/shared';
// A phone: the bar renders below sm (the test setup otherwise reads as desktop).
let wide = false;
vi.mock('@/lib/useViewport', async (orig) => ({
  ...(await orig<typeof import('@/lib/useViewport')>()),
  useMinWidth: () => wide,
}));

import { Button } from '@/components/ui/Button';
import { StickyActionBar } from '@/components/ui/StickyActionBar';
import { ApplicationDecisionBar } from '@/pages/onboarding/ApplicationDetail';

/**
 * On a phone the decision stays on screen (role walk HR 15): one bar at
 * the bottom of the page with the main decision, the decline beside it,
 * the rest behind More, and the reason a decision is blocked said in
 * words — the hover tooltip that used to carry it never shows on touch.
 */

describe('<StickyActionBar>', () => {
  it('is a phone-only toolbar holding the decision, the decline and the rest behind More', async () => {
    const resend = vi.fn();
    render(
      <StickyActionBar
        label="Decision"
        note="3 of 8 tasks done"
        primary={<Button>Approve</Button>}
        secondary={<Button variant="outline">Reject</Button>}
        more={[{ label: 'Resend invite', onSelect: resend }]}
      />,
    );
    const bar = screen.getByRole('toolbar', { name: 'Decision' });
    // Hidden from sm up, sticky to the bottom of the scrolling page.
    expect(bar.className).toContain('sm:hidden');
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');
    expect(within(bar).getByText('3 of 8 tasks done')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Reject' })).toBeInTheDocument();

    await userEvent.click(within(bar).getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Resend invite' }));
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('is not rendered at all on a wide screen — the header keeps the only copy', () => {
    wide = true;
    try {
      render(<StickyActionBar primary={<Button>Approve</Button>} />);
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    } finally {
      wide = false;
    }
  });

  it('draws nothing when there is nothing to do', () => {
    const { container } = render(<StickyActionBar />);
    expect(container).toBeEmptyDOMElement();
  });
});

const application = (over: Partial<ApplicationDetail> = {}): ApplicationDetail =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    associateId: '00000000-0000-4000-8000-000000000002',
    associateName: 'Maria Lopez',
    clientName: 'Coastal Resort Holdings',
    status: 'SUBMITTED',
    percentComplete: 38,
    tasks: [
      { id: 't1', kind: 'PROFILE_INFO', title: 'Profile', status: 'DONE' },
      { id: 't2', kind: 'W4', title: 'W-4', status: 'DONE' },
      { id: 't3', kind: 'I9', title: 'I-9', status: 'SKIPPED' },
      { id: 't4', kind: 'POLICY_ACK', title: 'Policies', status: 'PENDING' },
      { id: 't5', kind: 'DIRECT_DEPOSIT', title: 'Payout', status: 'PENDING' },
      { id: 't6', kind: 'DOCUMENT_UPLOAD', title: 'Documents', status: 'PENDING' },
      { id: 't7', kind: 'E_SIGN', title: 'Agreement', status: 'PENDING' },
      { id: 't8', kind: 'BACKGROUND_CHECK', title: 'Background', status: 'IN_PROGRESS' },
    ],
    ...over,
  }) as unknown as ApplicationDetail;

function renderBar(detail: ApplicationDetail, handlers: Partial<Record<'onApprove' | 'onReject' | 'onCancel', () => void>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ApplicationDecisionBar
          detail={detail}
          onApprove={handlers.onApprove ?? vi.fn()}
          approveLabel="Approve"
          approving={false}
          onReject={handlers.onReject ?? vi.fn()}
          onResend={vi.fn()}
          onCancel={handlers.onCancel ?? vi.fn()}
          onInPerson={vi.fn()}
          onPacket={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<ApplicationDecisionBar>', () => {
  it('keeps Approve on a phone screen, Reject behind More (F500 G1), and says why Approve is blocked', async () => {
    const onReject = vi.fn();
    renderBar(application(), { onReject });
    const bar = screen.getByRole('toolbar', { name: 'Decision' });
    expect(within(bar).getByText('3 of 8 tasks done — Approve opens when all are done.')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /Approve/ })).toBeDisabled();
    // The decline is no longer a button beside the decision.
    expect(within(bar).queryByRole('button', { name: /Reject/ })).not.toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: /More/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Reject/ }));
    expect(onReject).toHaveBeenCalled();
  });

  it('a finished checklist approves in one tap', async () => {
    const onApprove = vi.fn();
    renderBar(application({ percentComplete: 100, tasks: [] }), { onApprove });
    const approve = within(screen.getByRole('toolbar', { name: 'Decision' })).getByRole('button', { name: /Approve/ });
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(onApprove).toHaveBeenCalled();
  });

  it('a decided application has no decision bar', () => {
    renderBar(application({ status: 'APPROVED' }));
    expect(screen.queryByRole('toolbar', { name: 'Decision' })).not.toBeInTheDocument();
  });
});
