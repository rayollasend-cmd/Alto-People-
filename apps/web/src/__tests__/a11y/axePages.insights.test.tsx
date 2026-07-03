import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'vitest-axe';
import type { AuthUser } from '@alto-people/shared';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * Axe coverage — insights / compliance / misc long-tail pages. Same
 * contract as axeSmoke.test.tsx: each page is rendered with its API
 * layer mocked to a settled EMPTY state (no infinite skeletons), we
 * await a stable marker, then assert zero axe violations.
 *
 * If a test here fails, the fix belongs in the page/component, not in
 * this file's config. Never widen the disabled-rules list.
 */

// ---------------------------------------------------------------------------
// API mocks — minimal resolved shapes matching what each page destructures.
// importOriginal keeps runtime constants (KIND_LABELS, STATUS_LABELS, …)
// intact so option lists still render.
// ---------------------------------------------------------------------------

vi.mock('@/lib/workflowsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workflowsApi')>()),
  listWorkflows: vi.fn(async () => ({ definitions: [] })),
  listRuns: vi.fn(async () => ({ runs: [] })),
}));

vi.mock('@/lib/apiKeysWebhooks93Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiKeysWebhooks93Api')>()),
  listApiKeys: vi.fn(async () => ({ keys: [] })),
  listWebhooks: vi.fn(async () => ({ webhooks: [] })),
}));

vi.mock('@/lib/clientsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clientsApi')>()),
  listClients: vi.fn(async () => ({ clients: [] })),
}));

vi.mock('@/lib/docTemplatesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/docTemplatesApi')>()),
  listTemplates: vi.fn(async () => ({ templates: [] })),
  listVersions: vi.fn(async () => ({ versions: [] })),
}));

vi.mock('@/lib/worktags95Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/worktags95Api')>()),
  listCategories: vi.fn(async () => ({ categories: [] })),
  listWorktags: vi.fn(async () => ({ worktags: [] })),
}));

vi.mock('@/lib/lms94Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lms94Api')>()),
  listCourses: vi.fn(async () => ({ courses: [] })),
  listEnrollments: vi.fn(async () => ({ enrollments: [] })),
  listExpiring: vi.fn(async () => ({ expiring: [] })),
}));

vi.mock('@/lib/learningPaths114Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/learningPaths114Api')>()),
  listLearningPaths: vi.fn(async () => ({ paths: [] })),
  listPathEnrollments: vi.fn(async () => ({ enrollments: [] })),
}));

vi.mock('@/lib/orgApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgApi')>()),
  listOrgAssociates: vi.fn(async () => ({ associates: [] })),
}));

vi.mock('@/lib/internalMobility120Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/internalMobility120Api')>()),
  listInternalJobs: vi.fn(async () => ({ jobs: [] })),
  listMyApplications: vi.fn(async () => ({ applications: [] })),
}));

vi.mock('@/lib/vaccination121Api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/vaccination121Api')>();
  return {
    ...original,
    listVaccinations: vi.fn(async () => ({ records: [] })),
    listExpiringSoon: vi.fn(async () => ({ records: [] })),
    getCoverage: vi.fn(async () => ({
      totalAssociates: 0,
      // Keyed off the real KIND_LABELS so the coverage grid never hits
      // an undefined kind at render time.
      coverage: Object.fromEntries(
        Object.keys(original.KIND_LABELS).map((k) => [k, { count: 0, pct: 0 }]),
      ),
    })),
  };
});

vi.mock('@/lib/agreements122Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agreements122Api')>()),
  listAgreements: vi.fn(async () => ({ agreements: [] })),
  listMyAgreements: vi.fn(async () => ({ agreements: [] })),
}));

vi.mock('@/lib/kb124Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/kb124Api')>()),
  searchKb: vi.fn(async () => ({ articles: [] })),
  getKbCategories: vi.fn(async () => ({ categories: [] })),
  adminListKb: vi.fn(async () => ({ articles: [] })),
}));

vi.mock('@/lib/anonReport128Api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/anonReport128Api')>()),
  listReportQueue: vi.fn(async () => ({ reports: [] })),
  getHotlineSummary: vi.fn(async () => ({
    newCount: 0,
    triagingCount: 0,
    investigatingCount: 0,
    resolvedCount: 0,
    overdueCount: 0,
  })),
}));

vi.mock('@/lib/auditApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auditApi')>()),
  searchAuditLogs: vi.fn(async () => ({ entries: [], nextBefore: null })),
  auditCsvUrl: vi.fn(() => '/api/audit.csv'),
}));

// Page imports come after the mock declarations (vi.mock is hoisted, but
// keeping the visual order honest).
import { WorkflowsHome } from '@/pages/workflows/WorkflowsHome';
import { IntegrationsHome } from '@/pages/integrations/IntegrationsHome';
import { TemplatesHome } from '@/pages/templates/TemplatesHome';
import { WorktagsHome } from '@/pages/worktags/WorktagsHome';
import { LearningHome } from '@/pages/learning/LearningHome';
import { LearningPathsHome } from '@/pages/learningPaths/LearningPathsHome';
import { InternalJobsHome } from '@/pages/internalJobs/InternalJobsHome';
import { VaccinationsHome } from '@/pages/vaccinations/VaccinationsHome';
import { AgreementsHome } from '@/pages/agreements/AgreementsHome';
import { KbHome } from '@/pages/kb/KbHome';
import { HotlineAdmin } from '@/pages/hotline/HotlineAdmin';
import { AuditHome } from '@/pages/audit/AuditHome';

// ---------------------------------------------------------------------------
// House axe harness (mirrors axeSmoke.test.tsx — do not widen this list).
// ---------------------------------------------------------------------------

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

// Admin-ish signed-in user: HR_ADMINISTRATOR holds every capability these
// pages gate on (manage:org, manage:compliance, process:payroll, …), so
// the privileged UI (filters, action buttons) is exercised by axe too.
const ADMIN_USER: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@altohr.com',
  role: 'HR_ADMINISTRATOR',
  status: 'ACTIVE',
  clientId: null,
  associateId: null,
  firstName: 'Ada',
  lastName: 'Admin',
  photoUrl: null,
  timezone: null,
  mfaEnabled: false,
};

const AUTH_VALUE = {
  isInitializing: false,
  isOffline: false,
  user: ADMIN_USER,
  role: ADMIN_USER.role,
  capabilities: ROLE_CAPABILITIES[ADMIN_USER.role],
  signIn: vi.fn(async () => ({ mfaRequired: false })),
  submitMfaChallenge: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  refreshUser: vi.fn(async () => {}),
  can: () => true,
};

function renderPage(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AuthContext.Provider value={AUTH_VALUE}>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ConfirmProvider>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('axe pages — insights / compliance / misc long tail', () => {
  it('<WorkflowsHome> has no axe violations', async () => {
    const { container } = renderPage(<WorkflowsHome />);
    await screen.findByText('No workflows yet');
    await expectNoViolations(container);
  });

  it('<IntegrationsHome> has no axe violations', async () => {
    const { container } = renderPage(<IntegrationsHome />);
    await screen.findByText('No API keys');
    await expectNoViolations(container);
  });

  it('<TemplatesHome> has no axe violations', async () => {
    const { container } = renderPage(<TemplatesHome />);
    await screen.findByText('No templates');
    await expectNoViolations(container);
  });

  it('<WorktagsHome> has no axe violations', async () => {
    const { container } = renderPage(<WorktagsHome />);
    await screen.findByText('No categories');
    await expectNoViolations(container);
  });

  it('<LearningHome> has no axe violations', async () => {
    const { container } = renderPage(<LearningHome />);
    await screen.findByText('No courses');
    await expectNoViolations(container);
  });

  it('<LearningPathsHome> has no axe violations', async () => {
    const { container } = renderPage(<LearningPathsHome />);
    await screen.findByText('No learning paths');
    await expectNoViolations(container);
  });

  it('<InternalJobsHome> has no axe violations', async () => {
    const { container } = renderPage(<InternalJobsHome />);
    await screen.findByText('No open positions');
    await expectNoViolations(container);
  });

  it('<VaccinationsHome> has no axe violations', async () => {
    const { container } = renderPage(<VaccinationsHome />);
    await screen.findByText('No records');
    // Coverage card resolves separately from the records table.
    await screen.findByText(/Coverage across/);
    await expectNoViolations(container);
  });

  it('<AgreementsHome> has no axe violations', async () => {
    const { container } = renderPage(<AgreementsHome />);
    await screen.findByText('No agreements');
    await expectNoViolations(container);
  });

  it('<KbHome> has no axe violations', async () => {
    const { container } = renderPage(<KbHome />);
    await screen.findByText('No articles yet');
    await expectNoViolations(container);
  });

  it('<HotlineAdmin> has no axe violations', async () => {
    const { container } = renderPage(<HotlineAdmin />);
    await screen.findByText('No reports');
    // Summary strip resolves via its own query.
    await screen.findByText('Overdue');
    await expectNoViolations(container);
  });

  it('<AuditHome> has no axe violations', async () => {
    const { container } = renderPage(<AuditHome />);
    await screen.findByText('No audit rows match these filters');
    await expectNoViolations(container);
  });
});
