import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * Audit Tier 3: routes that existed with no screen.
 *   - Skills: record a skill for a person at a level, verify it, remove it.
 *   - Worktags: tag a record with one value per category, and the report
 *     that counts records by value.
 */

vi.mock('@/lib/skills111Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/skills111Api')>()),
  listSkills: vi.fn().mockResolvedValue({
    skills: [
      { id: 'sk1', name: 'Forklift', category: 'Warehouse', associateCount: 2 },
      { id: 'sk2', name: 'Spanish', category: 'Language', associateCount: 5 },
    ],
  }),
  listAssociateSkills: vi.fn(),
  claimAssociateSkill: vi.fn().mockResolvedValue({ id: 'as-new' }),
  verifyAssociateSkill: vi.fn().mockResolvedValue({ ok: true }),
  deleteAssociateSkill: vi.fn(),
}));
vi.mock('@/components/ui/AssociatePicker', () => ({
  AssociatePicker: ({ value, onChange }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string }) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'a1', name: 'Maria Lopez' })}>
      {value ? value.name : 'Pick a person'}
    </button>
  ),
}));
vi.mock('@/lib/worktags95Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/worktags95Api')>()),
  listCategories: vi.fn().mockResolvedValue({
    categories: [{ id: 'cat1', key: 'project', label: 'Project', description: null, isRequired: false, isActive: true, worktagCount: 2 }],
  }),
  listWorktags: vi.fn().mockResolvedValue({
    worktags: [
      { id: 'w1', categoryId: 'cat1', categoryKey: 'project', categoryLabel: 'Project', value: 'Fall Opening', code: 'FO' },
      { id: 'w2', categoryId: 'cat1', categoryKey: 'project', categoryLabel: 'Project', value: 'Winter Hold', code: null },
    ],
  }),
  getAssignments: vi.fn().mockResolvedValue({ assignments: [] }),
  assignWorktags: vi.fn().mockResolvedValue({ ok: true, assigned: 1 }),
  removeAssignment: vi.fn(),
  worktagsReport: vi.fn().mockResolvedValue({
    category: { key: 'project', label: 'Project' },
    entityKind: 'PAYROLL_ITEM',
    rows: [
      { worktagId: 'w1', value: 'Fall Opening', count: 14 },
      { worktagId: 'w2', value: 'Winter Hold', count: 3 },
    ],
  }),
}));

import { claimAssociateSkill, listAssociateSkills, verifyAssociateSkill } from '@/lib/skills111Api';
import { assignWorktags, worktagsReport } from '@/lib/worktags95Api';
import { PersonSkillsTab } from '@/pages/skills/SkillsHome';
import { AssignTab, ReportTab } from '@/pages/worktags/WorktagsHome';

describe('one person’s skills', () => {
  it('records a skill at a level, then verifies it', async () => {
    vi.mocked(listAssociateSkills).mockResolvedValue({
      skills: [{ id: 'as1', skillId: 'sk2', skillName: 'Spanish', category: 'Language', level: 'ADVANCED', yearsExperience: 4, notes: null, verifiedAt: null, verifiedByEmail: null }],
    });
    renderAs('HR_ADMINISTRATOR', <PersonSkillsTab canManage />);
    await userEvent.click(screen.getByRole('button', { name: 'Pick a person' }));
    const list = await screen.findByRole('list', { name: "Maria Lopez's skills" });
    expect(within(list).getByText('Spanish')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('option', { name: /Forklift/ })).toBeInTheDocument());
    // Already-held skills aren't offered again.
    expect(screen.queryByRole('option', { name: /Spanish/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Skill'), 'sk1');
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'EXPERT');
    await userEvent.type(screen.getByLabelText('Years'), '6');
    await userEvent.click(screen.getByRole('button', { name: /Add skill/ }));
    await waitFor(() =>
      expect(claimAssociateSkill).toHaveBeenCalledWith({ associateId: 'a1', skillId: 'sk1', level: 'EXPERT', yearsExperience: 6 }),
    );

    await userEvent.click(within(list).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(verifyAssociateSkill).toHaveBeenCalledWith('as1'));
  });
});

describe('worktags', () => {
  it('tags a record with one value per category', async () => {
    renderAs('FINANCE_ACCOUNTANT', <AssignTab />);
    await userEvent.selectOptions(screen.getByLabelText('Record'), 'PAYROLL_ITEM');
    await userEvent.type(screen.getByLabelText('Record id'), '00000000-0000-4000-8000-000000000123');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const project = await screen.findByLabelText('Project');
    await userEvent.selectOptions(project, 'w1');
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));
    await waitFor(() =>
      expect(assignWorktags).toHaveBeenCalledWith({
        entityKind: 'PAYROLL_ITEM',
        entityId: '00000000-0000-4000-8000-000000000123',
        worktagIds: ['w1'],
      }),
    );
  });

  it('refuses something that is not a record id', async () => {
    renderAs('FINANCE_ACCOUNTANT', <AssignTab />);
    await userEvent.type(screen.getByLabelText('Record id'), 'not-an-id');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();
  });

  it('the report counts records by value', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ReportTab />);
    expect(await screen.findByText('Fall Opening')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('Winter Hold')).toBeInTheDocument();
    expect(worktagsReport).toHaveBeenCalledWith('project', 'PAYROLL_ITEM');
  });
});
