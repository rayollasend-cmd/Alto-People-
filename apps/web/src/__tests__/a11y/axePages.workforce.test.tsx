import { describe, expect, it, vi } from 'vitest';
import { render, screen, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'vitest-axe';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * Axe coverage for the workforce/HR long-tail pages. Same harness rules
 * as axeSmoke.test.tsx: color-contrast can't run in jsdom (no paint) and
 * `region` is off because we render page subtrees, not the Layout shell.
 * NEVER widen the disabled-rules list — failures are fixed in the pages.
 *
 * Each page's lib/*Api module is mocked with minimal resolved shapes so
 * the page settles into its loaded/empty state; we await stable text
 * before scanning so axe sees real content, not skeletons.
 */

const AXE_OPTIONS = {
  rules: {
    // Needs real rendering to compute contrast; jsdom has none.
    'color-contrast': { enabled: false },
    // Page subtrees aren't whole documents; landmarks live in Layout.
    region: { enabled: false },
  },
} as const;

function formatViolations(violations: Awaited<ReturnType<typeof axe>>['violations']) {
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `    ${n.html}`).join('\n'),
    )
    .join('\n');
}

async function expectNoViolations(container: HTMLElement) {
  const results = await axe(container, AXE_OPTIONS);
  expect(
    results.violations,
    formatViolations(results.violations),
  ).toHaveLength(0);
}

/* ------------------------------------------------------------------ *
 *  API mocks — minimal resolved shapes so each page renders its
 *  loaded/empty state instead of an infinite skeleton.
 * ------------------------------------------------------------------ */

vi.mock('@/lib/hrCases123Api', () => ({
  addComment: vi.fn(),
  fileCase: vi.fn(),
  getCase: vi.fn(),
  getCaseSummary: vi.fn().mockResolvedValue({ openTotal: 0 }),
  listCaseQueue: vi.fn().mockResolvedValue({ cases: [] }),
  listMyCases: vi.fn().mockResolvedValue({ cases: [] }),
  triageCase: vi.fn(),
  CATEGORY_LABELS: { BENEFITS: 'Benefits', PAYROLL: 'Payroll & pay', OTHER: 'Other' },
  STATUS_LABELS: {
    OPEN: 'Open',
    IN_PROGRESS: 'In progress',
    WAITING_ASSOCIATE: 'Waiting on associate',
    RESOLVED: 'Resolved',
    CLOSED: 'Closed',
  },
}));

vi.mock('@/lib/discipline118Api', () => ({
  acknowledgeDisciplinaryAction: vi.fn(),
  issueDisciplinaryAction: vi.fn(),
  listDisciplinaryActions: vi.fn().mockResolvedValue({ actions: [] }),
  rescindDisciplinaryAction: vi.fn(),
  KIND_LABELS: {
    VERBAL_WARNING: 'Verbal warning',
    WRITTEN_WARNING: 'Written warning',
    FINAL_WARNING: 'Final warning',
    SUSPENSION: 'Suspension',
    TERMINATION: 'Termination',
  },
}));

vi.mock('@/lib/separation119Api', () => ({
  advanceSeparation: vi.fn(),
  getSeparationSummary: vi.fn().mockResolvedValue({
    planned: 0,
    inProgress: 0,
    completedInWindow: 0,
    exitInterviewCompletedInWindow: 0,
    averageRating: null,
  }),
  initiateSeparation: vi.fn(),
  listSeparations: vi.fn().mockResolvedValue({ separations: [] }),
  submitExitInterview: vi.fn(),
  REASON_LABELS: {
    VOLUNTARY_OTHER_OPPORTUNITY: 'Voluntary — other opportunity',
    INVOLUNTARY_PERFORMANCE: 'Involuntary — performance',
  },
}));

vi.mock('@/lib/probation116Api', () => ({
  decideProbation: vi.fn(),
  extendProbation: vi.fn(),
  getProbationSummary: vi.fn().mockResolvedValue({
    active: 0,
    endingSoon: 0,
    overdue: 0,
    passedLast90Days: 0,
    failedLast90Days: 0,
  }),
  listProbations: vi.fn().mockResolvedValue({ probations: [] }),
  startProbation: vi.fn(),
}));

vi.mock('@/lib/succession115Api', () => ({
  createSuccessionCandidate: vi.fn(),
  deleteSuccessionCandidate: vi.fn(),
  getSuccessionPosition: vi.fn(),
  getSuccessionSummary: vi.fn().mockResolvedValue({
    positionCount: 0,
    positionsWithSuccessor: 0,
    coverage: 0,
    byReadiness: {
      READY_NOW: 0,
      READY_1_2_YEARS: 0,
      READY_3_PLUS_YEARS: 0,
      EMERGENCY_COVER: 0,
    },
  }),
  listSuccessionPositions: vi.fn().mockResolvedValue({ positions: [] }),
  updateSuccessionCandidate: vi.fn(),
  READINESS_LABELS: {
    READY_NOW: 'Ready now',
    READY_1_2_YEARS: 'Ready in 1–2 years',
    READY_3_PLUS_YEARS: 'Ready in 3+ years',
    EMERGENCY_COVER: 'Emergency cover',
  },
}));

vi.mock('@/lib/ramp125Api', () => ({
  addMilestone: vi.fn(),
  archiveRampPlan: vi.fn(),
  createRampPlan: vi.fn(),
  deleteMilestone: vi.fn(),
  getActivePlanForAssociate: vi.fn(),
  listRampPlans: vi.fn().mockResolvedValue({ plans: [] }),
  updateMilestone: vi.fn(),
  STATUS_LABELS: {
    PENDING: 'Pending',
    ON_TRACK: 'On track',
    ACHIEVED: 'Achieved',
    MISSED: 'Missed',
  },
}));

vi.mock('@/lib/mentorship112Api', () => ({
  listMentorships: vi.fn().mockResolvedValue({ mentorships: [] }),
  proposeMentorship: vi.fn(),
  suggestMentors: vi.fn(),
  transitionMentorship: vi.fn(),
}));

vi.mock('@/lib/career126Api', () => ({
  addLevel: vi.fn(),
  addLevelSkill: vi.fn(),
  archiveLadder: vi.fn(),
  createLadder: vi.fn(),
  deleteLevel: vi.fn(),
  getLadder: vi.fn(),
  listLadders: vi.fn().mockResolvedValue({ ladders: [] }),
  removeLevelSkill: vi.fn(),
  SKILL_LEVEL_LABELS: {
    BEGINNER: 'Beginner',
    INTERMEDIATE: 'Intermediate',
    ADVANCED: 'Advanced',
    EXPERT: 'Expert',
  },
}));

vi.mock('@/lib/skills111Api', () => ({
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  searchSkills: vi.fn(),
}));

vi.mock('@/lib/celebrations107Api', () => ({
  listUpcomingCelebrations: vi.fn().mockResolvedValue({ items: [] }),
  sendHighFive: vi.fn(),
}));

vi.mock('@/lib/headcount110Api', () => ({
  getHeadcountSnapshot: vi.fn().mockResolvedValue({
    total: 0,
    byDepartment: [],
    byClient: [],
    byEmploymentType: [],
  }),
  getTurnover: vi.fn().mockResolvedValue({
    hires: 0,
    terminations: 0,
    annualizedTurnoverRate: 0,
  }),
}));

vi.mock('@/lib/orgApi', () => ({
  listOrgAssociates: vi.fn().mockResolvedValue({ associates: [] }),
}));

vi.mock('@/lib/assets108Api', () => ({
  assignAsset: vi.fn(),
  createAsset: vi.fn(),
  deleteAsset: vi.fn(),
  listAssets: vi.fn().mockResolvedValue({ assets: [] }),
  returnAsset: vi.fn(),
  updateAsset: vi.fn(),
}));

/* ------------------------------------------------------------------ *
 *  Pages under test (imported after the mocks above)
 * ------------------------------------------------------------------ */

import { HrCasesHome } from '@/pages/hrCases/HrCasesHome';
import { DisciplineHome } from '@/pages/discipline/DisciplineHome';
import { SeparationHome } from '@/pages/separation/SeparationHome';
import { ProbationHome } from '@/pages/probation/ProbationHome';
import { SuccessionHome } from '@/pages/succession/SuccessionHome';
import { RampHome } from '@/pages/ramp/RampHome';
import { MentorshipHome } from '@/pages/mentorship/MentorshipHome';
import { CareerHome } from '@/pages/career/CareerHome';
import { SkillsHome } from '@/pages/skills/SkillsHome';
import { CelebrationsHome } from '@/pages/celebrations/CelebrationsHome';
import { HeadcountHome } from '@/pages/headcount/HeadcountHome';
import { AssetsHome } from '@/pages/assets/AssetsHome';

/* ------------------------------------------------------------------ *
 *  Harness
 * ------------------------------------------------------------------ */

const ADMIN_AUTH = {
  isInitializing: false,
  isOffline: false,
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@altohr.com',
    role: 'HR_ADMINISTRATOR' as const,
    status: 'ACTIVE' as const,
    clientId: null,
    associateId: null,
    firstName: 'Ada',
    lastName: 'Admin',
    photoUrl: null,
    timezone: null,
    mfaEnabled: false,
  },
  role: 'HR_ADMINISTRATOR' as const,
  capabilities: ROLE_CAPABILITIES.HR_ADMINISTRATOR,
  signIn: vi.fn(async () => ({ mfaRequired: false })),
  submitMfaChallenge: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  refreshUser: vi.fn(async () => {}),
  can: () => true,
};

function renderPage(ui: React.ReactElement): RenderResult {
  return render(
    <AuthContext.Provider value={ADMIN_AUTH}>
      <ConfirmProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ConfirmProvider>
    </AuthContext.Provider>,
  );
}

describe('axe — workforce/HR long-tail pages', () => {
  it('<HrCasesHome> has no axe violations', async () => {
    const { container } = renderPage(<HrCasesHome />);
    await screen.findByText('No cases yet');
    await expectNoViolations(container);
  });

  it('<DisciplineHome> has no axe violations', async () => {
    const { container } = renderPage(<DisciplineHome />);
    await screen.findByText('No disciplinary actions');
    await expectNoViolations(container);
  });

  it('<SeparationHome> has no axe violations', async () => {
    const { container } = renderPage(<SeparationHome />);
    await screen.findByText('No separations');
    await screen.findByText('Exit interviews (90d)');
    await expectNoViolations(container);
  });

  it('<ProbationHome> has no axe violations', async () => {
    const { container } = renderPage(<ProbationHome />);
    await screen.findByText('No probations');
    await screen.findByText('Ending in 14 days');
    await expectNoViolations(container);
  });

  it('<SuccessionHome> has no axe violations', async () => {
    const { container } = renderPage(<SuccessionHome />);
    await screen.findByText('No positions');
    await screen.findByText('With successor');
    await expectNoViolations(container);
  });

  it('<RampHome> has no axe violations', async () => {
    const { container } = renderPage(<RampHome />);
    await screen.findByText('No active plans');
    await expectNoViolations(container);
  });

  it('<MentorshipHome> has no axe violations', async () => {
    const { container } = renderPage(<MentorshipHome />);
    await screen.findByText('No mentorships yet');
    await expectNoViolations(container);
  });

  it('<CareerHome> has no axe violations', async () => {
    const { container } = renderPage(<CareerHome />);
    await screen.findByText('No ladders yet');
    await expectNoViolations(container);
  });

  it('<SkillsHome> has no axe violations', async () => {
    const { container } = renderPage(<SkillsHome />);
    // Search tab is the default; its form renders synchronously.
    await screen.findByRole('tab', { name: /find people/i });
    await expectNoViolations(container);
  });

  it('<CelebrationsHome> has no axe violations', async () => {
    const { container } = renderPage(<CelebrationsHome />);
    await screen.findByText('Nothing in the next 60 days');
    await expectNoViolations(container);
  });

  it('<HeadcountHome> has no axe violations', async () => {
    const { container } = renderPage(<HeadcountHome />);
    await screen.findByText('Active headcount');
    await screen.findByText('0%'); // turnover KPI settled
    await expectNoViolations(container);
  });

  it('<AssetsHome> has no axe violations', async () => {
    const { container } = renderPage(<AssetsHome />);
    await screen.findByText('No assets');
    await expectNoViolations(container);
  });
});
