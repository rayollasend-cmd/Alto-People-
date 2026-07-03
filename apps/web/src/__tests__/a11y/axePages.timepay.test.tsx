import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'vitest-axe';
import type { ReactNode } from 'react';
import type { AuthUser } from '@alto-people/shared';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * Axe coverage for the time & pay long tail. Same contract as
 * axeSmoke.test.tsx: each page is rendered to a SETTLED empty state
 * (API mocks resolve with empty lists), we await a stable marker, then
 * run axe. If a test fails, fix the page/component — never widen the
 * disabled-rules list below.
 */

// ---- API mocks (empty, settled states) --------------------------------

vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({
    clients: [{ id: 'c0000000-0000-4000-8000-000000000001', name: 'Acme Grocery' }],
  })),
}));

vi.mock('@/lib/payRulesApi', () => ({
  listProjects: vi.fn(async () => ({ projects: [] })),
  listPremiumPayRules: vi.fn(async () => ({ rules: [] })),
  listTipPools: vi.fn(async () => ({ pools: [] })),
  listAllocations: vi.fn(async () => ({ allocations: [] })),
  autoAllocate: vi.fn(),
  closeTipPool: vi.fn(),
  createPremiumPayRule: vi.fn(),
  createProject: vi.fn(),
  createTipPool: vi.fn(),
  deactivateProject: vi.fn(),
  deletePremiumPayRule: vi.fn(),
  payOutTipPool: vi.fn(),
}));

vi.mock('@/lib/compApi', () => ({
  listBands: vi.fn(async () => ({ bands: [] })),
  listCycles: vi.fn(async () => ({ cycles: [] })),
  listProposals: vi.fn(async () => ({ proposals: [] })),
  applyCycle: vi.fn(),
  createBand: vi.fn(),
  createCycle: vi.fn(),
  deleteBand: vi.fn(),
  seedCycle: vi.fn(),
  updateBand: vi.fn(),
  updateProposal: vi.fn(),
}));

vi.mock('@/lib/benefitsApi', () => ({
  listMyEnrollments: vi.fn(async () => ({ enrollments: [] })),
  listPlans: vi.fn(async () => ({ plans: [] })),
  enrollMe: vi.fn(),
  terminateMyEnrollment: vi.fn(),
}));

// BenefitsHome pulls its client list from the onboarding API.
vi.mock('@/lib/onboardingApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
}));

vi.mock('@/lib/benefitsLifecycle92Api', () => ({
  listOpenEnrollment: vi.fn(async () => ({ windows: [] })),
  listQles: vi.fn(async () => ({ qles: [] })),
  listCobra: vi.fn(async () => ({ offers: [] })),
  get1095c: vi.fn(async () => ({ employees: [] })),
  createCobra: vi.fn(),
  createOpenEnrollment: vi.fn(),
  createQle: vi.fn(),
  decideQle: vi.fn(),
  electCobra: vi.fn(),
  openEnrollmentClose: vi.fn(),
  openEnrollmentOpen: vi.fn(),
  waiveCobra: vi.fn(),
}));

vi.mock('@/lib/equity129Api', () => ({
  listMyEquity: vi.fn(async () => ({ grants: [] })),
  listEquityGrants: vi.fn(async () => ({ grants: [] })),
  getEquitySummary: vi.fn(async () => ({
    proposedCount: 0,
    activeRecipients: 0,
    sharesGranted: 0,
    sharesVested: 0,
  })),
  getEquityGrant: vi.fn(),
  cancelEquityGrant: vi.fn(),
  createEquityGrant: vi.fn(),
  exerciseEquityGrant: vi.fn(),
  grantEquityGrant: vi.fn(),
}));

vi.mock('@/lib/tuition127Api', () => ({
  listMyTuition: vi.fn(async () => ({ requests: [] })),
  listTuitionQueue: vi.fn(async () => ({ requests: [] })),
  getTuitionSummary: vi.fn(async () => ({
    pendingCount: 0,
    approvedAwaitingPayment: 0,
    paidYtdAmount: '0.00',
  })),
  decideTuition: vi.fn(),
  payTuition: vi.fn(),
  setTuitionGrade: vi.fn(),
  submitTuitionRequest: vi.fn(),
}));

vi.mock('@/lib/reimbursements97Api', () => ({
  listReimbursements: vi.fn(async () => ({ reimbursements: [] })),
  getReimbursement: vi.fn(),
  RECOMMENDED_CATEGORIES: ['Travel'],
  addExpenseLine: vi.fn(),
  createReimbursement: vi.fn(),
  deleteExpenseLine: vi.fn(),
  managerApproveReimbursement: vi.fn(),
  rejectReimbursement: vi.fn(),
  settleReimbursement: vi.fn(),
  submitReimbursement: vi.fn(),
}));

vi.mock('@/lib/holiday117Api', () => ({
  listHolidays: vi.fn(async () => ({ holidays: [] })),
  createHoliday: vi.fn(),
  deleteHoliday: vi.fn(),
  importUsFederalHolidays2026: vi.fn(),
}));

vi.mock('@/lib/vto130Api', () => ({
  listMyVolunteer: vi.fn(async () => ({
    year: 2026,
    usedHours: 0,
    capHours: 40,
    matchRatio: 0,
    matchCurrency: 'USD',
    entries: [],
  })),
  listVolunteerQueue: vi.fn(async () => ({ entries: [] })),
  getVolunteerSummary: vi.fn(async () => ({
    pendingCount: 0,
    hoursYtd: 0,
    matchedAmountYtd: '0.00',
  })),
  decideVolunteerEntry: vi.fn(),
  matchVolunteerEntry: vi.fn(),
  submitVolunteerEntry: vi.fn(),
}));

vi.mock('@/lib/expirations113Api', () => ({
  getExpirations: vi.fn(async () => ({
    days: 60,
    counts: { expired: 0, dueSoon: 0, dueLater: 0 },
    expired: [],
    dueSoon: [],
    dueLater: [],
  })),
}));

// Shared by ExpirationsHome (grantAssociateQual) and MarketplaceHome.
vi.mock('@/lib/qualApi', () => ({
  listOpenShifts: vi.fn(async () => ({ shifts: [] })),
  listPendingClaims: vi.fn(async () => ({ claims: [] })),
  listQualifications: vi.fn(async () => ({ qualifications: [] })),
  claimShift: vi.fn(),
  createQualification: vi.fn(),
  deleteQualification: vi.fn(),
  updateClaim: vi.fn(),
  grantAssociateQual: vi.fn(),
}));

vi.mock('@/lib/payrollTax91Api', () => ({
  listGarnishments: vi.fn(async () => ({ garnishments: [] })),
  listTaxForms: vi.fn(async () => ({ forms: [] })),
  listGarnishmentDeductions: vi.fn(async () => ({ deductions: [] })),
  getSubmitterProfile: vi.fn(async () => ({ profile: null })),
  build941: vi.fn(),
  createGarnishment: vi.fn(),
  createTaxForm: vi.fn(),
  createW2c: vi.fn(),
  deductGarnishment: vi.fn(),
  fileTaxForm: vi.fn(),
  garnishmentLetterUrl: vi.fn(() => '#'),
  generateW2s: vi.fn(),
  generate1099Necs: vi.fn(),
  generate1099Miscs: vi.fn(),
  clearAssociateTin: vi.fn(),
  getAssociateTin: vi.fn(),
  saveAssociateTin: vi.fn(),
  saveSubmitterProfile: vi.fn(),
  setGarnishmentStatus: vi.fn(),
  taxFormPdfUrl: vi.fn(() => '#'),
  voidTaxForm: vi.fn(),
  w2BulkZipUrl: vi.fn(() => '#'),
  w2Efw2Url: vi.fn(() => '#'),
  w2Efw2cUrl: vi.fn(() => '#'),
  w2PdfUrl: vi.fn(() => '#'),
  f1099NecBulkZipUrl: vi.fn(() => '#'),
  f1099NecFireUrl: vi.fn(() => '#'),
  f1099MiscBulkZipUrl: vi.fn(() => '#'),
  f1099MiscFireUrl: vi.fn(() => '#'),
}));

// Pages under test — imported AFTER the mocks above are registered.
import { PayRulesHome } from '@/pages/payrules/PayRulesHome';
import { CompensationHome } from '@/pages/compensation/CompensationHome';
import { BenefitsHome } from '@/pages/benefits/BenefitsHome';
import { BenefitsLifecycle } from '@/pages/benefits/BenefitsLifecycle';
import { EquityHome } from '@/pages/equity/EquityHome';
import { TuitionHome } from '@/pages/tuition/TuitionHome';
import { ReimbursementsHome } from '@/pages/reimbursements/ReimbursementsHome';
import { HolidaysHome } from '@/pages/holidays/HolidaysHome';
import { VtoHome } from '@/pages/vto/VtoHome';
import { ExpirationsHome } from '@/pages/expirations/ExpirationsHome';
import { MarketplaceHome } from '@/pages/marketplace/MarketplaceHome';
import { PayrollTaxHome } from '@/pages/payrollTax/PayrollTaxHome';

// ---- Harness (mirrors axeSmoke.test.tsx — do NOT widen this list) -----

const AXE_OPTIONS = {
  rules: {
    // Needs real rendering to compute contrast; jsdom has none.
    'color-contrast': { enabled: false },
    // Component subtrees aren't whole pages; landmarks are Layout's job.
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

// Admin-ish auth: full capability surface so admin tabs/actions render.
const adminUser: AuthUser = {
  id: 'a0000000-0000-4000-8000-000000000001',
  email: 'admin@altohr.com',
  role: 'HR_ADMINISTRATOR',
  status: 'ACTIVE',
  clientId: null,
  // Non-null so associate-facing pages (BenefitsHome) render fully.
  associateId: 'a0000000-0000-4000-8000-000000000002',
  firstName: 'Ada',
  lastName: 'Admin',
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
};

function renderPage(page: ReactNode) {
  const value = {
    isInitializing: false,
    isOffline: false,
    user: adminUser,
    role: adminUser.role,
    capabilities: ROLE_CAPABILITIES[adminUser.role],
    signIn: vi.fn(async () => ({ mfaRequired: false })),
    submitMfaChallenge: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    refreshUser: vi.fn(async () => {}),
    can: () => true,
  };
  return render(
    <AuthContext.Provider value={value}>
      <ConfirmProvider>
        <MemoryRouter>{page}</MemoryRouter>
      </ConfirmProvider>
    </AuthContext.Provider>,
  );
}

describe('axe: time & pay pages (settled empty states)', () => {
  it('<PayRulesHome> has no axe violations', async () => {
    const { container } = renderPage(<PayRulesHome />);
    await screen.findByText('No projects');
    await expectNoViolations(container);
  });

  it('<CompensationHome> has no axe violations', async () => {
    const { container } = renderPage(<CompensationHome />);
    await screen.findByText('No pay bands');
    await expectNoViolations(container);
  });

  it('<BenefitsHome> has no axe violations', async () => {
    const { container } = renderPage(<BenefitsHome />);
    await screen.findByText('No active benefits');
    await expectNoViolations(container);
  });

  it('<BenefitsLifecycle> has no axe violations', async () => {
    const { container } = renderPage(<BenefitsLifecycle />);
    await screen.findByText('No open enrollment windows');
    await expectNoViolations(container);
  });

  it('<EquityHome> has no axe violations', async () => {
    const { container } = renderPage(<EquityHome />);
    await screen.findByText('No equity grants');
    await expectNoViolations(container);
  });

  it('<TuitionHome> has no axe violations', async () => {
    const { container } = renderPage(<TuitionHome />);
    await screen.findByText('No requests yet');
    await expectNoViolations(container);
  });

  it('<ReimbursementsHome> has no axe violations', async () => {
    const { container } = renderPage(<ReimbursementsHome />);
    await screen.findByText('No reimbursements');
    await expectNoViolations(container);
  });

  it('<HolidaysHome> has no axe violations', async () => {
    const { container } = renderPage(<HolidaysHome />);
    await screen.findByText(`No holidays for ${new Date().getFullYear()}`);
    await expectNoViolations(container);
  });

  it('<VtoHome> has no axe violations', async () => {
    const { container } = renderPage(<VtoHome />);
    await screen.findByText('No volunteer hours yet');
    await expectNoViolations(container);
  });

  it('<ExpirationsHome> has no axe violations', async () => {
    const { container } = renderPage(<ExpirationsHome />);
    await screen.findByText('Nothing expired.');
    await expectNoViolations(container);
  });

  it('<MarketplaceHome> has no axe violations', async () => {
    // Admin auth → the page opens on the "Pending claims" tab.
    const { container } = renderPage(<MarketplaceHome />);
    await screen.findByText('No pending claims');
    await expectNoViolations(container);
  });

  it('<PayrollTaxHome> has no axe violations', async () => {
    const { container } = renderPage(<PayrollTaxHome />);
    await screen.findByText('No garnishments');
    await expectNoViolations(container);
  });
});
