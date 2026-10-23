import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';
import type { Enrollment } from '@/lib/lms94Api';

vi.mock('@/lib/lms94Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/lms94Api')>()),
  getLmsSummary: vi.fn(),
  listCourses: vi.fn().mockResolvedValue({ courses: [] }),
  listEnrollments: vi.fn(),
  listExpiring: vi.fn().mockResolvedValue({ expiring: [] }),
}));
vi.mock('@/lib/learningPaths114Api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLearningPaths: vi.fn().mockResolvedValue({ paths: [] }),
}));

import { getLmsSummary, listEnrollments } from '@/lib/lms94Api';
import { LearningHome } from '@/pages/learning/LearningHome';
import { LearningPathsHome } from '@/pages/learningPaths/LearningPathsHome';

/**
 * Learning, the admin desk (F500 2026-10-22): numbers first — lapsed,
 * expiring, not finished, the 30-day completion rate — each opening its
 * list; the tab and the enrollment filter live in the URL; Learning paths
 * is a sibling page, linked both ways.
 */

const enrollment = (id: string, status: Enrollment['status'], name: string): Enrollment => ({
  id,
  courseId: 'c1',
  courseTitle: 'Food safety',
  associateId: `a-${id}`,
  associateName: name,
  status,
  completedAt: null,
  expiresAt: null,
  score: null,
  assignedAt: '2026-10-01T12:00:00.000Z',
});

beforeEach(() => {
  vi.mocked(getLmsSummary).mockResolvedValue({ lapsed: 2, expiring30: 2, expiring14: 1, open: 2, openStale: 1, assigned30: 2, completed30: 1, completionRate30: 50 });
  vi.mocked(listEnrollments).mockResolvedValue({
    enrollments: [enrollment('e1', 'ASSIGNED', 'Ana Ruiz'), enrollment('e2', 'IN_PROGRESS', 'Ben Cole'), enrollment('e3', 'COMPLETED', 'Cy Park')],
  });
});

describe('Learning (admin)', () => {
  it('opens on the numbers, each a link to the list behind it', async () => {
    renderAs('HR_ADMINISTRATOR', <LearningHome />, '/learning');
    const strip = await screen.findByRole('group', { name: 'Training at a glance' });
    await within(strip).findByText('1 within 14 days');
    const tile = (label: string) => within(strip).getByText(label).closest('a')!;
    expect(tile('Lapsed')).toHaveAttribute('href', '/learning?tab=expiring');
    expect(within(tile('Expiring in 30 days')).getByText('1 within 14 days')).toBeInTheDocument();
    expect(tile('Not finished')).toHaveAttribute('href', '/learning?tab=enrollments&status=OPEN');
    expect(within(tile('Not finished')).getByText('1 assigned 30+ days ago')).toBeInTheDocument();
    expect(await within(tile('Completion rate · 30 days')).findByText('50%')).toBeInTheDocument();
    expect(within(tile('Completion rate · 30 days')).getByText('1 of 2 assigned in the last 30 days')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Learning paths' })).toHaveAttribute('href', '/learning-paths');
  });

  it('says so when nothing was assigned in 30 days, instead of 0%', async () => {
    vi.mocked(getLmsSummary).mockResolvedValue({ lapsed: 1, expiring30: 0, expiring14: 0, open: 0, openStale: 0, assigned30: 0, completed30: 0, completionRate30: null });
    renderAs('HR_ADMINISTRATOR', <LearningHome />, '/learning');
    expect(await screen.findByText('Nothing assigned in 30 days')).toBeInTheDocument();
  });

  it('gives one quiet line instead of four zeros when there is nothing to chase', async () => {
    vi.mocked(getLmsSummary).mockResolvedValue({ lapsed: 0, expiring30: 0, expiring14: 0, open: 0, openStale: 0, assigned30: 0, completed30: 0, completionRate30: null });
    renderAs('HR_ADMINISTRATOR', <LearningHome />, '/learning');
    expect(await screen.findByText(/No training is open, lapsed or expiring/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Training at a glance' })).not.toBeInTheDocument();
  });

  it('lands on the enrollments the "Not finished" tile names', async () => {
    renderAs('HR_ADMINISTRATOR', <LearningHome />, '/learning?tab=enrollments&status=OPEN');
    expect(screen.getByRole('tab', { name: /Enrollments/, selected: true })).toBeInTheDocument();
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Ben Cole')).toBeInTheDocument();
    expect(screen.queryByText('Cy Park')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/enrollments/i, { selector: 'select' })).toHaveValue('OPEN');
  });

  it('Learning paths: no search over an empty list, a primary New path, and the way back to courses', async () => {
    renderAs('HR_ADMINISTRATOR', <LearningPathsHome />, '/learning-paths');
    expect(await screen.findByText('No learning paths yet')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search paths…')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New path/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Courses & enrollments' })).toHaveAttribute('href', '/learning');
  });
});
