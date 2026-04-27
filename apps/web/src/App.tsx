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
import { ProfileInfoTask } from '@/pages/onboarding/tasks/ProfileInfoTask';
import { W4Task } from '@/pages/onboarding/tasks/W4Task';
import { DirectDepositTask } from '@/pages/onboarding/tasks/DirectDepositTask';
import { PolicyAckTask } from '@/pages/onboarding/tasks/PolicyAckTask';
import { I9Task } from '@/pages/onboarding/tasks/I9Task';
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

const ONBOARDING_ROUTES = [
  { path: 'onboarding', element: <OnboardingHome /> },
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
    m.key !== 'audit'
);

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/accept-invite/:token', element: <AcceptInvite /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
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
