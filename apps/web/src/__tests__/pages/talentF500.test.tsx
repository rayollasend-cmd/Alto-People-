import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAs } from './hrPack/harness';

vi.mock('@/lib/mentorship112Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/mentorship112Api')>()),
  listMentorships: vi.fn(),
}));
vi.mock('@/lib/career126Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/career126Api')>()),
  listLadders: vi.fn(),
  getMyCareerPosition: vi.fn(),
  createFieldLeadershipLadder: vi.fn().mockResolvedValue({ id: 'l1' }),
}));
vi.mock('@/lib/skills111Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/skills111Api')>()),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
}));

import { listMentorships } from '@/lib/mentorship112Api';
import { createFieldLeadershipLadder, listLadders } from '@/lib/career126Api';
import { MentorshipHome } from '@/pages/mentorship/MentorshipHome';
import { CareerHome } from '@/pages/career/CareerHome';

/**
 * Empty talent pages (F500 2026-10-22): no search, filter or export over an
 * empty list, and the empty state names the first step — Mentorship's two
 * ways to start, Career's field leadership ladder.
 */

beforeEach(() => {
  vi.mocked(listMentorships).mockResolvedValue({ mentorships: [] } as never);
  vi.mocked(listLadders).mockResolvedValue({ ladders: [] } as never);
});

describe('Mentorship, empty', () => {
  it('shows no search or export, and offers New pairing and Suggest mentors in the empty state', async () => {
    renderAs('HR_ADMINISTRATOR', <MentorshipHome />, '/mentorship');
    expect(await screen.findByText('No mentorships yet')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search mentor or mentee…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /New pairing/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Suggest mentors/ }).length).toBeGreaterThan(0);
  });
});

describe('Career ladders, empty', () => {
  it('folds the field leadership ladder into the empty state and hides the search', async () => {
    renderAs('HR_ADMINISTRATOR', <CareerHome />, '/career');
    expect(await screen.findByText('No ladders yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search ladders by name')).not.toBeInTheDocument();
    // One suggestion, in the empty state — not a separate card above it.
    const add = screen.getAllByRole('button', { name: 'Add the field leadership ladder' });
    expect(add).toHaveLength(1);
    add[0]!.click();
    expect(createFieldLeadershipLadder).toHaveBeenCalled();
  });
});
