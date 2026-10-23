import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ApplicationDetail, ChecklistTask } from '@alto-people/shared';

/**
 * The associate's checklist after the F500 fix-up (2026-10-22):
 *  - first-day facts under the welcome, from the start date and store;
 *  - one gold "Continue with …" (the next row's button looks like the rest);
 *  - a step HR marked not needed says "Not needed" and offers nothing;
 *  - a failed load says so in plain words with Retry.
 */

vi.mock('@/lib/onboardingApi', () => ({
  getApplication: vi.fn(),
  getEeoSelfIdStatus: vi.fn(async () => {
    throw new Error('not shown');
  }),
  submitEeoSelfId: vi.fn(),
}));
vi.mock('@/lib/documentsApi', () => ({
  listMyDocuments: vi.fn(async () => ({ documents: [] })),
}));

import { getApplication } from '@/lib/onboardingApi';
import { listMyDocuments } from '@/lib/documentsApi';
import { AssociateChecklist, firstDayFacts } from '@/pages/onboarding/AssociateChecklist';
import type { Translate } from '@/lib/i18n';

const APP_ID = '00000000-0000-4000-8000-00000000c0c0';

function task(id: string, kind: string, status: ChecklistTask['status'], extra: Partial<ChecklistTask> = {}): ChecklistTask {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    kind: kind as ChecklistTask['kind'],
    status,
    title: kind,
    description: `About ${kind}`,
    order: Number(id),
    documentId: null,
    completedAt: null,
    ...extra,
  };
}

function application(over: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return {
    id: APP_ID,
    associateName: 'Maria Lopez',
    clientName: 'Seaside Hospitality Group',
    onboardingTrack: 'STANDARD',
    status: 'DRAFT',
    position: 'Front-of-house associate',
    startDate: '2026-10-27',
    locationName: 'Front Beach 218',
    invitedAt: '2026-10-01T12:00:00.000Z',
    submittedAt: null,
    percentComplete: 38,
    associateId: '00000000-0000-4000-8000-0000000000a1',
    clientId: '00000000-0000-4000-8000-0000000000c1',
    employmentType: 'W2_EMPLOYEE',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    hireDate: null,
    tasks: [
      task('1', 'PROFILE_INFO', 'PENDING', { dueOffsetDays: 3 }),
      task('2', 'W4', 'PENDING', { dueOffsetDays: 1 }),
      task('3', 'DOCUMENT_UPLOAD', 'SKIPPED'),
      task('4', 'I9_VERIFICATION', 'DONE', { dueOffsetDays: 10 }),
      task('5', 'E_SIGN', 'SKIPPED'),
    ],
    ...over,
  } as ApplicationDetail;
}

function renderChecklist() {
  return rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/onboarding/me/${APP_ID}`]}>
        <Routes>
          <Route path="/onboarding/me/:applicationId" element={<AssociateChecklist />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getApplication).mockReset();
  try {
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
});

describe('<AssociateChecklist> (F500)', () => {
  it('says when and where they start, and by when to finish (the earliest open step\'s due date)', async () => {
    vi.mocked(getApplication).mockResolvedValue(application());
    renderChecklist();
    const facts = await screen.findByTestId('first-day-facts');
    // Start Tue Oct 27; the open steps are due 3 and 1 days before → Sat Oct 24.
    // (I-9 is due 10 days before, but it's done, so it doesn't count.)
    expect(facts.textContent).toMatch(/^Starts Tue, Oct 27(, 2026)? at Front Beach 218 · Finish by Sat, Oct 24(, 2026)?$/);
  });

  it('says nothing about the first day when there is no start date (no guess)', async () => {
    vi.mocked(getApplication).mockResolvedValue(application({ startDate: null }));
    renderChecklist();
    await screen.findByText('Welcome, Maria');
    expect(screen.queryByTestId('first-day-facts')).toBeNull();
  });

  it('firstDayFacts: no store → "Starts …"; no due dates → no "Finish by"', () => {
    const t = ((key: string, vars?: Record<string, string>) =>
      key === 'ob.check.starts' ? `Starts ${vars?.date}` : key) as unknown as Translate;
    const text = firstDayFacts(t, { startDate: '2026-10-27', locationName: null, tasks: [task('9', 'W4', 'PENDING')] });
    expect(text).toMatch(/^Starts Tue, Oct 27(, 2026)?$/);
  });

  it('one gold call to action: the progress card continues, the next row is a plain "Start"', async () => {
    vi.mocked(getApplication).mockResolvedValue(application());
    renderChecklist();
    expect(await screen.findByRole('link', { name: /continue with profile information/i })).toBeInTheDocument();
    expect(screen.queryByText('Start now')).toBeNull();
    const profileRow = screen.getByRole('link', { name: /^profile information/i });
    expect(within(profileRow).getByText('Start')).toBeInTheDocument();
  });

  it('a step HR marked not needed says "Not needed" and offers no action', async () => {
    vi.mocked(getApplication).mockResolvedValue(application());
    renderChecklist();
    await screen.findByText('Welcome, Maria');
    const skipped = screen.getAllByText('Not needed');
    expect(skipped).toHaveLength(2);
    for (const chip of skipped) {
      const row = chip.closest('.group') as HTMLElement;
      expect(row.tagName).not.toBe('A');
      expect(within(row).queryByText(/review \/ edit/i)).toBeNull();
    }
    // The done row still opens for review until HR settles the application.
    const done = screen.getByText('Done').closest('a');
    expect(done).toHaveAttribute('href', `/onboarding/me/${APP_ID}/tasks/i9_verification`);
  });

  it('a failed load says so plainly with Retry', async () => {
    vi.mocked(getApplication).mockRejectedValue(new Error('offline'));
    renderChecklist();
    expect(await screen.findByText(/couldn.t load your onboarding/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('a rejected document is flagged on a row that can open (the I-9), not on a not-needed one', async () => {
    vi.mocked(getApplication).mockResolvedValue(application());
    vi.mocked(listMyDocuments).mockResolvedValueOnce({
      documents: [
        { id: 'd1', kind: 'ID', status: 'REJECTED', filename: 'license.png', i9DocTitle: "Driver's license", rejectionReason: 'blurry' },
      ],
    } as unknown as Awaited<ReturnType<typeof listMyDocuments>>);
    renderChecklist();
    const alert = await screen.findByText(/driver's license was rejected — blurry/i);
    const row = alert.closest('a');
    expect(row).toHaveAttribute('href', `/onboarding/me/${APP_ID}/tasks/i9_verification`);
  });
});

