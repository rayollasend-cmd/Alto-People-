import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Role walk HR 9: an interview has a panel — up to three people from the
 * hiring staff and the client's contacts — not just "me". A slot that
 * clashes with someone's other interview that day is called out (and still
 * allowed: two interviews can share a slot on purpose).
 */

vi.mock('@/lib/recruiting90Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/recruiting90Api')>()),
  listInterviewKits: vi.fn().mockResolvedValue({ kits: [] }),
  listInterviewers: vi.fn().mockResolvedValue({
    interviewers: [
      { id: 'u1', email: 'me@example.com', name: 'Riley Recruiter', role: 'INTERNAL_RECRUITER', clientName: null },
      { id: 'u2', email: 'hana@example.com', name: 'Hana Manager', role: 'MANAGER', clientName: null },
      { id: 'u3', email: 'gm@coastal.com', name: 'Greg GM', role: 'CLIENT_PORTAL', clientName: 'Coastal' },
      { id: 'u4', email: 'x@example.com', name: 'Xia Fourth', role: 'MANAGER', clientName: null },
    ],
  }),
  listInterviews: vi.fn(),
  createInterview: vi.fn().mockResolvedValue({ id: 'iv1', invited: { candidate: true, interviewer: true } }),
}));

import { createInterview, listInterviews, type InterviewRecord } from '@/lib/recruiting90Api';
import { ScheduleInterviewDialog, panelOverlaps } from '@/pages/recruiting/CandidateWorkPanels';

const candidate = { id: 'cand1', firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com' } as never;

/** Tomorrow at 10:00 local — the dialog's default slot. */
function tomorrowAt(h: number, m = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m);
}

describe('<ScheduleInterviewDialog> — the interview panel', () => {
  it('starts with me, adds a second interviewer, warns on their clash, and submits both', async () => {
    vi.mocked(listInterviews).mockImplementation(async (_c, f) => ({
      interviews:
        f?.interviewerUserId === 'u2'
          ? ([{ id: 'other', scheduledFor: tomorrowAt(10, 15).toISOString(), durationMinutes: 30, completedAt: null }] as InterviewRecord[])
          : [],
    }));
    renderAs('INTERNAL_RECRUITER', <ScheduleInterviewDialog candidate={candidate} open onOpenChange={vi.fn()} onScheduled={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    const chosen = within(dialog).getByRole('list', { name: 'Chosen interviewers' });
    await waitFor(() => expect(within(chosen).getByText('Riley Recruiter')).toBeInTheDocument());

    const picker = within(dialog).getByRole('combobox', { name: 'Interviewers' });
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Hana Manager' })).toBeInTheDocument());
    await userEvent.selectOptions(picker, 'u2');
    expect(within(chosen).getByText('Hana Manager')).toBeInTheDocument();
    expect(await within(dialog).findByText(/Hana Manager already has an interview/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /Schedule/ }));
    await waitFor(() => expect(createInterview).toHaveBeenCalled());
    expect(vi.mocked(createInterview).mock.calls[0]![0]).toMatchObject({ interviewerUserIds: ['u1', 'u2'], interviewerUserId: 'u1' });
  });

  it('holds at most three people', async () => {
    vi.mocked(listInterviews).mockResolvedValue({ interviews: [] });
    renderAs('INTERNAL_RECRUITER', <ScheduleInterviewDialog candidate={candidate} open onOpenChange={vi.fn()} onScheduled={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    const picker = within(dialog).getByRole('combobox', { name: 'Interviewers' });
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Hana Manager' })).toBeInTheDocument());
    await userEvent.selectOptions(picker, 'u2');
    await userEvent.selectOptions(picker, 'u3');
    expect(picker).toBeDisabled();
    expect(within(dialog).getByText('A panel holds up to 3 people.')).toBeInTheDocument();
  });

  it('a clash is an overlap with someone’s live interview, not the one being moved', () => {
    const at = tomorrowAt(10);
    const busy = [
      {
        userId: 'u2',
        interviews: [
          { id: 'a', scheduledFor: tomorrowAt(9, 45).toISOString(), durationMinutes: 30, completedAt: null },
          { id: 'b', scheduledFor: tomorrowAt(10, 30).toISOString(), durationMinutes: 30, completedAt: null },
          { id: 'moving', scheduledFor: tomorrowAt(10).toISOString(), durationMinutes: 30, completedAt: null },
        ] as InterviewRecord[],
      },
    ];
    expect(panelOverlaps(at, 30, busy, 'moving').map((c) => c.start.getTime())).toEqual([tomorrowAt(9, 45).getTime()]);
  });
});
