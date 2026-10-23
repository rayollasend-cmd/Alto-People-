import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/orgApi', async (orig) => ({ ...(await orig<typeof import('@/lib/orgApi')>()), listSites: vi.fn().mockResolvedValue({ sites: [] }) }));
vi.mock('@/lib/skills111Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/skills111Api')>()),
  getSkillsOverview: vi.fn(),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  listPendingSkillClaims: vi.fn().mockResolvedValue({ claims: [] }),
  searchSkills: vi.fn().mockResolvedValue({ skills: [{ id: 's1', name: 'Forklift' }], associates: [] }),
}));

import { getSkillsOverview, listPendingSkillClaims, searchSkills } from '@/lib/skills111Api';
import { SkillsHome } from '@/pages/skills/SkillsHome';

/**
 * Skills (F500 2026-10-22) opens on an overview — the catalog in numbers,
 * claims waiting, the skills most people hold — instead of an empty search
 * form, and keeps its tab in the URL.
 */

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

const overview = {
  catalog: 7,
  peopleWithSkill: 4,
  peopleWithVerified: 3,
  toVerify: 2,
  top: [
    { id: 's1', name: 'Forklift', category: 'Warehouse', people: 3, verified: 3 },
    { id: 's2', name: 'Spanish', category: null, people: 2, verified: 0 },
  ],
};

beforeEach(() => {
  vi.mocked(getSkillsOverview).mockResolvedValue(overview);
  vi.mocked(listPendingSkillClaims).mockResolvedValue({ claims: [] });
});

describe('Skills', () => {
  it('opens on the overview: the catalog, who is verified, what waits, the top skills', async () => {
    renderAs('HR_ADMINISTRATOR', <><SkillsHome /><Where /></>, '/skills');
    expect(screen.getByRole('tab', { name: /Overview/, selected: true })).toBeInTheDocument();
    const strip = await screen.findByRole('group', { name: 'Skills at a glance' });
    expect(within(strip).getByText('Skills in the catalog')).toBeInTheDocument();
    expect(within(strip).getByText('4 with any skill on record')).toBeInTheDocument();
    expect(within(strip).getByText('To verify')).toBeInTheDocument();
    // A top skill opens Find people on it.
    expect(screen.getByRole('link', { name: /Forklift/ })).toHaveAttribute('href', '/skills?tab=search&q=Forklift');
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
    // The To verify tile is the way into the queue, and the tab follows the URL.
    await userEvent.click(within(strip).getByText('To verify').closest('button')!);
    expect(screen.getByTestId('where')).toHaveTextContent('/skills?tab=claims');
  });

  it('badges the To verify tab with its count', async () => {
    vi.mocked(listPendingSkillClaims).mockResolvedValue({
      claims: [{ id: 'c1', associateId: 'a1', name: 'Ana', skillName: 'Forklift', category: null, level: 'ADVANCED', yearsExperience: null, notes: null, claimedAt: '2026-10-20T12:00:00Z' }],
    });
    renderAs('HR_ADMINISTRATOR', <SkillsHome />, '/skills');
    expect(await screen.findByRole('tab', { name: /To verify\s*1/ })).toBeInTheDocument();
  });

  it('says the catalog is empty instead of showing zeros, and offers to add a skill', async () => {
    vi.mocked(getSkillsOverview).mockResolvedValue({ catalog: 0, peopleWithSkill: 0, peopleWithVerified: 0, toVerify: 0, top: [] });
    renderAs('HR_ADMINISTRATOR', <><SkillsHome /><Where /></>, '/skills');
    expect(await screen.findByText('No skills in the catalog yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Add a skill/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/skills?tab=catalog');
  });

  it('runs the search named in the URL, with an on-domain placeholder', async () => {
    renderAs('HR_ADMINISTRATOR', <SkillsHome />, '/skills?tab=search&q=Forklift');
    expect(screen.getByRole('tab', { name: /Find people/, selected: true })).toBeInTheDocument();
    await waitFor(() => expect(searchSkills).toHaveBeenCalledWith('Forklift', undefined, { clientId: undefined, locationId: undefined }));
    expect(screen.getByLabelText('Skill')).toHaveAttribute('placeholder', 'Forklift, ServSafe, Spanish…');
  });
});
