import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Login } from '@/pages/Login';
import { AcceptInvite } from '@/pages/AcceptInvite';
import { Dashboard } from '@/pages/Dashboard';
import { ModulePlaceholder } from '@/pages/ModulePlaceholder';
import { MODULES } from '@/lib/modules';
import { RequireAuth } from '@/lib/auth';
import { OnboardingHome } from '@/pages/onboarding/OnboardingHome';
import { ApplicationDetail } from '@/pages/onboarding/ApplicationDetail';
import { AssociateChecklist } from '@/pages/onboarding/AssociateChecklist';
import { TemplatesList } from '@/pages/onboarding/TemplatesList';
import { TemplateEditor } from '@/pages/onboarding/TemplateEditor';
import { OnboardingAnalytics } from '@/pages/onboarding/OnboardingAnalytics';
import { ProfileInfoTask } from '@/pages/onboarding/tasks/ProfileInfoTask';
import { W4Task } from '@/pages/onboarding/tasks/W4Task';
import { DirectDepositTask } from '@/pages/onboarding/tasks/DirectDepositTask';
import { PolicyAckTask } from '@/pages/onboarding/tasks/PolicyAckTask';
import { I9Task } from '@/pages/onboarding/tasks/I9Task';
import { DocumentUploadTask } from '@/pages/onboarding/tasks/DocumentUploadTask';
import { BackgroundCheckTask } from '@/pages/onboarding/tasks/BackgroundCheckTask';
import { J1DocsTask } from '@/pages/onboarding/tasks/J1DocsTask';
import { StubTask } from '@/pages/onboarding/tasks/StubTask';
import { TimeHome } from '@/pages/time/TimeHome';
import { TimeOffHome } from '@/pages/timeoff/TimeOffHome';
import { ClientsHome } from '@/pages/clients/ClientsHome';
import { ClientDetail } from '@/pages/clients/ClientDetail';
import { SchedulingHome } from '@/pages/scheduling/SchedulingHome';
import { PayrollHome } from '@/pages/payroll/PayrollHome';
import { DocumentsHome } from '@/pages/documents/DocumentsHome';
import { ComplianceHome } from '@/pages/compliance/ComplianceHome';
import { CommunicationsHome } from '@/pages/communications/CommunicationsHome';
import { PerformanceHome } from '@/pages/performance/PerformanceHome';
import { RecruitingHome } from '@/pages/recruiting/RecruitingHome';
import { AnalyticsHome } from '@/pages/analytics/AnalyticsHome';
import { Settings } from '@/pages/Settings';
import { AuditHome } from '@/pages/audit/AuditHome';
import { BenefitsHome } from '@/pages/benefits/BenefitsHome';
import { OrgHome } from '@/pages/org/OrgHome';
import { TeamHome } from '@/pages/team/TeamHome';
import { WorkflowsHome } from '@/pages/workflows/WorkflowsHome';
import { RouterErrorPage } from '@/pages/RouterErrorPage';

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
  // Catch-all for any kind we still haven't wired (E_SIGN routes through
  // the application detail's e-sign panel, not a /me/ form).
  {
    path: 'onboarding/me/:applicationId/tasks/:taskKind',
    element: <StubTask />,
  },
];

const PLACEHOLDER_MODULES = MODULES.filter(
  (m) =>
    m.key !== 'onboarding' &&
    m.key !== 'time-attendance' &&
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
    m.key !== 'team' &&
    m.key !== 'workflows'
);

export const router = createBrowserRouter([
  { path: '/login', element: <Login />, errorElement: <RouterErrorPage /> },
  {
    path: '/accept-invite/:token',
    element: <AcceptInvite />,
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
      { path: 'org', element: <OrgHome /> },
      { path: 'team', element: <TeamHome /> },
      { path: 'workflows', element: <WorkflowsHome /> },
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
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
