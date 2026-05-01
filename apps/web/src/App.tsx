import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Login } from '@/pages/Login';
import { NotFound } from '@/pages/NotFound';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';
import { Install } from '@/pages/Install';
import { AcceptInvite } from '@/pages/AcceptInvite';
import { Dashboard } from '@/pages/Dashboard';
import { ModulePlaceholder } from '@/pages/ModulePlaceholder';
import { MODULES } from '@/lib/modules';
import { RequireAuth } from '@/lib/auth';
import { RouterErrorPage } from '@/pages/RouterErrorPage';

// ---------------------------------------------------------------------------
// Code splitting
//
// Every page below is lazy-loaded into its own chunk so the initial JS payload
// is just the chrome (Layout, AuthProvider, sidebar/topbar, design system) +
// the route the user landed on. The pages eagerly imported above are the ones
// the user is guaranteed to hit on the critical path:
//   - Login / AcceptInvite / RouterErrorPage — first paint, must be instant
//   - Layout / RequireAuth — chrome that wraps every authed route
//   - Dashboard — index route, shown immediately after login
//   - ModulePlaceholder — used by ~50 placeholder routes (not worth chunking)
//
// Page modules use named exports (`export function FooPage`), so we adapt them
// for React.lazy() (which expects a default export) via `.then(m => ({ default: m.X }))`.
// ---------------------------------------------------------------------------

function lazyNamed<T extends ComponentType<any>>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string
) {
  return lazy(() =>
    loader().then((mod) => ({ default: mod[exportName] as T }))
  );
}

// Onboarding cluster
const OnboardingHome = lazyNamed(() => import('@/pages/onboarding/OnboardingHome'), 'OnboardingHome');
const ApplicationDetail = lazyNamed(() => import('@/pages/onboarding/ApplicationDetail'), 'ApplicationDetail');
const AssociateChecklist = lazyNamed(() => import('@/pages/onboarding/AssociateChecklist'), 'AssociateChecklist');
const TemplatesList = lazyNamed(() => import('@/pages/onboarding/TemplatesList'), 'TemplatesList');
const TemplateEditor = lazyNamed(() => import('@/pages/onboarding/TemplateEditor'), 'TemplateEditor');
const OnboardingAnalytics = lazyNamed(() => import('@/pages/onboarding/OnboardingAnalytics'), 'OnboardingAnalytics');
const ProfileInfoTask = lazyNamed(() => import('@/pages/onboarding/tasks/ProfileInfoTask'), 'ProfileInfoTask');
const W4Task = lazyNamed(() => import('@/pages/onboarding/tasks/W4Task'), 'W4Task');
const DirectDepositTask = lazyNamed(() => import('@/pages/onboarding/tasks/DirectDepositTask'), 'DirectDepositTask');
const PolicyAckTask = lazyNamed(() => import('@/pages/onboarding/tasks/PolicyAckTask'), 'PolicyAckTask');
const I9Task = lazyNamed(() => import('@/pages/onboarding/tasks/I9Task'), 'I9Task');
const DocumentUploadTask = lazyNamed(() => import('@/pages/onboarding/tasks/DocumentUploadTask'), 'DocumentUploadTask');
const BackgroundCheckTask = lazyNamed(() => import('@/pages/onboarding/tasks/BackgroundCheckTask'), 'BackgroundCheckTask');
const J1DocsTask = lazyNamed(() => import('@/pages/onboarding/tasks/J1DocsTask'), 'J1DocsTask');
const EsignTask = lazyNamed(() => import('@/pages/onboarding/tasks/EsignTask'), 'EsignTask');
const StubTask = lazyNamed(() => import('@/pages/onboarding/tasks/StubTask'), 'StubTask');

// Time / scheduling / payroll
const TimeHome = lazyNamed(() => import('@/pages/time/TimeHome'), 'TimeHome');
const TimeOffHome = lazyNamed(() => import('@/pages/timeoff/TimeOffHome'), 'TimeOffHome');
const SchedulingHome = lazyNamed(() => import('@/pages/scheduling/SchedulingHome'), 'SchedulingHome');
const PayrollHome = lazyNamed(() => import('@/pages/payroll/PayrollHome'), 'PayrollHome');
const PayrollTaxHome = lazyNamed(() => import('@/pages/payrollTax/PayrollTaxHome'), 'PayrollTaxHome');
const PayRulesHome = lazyNamed(() => import('@/pages/payrules/PayRulesHome'), 'PayRulesHome');
const ReimbursementsHome = lazyNamed(() => import('@/pages/reimbursements/ReimbursementsHome'), 'ReimbursementsHome');

// Clients / org / people
const ClientsHome = lazyNamed(() => import('@/pages/clients/ClientsHome'), 'ClientsHome');
const ClientDetail = lazyNamed(() => import('@/pages/clients/ClientDetail'), 'ClientDetail');
const PeopleDirectory = lazyNamed(() => import('@/pages/people/PeopleDirectory'), 'PeopleDirectory');
const OrgHome = lazyNamed(() => import('@/pages/org/OrgHome'), 'OrgHome');
const OrgChart = lazyNamed(() => import('@/pages/org/OrgChart'), 'OrgChart');
const HeadcountHome = lazyNamed(() => import('@/pages/headcount/HeadcountHome'), 'HeadcountHome');
const TeamHome = lazyNamed(() => import('@/pages/team/TeamHome'), 'TeamHome');
const DirCommsHome = lazyNamed(() => import('@/pages/dirComms/DirCommsHome'), 'DirCommsHome');

// Documents / compliance
const DocumentsHome = lazyNamed(() => import('@/pages/documents/DocumentsHome'), 'DocumentsHome');
const ComplianceHome = lazyNamed(() => import('@/pages/compliance/ComplianceHome'), 'ComplianceHome');
const OshaWcEeoHome = lazyNamed(() => import('@/pages/compliance/OshaWcEeoHome'), 'OshaWcEeoHome');
const VaccinationsHome = lazyNamed(() => import('@/pages/vaccinations/VaccinationsHome'), 'VaccinationsHome');
const AgreementsHome = lazyNamed(() => import('@/pages/agreements/AgreementsHome'), 'AgreementsHome');
const ExpirationsHome = lazyNamed(() => import('@/pages/expirations/ExpirationsHome'), 'ExpirationsHome');

// Communications / HR cases
const CommunicationsHome = lazyNamed(() => import('@/pages/communications/CommunicationsHome'), 'CommunicationsHome');
const HrCasesHome = lazyNamed(() => import('@/pages/hrCases/HrCasesHome'), 'HrCasesHome');
const HotlineAdmin = lazyNamed(() => import('@/pages/hotline/HotlineAdmin'), 'HotlineAdmin');

// Performance / recruiting / learning
const PerformanceHome = lazyNamed(() => import('@/pages/performance/PerformanceHome'), 'PerformanceHome');
const PerformanceExtras = lazyNamed(() => import('@/pages/performance/PerformanceExtras'), 'PerformanceExtras');
const RecruitingHome = lazyNamed(() => import('@/pages/recruiting/RecruitingHome'), 'RecruitingHome');
const RecruitingExtras = lazyNamed(() => import('@/pages/recruiting/RecruitingExtras'), 'RecruitingExtras');
const InternalJobsHome = lazyNamed(() => import('@/pages/internalJobs/InternalJobsHome'), 'InternalJobsHome');
const LearningHome = lazyNamed(() => import('@/pages/learning/LearningHome'), 'LearningHome');
const LearningPathsHome = lazyNamed(() => import('@/pages/learningPaths/LearningPathsHome'), 'LearningPathsHome');
const SkillsHome = lazyNamed(() => import('@/pages/skills/SkillsHome'), 'SkillsHome');
const MentorshipHome = lazyNamed(() => import('@/pages/mentorship/MentorshipHome'), 'MentorshipHome');
const SuccessionHome = lazyNamed(() => import('@/pages/succession/SuccessionHome'), 'SuccessionHome');
const ProbationHome = lazyNamed(() => import('@/pages/probation/ProbationHome'), 'ProbationHome');
const DisciplineHome = lazyNamed(() => import('@/pages/discipline/DisciplineHome'), 'DisciplineHome');
const SeparationHome = lazyNamed(() => import('@/pages/separation/SeparationHome'), 'SeparationHome');
const RampHome = lazyNamed(() => import('@/pages/ramp/RampHome'), 'RampHome');
const CareerHome = lazyNamed(() => import('@/pages/career/CareerHome'), 'CareerHome');
const TuitionHome = lazyNamed(() => import('@/pages/tuition/TuitionHome'), 'TuitionHome');
const KbHome = lazyNamed(() => import('@/pages/kb/KbHome'), 'KbHome');

// Benefits / comp / equity
const BenefitsHome = lazyNamed(() => import('@/pages/benefits/BenefitsHome'), 'BenefitsHome');
const BenefitsLifecycle = lazyNamed(() => import('@/pages/benefits/BenefitsLifecycle'), 'BenefitsLifecycle');
const CompensationHome = lazyNamed(() => import('@/pages/compensation/CompensationHome'), 'CompensationHome');
const EquityHome = lazyNamed(() => import('@/pages/equity/EquityHome'), 'EquityHome');
const VtoHome = lazyNamed(() => import('@/pages/vto/VtoHome'), 'VtoHome');

// Misc / admin / me
const Settings = lazyNamed(() => import('@/pages/Settings'), 'Settings');
const AuditHome = lazyNamed(() => import('@/pages/audit/AuditHome'), 'AuditHome');
const AnalyticsHome = lazyNamed(() => import('@/pages/analytics/AnalyticsHome'), 'AnalyticsHome');
const MeHome = lazyNamed(() => import('@/pages/me/MeHome'), 'MeHome');
const CelebrationsHome = lazyNamed(() => import('@/pages/celebrations/CelebrationsHome'), 'CelebrationsHome');
const AssetsHome = lazyNamed(() => import('@/pages/assets/AssetsHome'), 'AssetsHome');
const PulseHome = lazyNamed(() => import('@/pages/pulse/PulseHome'), 'PulseHome');
const HolidaysHome = lazyNamed(() => import('@/pages/holidays/HolidaysHome'), 'HolidaysHome');
const WorkflowsHome = lazyNamed(() => import('@/pages/workflows/WorkflowsHome'), 'WorkflowsHome');
const MarketplaceHome = lazyNamed(() => import('@/pages/marketplace/MarketplaceHome'), 'MarketplaceHome');
const TemplatesHome = lazyNamed(() => import('@/pages/templates/TemplatesHome'), 'TemplatesHome');
const IntegrationsHome = lazyNamed(() => import('@/pages/integrations/IntegrationsHome'), 'IntegrationsHome');
const WorktagsHome = lazyNamed(() => import('@/pages/worktags/WorktagsHome'), 'WorktagsHome');
const ReportsHome = lazyNamed(() => import('@/pages/reports/ReportsHome'), 'ReportsHome');

// Public, no-Layout pages — lazy too. face-api lives in the kiosk chunk.
const KioskPage = lazyNamed(() => import('@/pages/kiosk/KioskPage'), 'KioskPage');
const KioskAdmin = lazyNamed(() => import('@/pages/kiosk/KioskAdmin'), 'KioskAdmin');
const HotlinePage = lazyNamed(() => import('@/pages/hotline/HotlinePage'), 'HotlinePage');

// Tiny in-page fallback for top-level (no-Layout) routes while their chunk
// streams in. The Layout has its own Suspense around <Outlet />.
function PublicRouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-midnight">
      <div
        className="h-10 w-10 rounded-full border-2 border-gold/30 border-t-gold animate-spin"
        aria-label="Loading"
      />
    </div>
  );
}

const ONBOARDING_ROUTES = [
  { path: 'onboarding', element: <OnboardingHome /> },
  // Phase 61 — template manager (HR/Ops only; component enforces).
  { path: 'onboarding/templates', element: <TemplatesList /> },
  { path: 'onboarding/templates/new', element: <TemplateEditor /> },
  { path: 'onboarding/templates/:id', element: <TemplateEditor /> },
  // Phase 62 — time-to-completion analytics (view:dashboard required).
  { path: 'onboarding/analytics', element: <OnboardingAnalytics /> },
  {
    path: 'onboarding/applications/:id',
    element: <ApplicationDetail />,
  },
  {
    path: 'onboarding/me/:applicationId',
    element: <AssociateChecklist />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/profile_info',
    element: <ProfileInfoTask />,
  },
  { path: 'onboarding/me/:applicationId/tasks/w4', element: <W4Task /> },
  {
    path: 'onboarding/me/:applicationId/tasks/direct_deposit',
    element: <DirectDepositTask />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/policy_ack',
    element: <PolicyAckTask />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/i9_verification',
    element: <I9Task />,
  },
  // Phase 63 — three previously-stubbed tasks are now real.
  {
    path: 'onboarding/me/:applicationId/tasks/document_upload',
    element: <DocumentUploadTask />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/background_check',
    element: <BackgroundCheckTask />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/j1_docs',
    element: <J1DocsTask />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/e_sign',
    element: <EsignTask />,
  },
  // Catch-all for any kind we still haven't wired.
  {
    path: 'onboarding/me/:applicationId/tasks/:taskKind',
    element: <StubTask />,
  },
];

const PLACEHOLDER_MODULES = MODULES.filter(
  (m) =>
    m.key !== 'onboarding' &&
    m.key !== 'time-attendance' &&
    m.key !== 'kiosk' &&
    m.key !== 'time-off' &&
    m.key !== 'scheduling' &&
    m.key !== 'payroll' &&
    m.key !== 'documents' &&
    m.key !== 'compliance' &&
    m.key !== 'communications' &&
    m.key !== 'performance' &&
    m.key !== 'recruiting' &&
    m.key !== 'clients' &&
    m.key !== 'analytics' &&
    m.key !== 'audit' &&
    m.key !== 'benefits' &&
    m.key !== 'org' &&
    m.key !== 'org-chart' &&
    m.key !== 'people' &&
    m.key !== 'celebrations' &&
    m.key !== 'assets' &&
    m.key !== 'pulse' &&
    m.key !== 'headcount' &&
    m.key !== 'skills' &&
    m.key !== 'mentorship' &&
    m.key !== 'expirations' &&
    m.key !== 'learning-paths' &&
    m.key !== 'team' &&
    m.key !== 'workflows' &&
    m.key !== 'me' &&
    m.key !== 'compensation' &&
    m.key !== 'marketplace' &&
    m.key !== 'payrules' &&
    m.key !== 'dircomms' &&
    m.key !== 'succession' &&
    m.key !== 'probation' &&
    m.key !== 'holidays' &&
    m.key !== 'discipline' &&
    m.key !== 'separations' &&
    m.key !== 'internal-jobs' &&
    m.key !== 'vaccinations' &&
    m.key !== 'agreements' &&
    m.key !== 'hr-cases' &&
    m.key !== 'help-center' &&
    m.key !== 'ramp' &&
    m.key !== 'career' &&
    m.key !== 'tuition' &&
    m.key !== 'hotline' &&
    m.key !== 'equity' &&
    m.key !== 'volunteer'
);

export const router = createBrowserRouter([
  { path: '/login', element: <Login />, errorElement: <RouterErrorPage /> },
  // Self-serve password reset — public, two-step flow. /forgot-password
  // takes an email and emails a magic link; /reset-password/:token
  // accepts the new password.
  { path: '/forgot-password', element: <ForgotPassword />, errorElement: <RouterErrorPage /> },
  { path: '/reset-password/:token', element: <ResetPassword />, errorElement: <RouterErrorPage /> },
  // Public landing for "add this app to your home screen" — no auth, so we
  // can drop the link in invite emails before the associate has a password.
  { path: '/install', element: <Install />, errorElement: <RouterErrorPage /> },
  {
    path: '/accept-invite/:token',
    element: <AcceptInvite />,
    errorElement: <RouterErrorPage />,
  },
  // Phase 99 — public kiosk page. No auth, no Layout — full-screen.
  // face-api.js (~6 MB uncompressed) lives in this chunk and only loads here.
  {
    path: '/kiosk',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <KioskPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // Phase 128 — public anonymous reporting / hotline. No auth, no Layout —
  // shoulder-surfing privacy: nothing on screen identifies the reporter.
  {
    path: '/hotline',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <HotlinePage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    errorElement: <RouterErrorPage />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'time-attendance', element: <TimeHome /> },
      { path: 'time-off', element: <TimeOffHome /> },
      { path: 'clients', element: <ClientsHome /> },
      { path: 'clients/:id', element: <ClientDetail /> },
      { path: 'scheduling', element: <SchedulingHome /> },
      { path: 'payroll', element: <PayrollHome /> },
      { path: 'documents', element: <DocumentsHome /> },
      { path: 'compliance', element: <ComplianceHome /> },
      { path: 'communications', element: <CommunicationsHome /> },
      { path: 'performance', element: <PerformanceHome /> },
      { path: 'recruiting', element: <RecruitingHome /> },
      { path: 'analytics', element: <AnalyticsHome /> },
      { path: 'settings', element: <Settings /> },
      { path: 'audit', element: <AuditHome /> },
      { path: 'benefits', element: <BenefitsHome /> },
      { path: 'people', element: <PeopleDirectory /> },
      { path: 'org', element: <OrgHome /> },
      { path: 'org/chart', element: <OrgChart /> },
      { path: 'celebrations', element: <CelebrationsHome /> },
      { path: 'assets', element: <AssetsHome /> },
      { path: 'pulse', element: <PulseHome /> },
      { path: 'headcount', element: <HeadcountHome /> },
      { path: 'skills', element: <SkillsHome /> },
      { path: 'mentorship', element: <MentorshipHome /> },
      { path: 'expirations', element: <ExpirationsHome /> },
      { path: 'learning-paths', element: <LearningPathsHome /> },
      { path: 'succession', element: <SuccessionHome /> },
      { path: 'probation', element: <ProbationHome /> },
      { path: 'holidays', element: <HolidaysHome /> },
      { path: 'discipline', element: <DisciplineHome /> },
      { path: 'separations', element: <SeparationHome /> },
      { path: 'internal-jobs', element: <InternalJobsHome /> },
      { path: 'vaccinations', element: <VaccinationsHome /> },
      { path: 'agreements', element: <AgreementsHome /> },
      { path: 'hr-cases', element: <HrCasesHome /> },
      { path: 'help-center', element: <KbHome /> },
      { path: 'ramp', element: <RampHome /> },
      { path: 'career', element: <CareerHome /> },
      { path: 'tuition', element: <TuitionHome /> },
      { path: 'hotline-admin', element: <HotlineAdmin /> },
      { path: 'equity', element: <EquityHome /> },
      { path: 'volunteer', element: <VtoHome /> },
      { path: 'team', element: <TeamHome /> },
      { path: 'workflows', element: <WorkflowsHome /> },
      { path: 'me', element: <MeHome /> },
      { path: 'compensation', element: <CompensationHome /> },
      { path: 'performance/extras', element: <PerformanceExtras /> },
      { path: 'marketplace', element: <MarketplaceHome /> },
      { path: 'payrules', element: <PayRulesHome /> },
      { path: 'directory', element: <DirCommsHome /> },
      { path: 'compliance/osha', element: <OshaWcEeoHome /> },
      { path: 'templates', element: <TemplatesHome /> },
      { path: 'recruiting/extras', element: <RecruitingExtras /> },
      { path: 'payroll/tax', element: <PayrollTaxHome /> },
      { path: 'benefits/lifecycle', element: <BenefitsLifecycle /> },
      { path: 'integrations', element: <IntegrationsHome /> },
      { path: 'learning', element: <LearningHome /> },
      { path: 'worktags', element: <WorktagsHome /> },
      { path: 'reports', element: <ReportsHome /> },
      { path: 'reimbursements', element: <ReimbursementsHome /> },
      { path: 'time-attendance/kiosk', element: <KioskAdmin /> },
      ...ONBOARDING_ROUTES,
      ...PLACEHOLDER_MODULES.map((m) => ({
        path: m.path.replace(/^\//, ''),
        element: (
          <ModulePlaceholder
            moduleKey={m.key}
            title={m.label}
            description={m.description}
          />
        ),
      })),
      // Catch-all for unmatched authenticated routes — render a styled
      // 404 inside the Layout so the user keeps sidebar/topbar context
      // and can navigate away. Previously this silently bounced to "/",
      // leaving users wondering if their click did anything.
      { path: '*', element: <NotFound /> },
    ],
  },
  // Catch-all outside the Layout — RequireAuth will bounce unauthenticated
  // users to /login. Authenticated users hit the in-Layout 404 above.
  {
    path: '*',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    errorElement: <RouterErrorPage />,
    children: [{ index: true, element: <NotFound /> }],
  },
]);
