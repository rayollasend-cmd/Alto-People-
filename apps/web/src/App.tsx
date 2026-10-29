import { isValidElement, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, createBrowserRouter, matchRoutes } from 'react-router-dom';
import type { AuthUser } from '@alto-people/shared';
// PERF: the Layout is authenticated-only chrome — Sidebar, Topbar, MobileNav,
// BottomTabBar, CommandPalette (and cmdk with it), WhatsNew, InstallPrompt,
// the SSE live-events client. Importing it eagerly put all of that in the
// blocking `main` chunk, so someone sitting on /login downloaded the entire
// signed-in shell before they could type a password. It sits behind
// RequireAuth, which already renders a splash while /auth/me resolves, so
// there is a natural loading window to stream it in.
import { Login } from '@/pages/Login';
import { NotFound } from '@/pages/NotFound';
import { Dashboard, preloadDashboard } from '@/pages/Dashboard';
import { RequireAuth, useAuth } from '@/lib/auth';
import { RequireCapability } from '@/lib/RequireCapability';
import { OperatorOnly } from '@/lib/OperatorOnly';
import { registerPrefetch, registerDataPrefetch } from '@/lib/prefetch';
import { queryClient } from '@/lib/queryClient';
import { trackChunk } from '@/lib/chunkLoading';
import { importSidebar, SIDEBAR_QUERY } from '@/components/ShellSidebar';
import { directoryQuery } from '@/lib/directoryApi';
import { listClients } from '@/lib/clientsApi';
import { PROSPECTS_KEY, listProspects } from '@/lib/prospectsApi';
import { RouterErrorPage } from '@/pages/RouterErrorPage';
import { LegacyPayrollRedirect } from '@/pages/payroll/legacyPayrollRoutes';

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
//
// Every module in lib/modules has an explicit route below (navCoverage.test
// keeps it that way); there are no placeholder routes.
//
// Page modules use named exports (`export function FooPage`), so we adapt them
// for React.lazy() (which expects a default export) via `.then(m => ({ default: m.X }))`.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bound mirrors React.lazy's own
function lazyNamed<T extends ComponentType<any>>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string
) {
  // trackChunk publishes "a page is on the wire" so the chrome's top
  // progress bar has something real to read. React Router can't tell us —
  // no route here declares a loader, so its navigation state never leaves
  // 'idle' and anything driving off it never fires.
  // One promise per page: preload() (warmSignedInStart) and the render share it.
  let chunk: Promise<{ default: T }> | null = null;
  const load = () => (chunk ??= trackChunk(loader).then((mod) => ({ default: mod[exportName] as T })));
  return Object.assign(lazy(load), {
    preload: () => {
      void load().catch(() => undefined);
    },
  });
}

/** Start every lazy page an element tree renders (a route's element, through its gates). */
function preloadElement(node: ReactNode, depth = 0): void {
  if (depth > 6 || !isValidElement(node)) return;
  const type = node.type as { preload?: () => void };
  type.preload?.();
  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) preloadElement(child, depth + 1);
}

// Pages a signed-in person never opens (password reset, invites, the install
// landing) used to ride in the main bundle every page downloads; Login stays
// eager — it is the page a signed-out visitor paints first.
const ForgotPassword = lazyNamed(() => import('@/pages/ForgotPassword'), 'ForgotPassword');
const ResetPassword = lazyNamed(() => import('@/pages/ResetPassword'), 'ResetPassword');
const ConfirmEmailChange = lazyNamed(() => import('@/pages/ConfirmEmailChange'), 'ConfirmEmailChange');
const Install = lazyNamed(() => import('@/pages/Install'), 'Install');
const AcceptInvite = lazyNamed(() => import('@/pages/AcceptInvite'), 'AcceptInvite');

const loadLayout = () => import('@/components/Layout');
const Layout = lazyNamed(loadLayout, 'Layout');

// Onboarding cluster
const OnboardingHome = lazyNamed(() => import('@/pages/onboarding/OnboardingHome'), 'OnboardingHome');
const ApplicationDetail = lazyNamed(() => import('@/pages/onboarding/ApplicationDetail'), 'ApplicationDetail');
const InPersonOnboarding = lazyNamed(() => import('@/pages/onboarding/InPersonOnboarding'), 'InPersonOnboarding');
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
const ProfilePhotoTask = lazyNamed(() => import('@/pages/onboarding/tasks/ProfilePhotoTask'), 'ProfilePhotoTask');
const AvailabilityTask = lazyNamed(() => import('@/pages/onboarding/tasks/AvailabilityTask'), 'AvailabilityTask');

// Time / scheduling / payroll
const TimeHome = lazyNamed(() => import('@/pages/time/TimeHome'), 'TimeHome');
const FieldglassSetup = lazyNamed(() => import('@/pages/fieldglass/FieldglassSetup'), 'FieldglassSetup');
const TimesheetHistory = lazyNamed(
  () => import('@/pages/time/TimesheetHistory'),
  'TimesheetHistory',
);
const TimesheetsView = lazyNamed(
  () => import('@/pages/time/TimesheetsView'),
  'TimesheetsView',
);
const TimeOffHome = lazyNamed(() => import('@/pages/timeoff/TimeOffHome'), 'TimeOffHome');
const SchedulingHome = lazyNamed(() => import('@/pages/scheduling/SchedulingHome'), 'SchedulingHome');
const LaborCostsHome = lazyNamed(() => import('@/pages/scheduling/LaborCostsHome'), 'LaborCostsHome');
const SupervisorCorps = lazyNamed(() => import('@/pages/scheduling/SupervisorCorps'), 'SupervisorCorps');
const CoverageBoard = lazyNamed(() => import('@/pages/scheduling/CoverageBoard'), 'CoverageBoard');
const OpsHome = lazyNamed(() => import('@/pages/ops/OpsHome'), 'OpsHome');
const RideHome = lazyNamed(() => import('@/pages/transport/RideHome'), 'RideHome');
const TransportHome = lazyNamed(() => import('@/pages/transport/TransportHome'), 'TransportHome');
const EmergencyHome = lazyNamed(() => import('@/pages/emergency/EmergencyHome'), 'EmergencyHome');
const ApprovalsHome = lazyNamed(() => import('@/pages/approvals/ApprovalsHome'), 'ApprovalsHome');
const InboxHome = lazyNamed(() => import('@/pages/inbox/InboxHome'), 'InboxHome');
const DecisionOpen = lazyNamed(() => import('@/pages/inbox/DecisionOpen'), 'DecisionOpen');
const PayrollHome = lazyNamed(() => import('@/pages/payroll/PayrollHome'), 'PayrollHome');
// Federal / state / local tax reference in one place (F500 G3); /payroll/config, /state-tax and /tax-jurisdictions redirect here.
const TaxTablesPage = lazyNamed(() => import('@/pages/payroll/TaxTablesPage'), 'TaxTablesPage');
const FinancialChangesQueue = lazyNamed(
  () => import('@/pages/payroll/FinancialChangesQueue'),
  'FinancialChangesQueue',
);
const PayrollReadiness = lazyNamed(
  () => import('@/pages/payroll/PayrollReadiness'),
  'PayrollReadiness',
);
const PayrollYtd = lazyNamed(() => import('@/pages/payroll/PayrollYtd'), 'PayrollYtd');
const RunRecordPage = lazyNamed(() => import('@/pages/payroll/RunRecordPage'), 'RunRecordPage');
const PaySchedulesPage = lazyNamed(() => import('@/pages/payroll/schedules/PaySchedulesPage'), 'PaySchedulesPage');
const NewPaySchedulePage = lazyNamed(() => import('@/pages/payroll/schedules/NewPaySchedulePage'), 'NewPaySchedulePage');
const PayScheduleDetailPage = lazyNamed(() => import('@/pages/payroll/schedules/PayScheduleDetailPage'), 'PayScheduleDetailPage');
const PayrollReviewsPage = lazyNamed(() => import('@/pages/payroll/PayrollReviewsPage'), 'PayrollReviewsPage');
const EarnedWageDesk = lazyNamed(() => import('@/pages/payroll/EarnedWageDesk'), 'EarnedWageDesk');
const DailyPayDesk = lazyNamed(() => import('@/pages/payroll/DailyPayDesk'), 'DailyPayDesk');
const ManualChecksPage = lazyNamed(() => import('@/pages/payroll/ManualChecksPage'), 'ManualChecksPage');
const PayChecksPage = lazyNamed(() => import('@/pages/payroll/PayChecksPage'), 'PayChecksPage');
const W4Estimator = lazyNamed(() => import('@/pages/payroll/W4Estimator'), 'W4Estimator');
const WotcDesk = lazyNamed(() => import('@/pages/payroll/WotcDesk'), 'WotcDesk');
const AcaHours = lazyNamed(() => import('@/pages/benefits/AcaHours'), 'AcaHours');
const WotcScreeningTask = lazyNamed(() => import('@/pages/onboarding/tasks/WotcScreeningTask'), 'WotcScreeningTask');
const CashForecastPage = lazyNamed(() => import('@/pages/finance/CashForecastPage'), 'CashForecastPage');
const PayrollGoLivePage = lazyNamed(() => import('@/pages/payroll/PayrollGoLivePage'), 'PayrollGoLivePage');
const BooksHome = lazyNamed(() => import('@/pages/books/BooksHome'), 'BooksHome');
const BooksReportsPage = lazyNamed(() => import('@/pages/books/reports/BooksReportsPage'), 'BooksReportsPage');
const JournalPage = lazyNamed(() => import('@/pages/books/ledger/JournalPage'), 'JournalPage');
const JournalEntryPage = lazyNamed(() => import('@/pages/books/ledger/JournalEntryPage'), 'JournalEntryPage');
const AccountsPage = lazyNamed(() => import('@/pages/books/ledger/AccountsPage'), 'AccountsPage');
const AccountDetailPage = lazyNamed(() => import('@/pages/books/ledger/AccountDetailPage'), 'AccountDetailPage');
const ReceivablesPage = lazyNamed(() => import('@/pages/books/receivables/ReceivablesPage'), 'ReceivablesPage');
const BillsPage = lazyNamed(() => import('@/pages/books/payables/BillsPage'), 'BillsPage');
const BillDetailPage = lazyNamed(() => import('@/pages/books/payables/BillDetailPage'), 'BillDetailPage');
const VendorsPage = lazyNamed(() => import('@/pages/books/payables/VendorsPage'), 'VendorsPage');
const VendorDetailPage = lazyNamed(() => import('@/pages/books/payables/VendorDetailPage'), 'VendorDetailPage');
const BankPage = lazyNamed(() => import('@/pages/books/bank/BankPage'), 'BankPage');
const BankAccountPage = lazyNamed(() => import('@/pages/books/bank/BankAccountPage'), 'BankAccountPage');
const ReconcilePage = lazyNamed(() => import('@/pages/books/bank/ReconcilePage'), 'ReconcilePage');
const ClosePage = lazyNamed(() => import('@/pages/books/close/ClosePage'), 'ClosePage');
const ClosePeriodPage = lazyNamed(() => import('@/pages/books/close/ClosePeriodPage'), 'ClosePeriodPage');
const BudgetsPage = lazyNamed(() => import('@/pages/books/budgets/BudgetsPage'), 'BudgetsPage');
const BudgetDetailPage = lazyNamed(() => import('@/pages/books/budgets/BudgetDetailPage'), 'BudgetDetailPage');
const FixedAssetsPage = lazyNamed(() => import('@/pages/books/assets/FixedAssetsPage'), 'FixedAssetsPage');
const FixedAssetDetailPage = lazyNamed(() => import('@/pages/books/assets/FixedAssetDetailPage'), 'FixedAssetDetailPage');
const QuickbooksSyncPage = lazyNamed(() => import('@/pages/books/quickbooks/QuickbooksSyncPage'), 'QuickbooksSyncPage');
const PayBillPage = lazyNamed(() => import('@/pages/finance/PayBillPage'), 'PayBillPage');
const MarketRatesHome = lazyNamed(() => import('@/pages/market/MarketRatesHome'), 'MarketRatesHome');
const LaborRulesPage = lazyNamed(() => import('@/pages/payroll/LaborRulesPage'), 'LaborRulesPage');
// Year-end in one place (F500 G3): checklist, reconciliation and forms; the old pages redirect here.
const YearEndPage = lazyNamed(() => import('@/pages/payroll/YearEndPage'), 'YearEndPage');
const W4SsnRecollection = lazyNamed(
  () => import('@/pages/payroll/W4SsnRecollection'),
  'W4SsnRecollection',
);
const PayrollTaxesDesk = lazyNamed(() => import('@/pages/payrollTaxes/PayrollTaxesDesk'), 'PayrollTaxesDesk');
const CertifiedPayrollDesk = lazyNamed(() => import('@/pages/certifiedPayroll/CertifiedPayrollDesk'), 'CertifiedPayrollDesk');
const GarnishmentDesk = lazyNamed(() => import('@/pages/deductions/GarnishmentDesk'), 'GarnishmentDesk');
const RetirementPlans = lazyNamed(() => import('@/pages/deductions/RetirementPlans'), 'RetirementPlans');
const CarrierFeeds = lazyNamed(() => import('@/pages/deductions/CarrierFeeds'), 'CarrierFeeds');
const CertifiedProject = lazyNamed(() => import('@/pages/certifiedPayroll/CertifiedProject'), 'CertifiedProject');
const CertifiedWeek = lazyNamed(() => import('@/pages/certifiedPayroll/CertifiedWeek'), 'CertifiedWeek');
const ContractorsDesk = lazyNamed(() => import('@/pages/contractors/ContractorsDesk'), 'ContractorsDesk');
const PayrollBankingPage = lazyNamed(() => import('@/pages/payrollBanking/PayrollBankingPage'), 'PayrollBankingPage');
const PayrollCompliance = lazyNamed(
  () => import('@/pages/payroll/PayrollCompliance'),
  'PayrollCompliance',
);
const PayRulesHome = lazyNamed(() => import('@/pages/payrules/PayRulesHome'), 'PayRulesHome');
const ReimbursementsHome = lazyNamed(() => import('@/pages/reimbursements/ReimbursementsHome'), 'ReimbursementsHome');

// Clients / org / people
const ClientsHome = lazyNamed(() => import('@/pages/clients/ClientsHome'), 'ClientsHome');
const ClientPortalHome = lazyNamed(() => import('@/pages/portal/ClientPortalHome'), 'ClientPortalHome');
const PortalSchedule = lazyNamed(() => import('@/pages/portal/PortalSchedule'), 'PortalSchedule');
const PortalToday = lazyNamed(() => import('@/pages/portal/PortalToday'), 'PortalToday');
const PortalRequestsPage = lazyNamed(() => import('@/pages/portal/PortalRequestsPage'), 'PortalRequestsPage');
const PortalHistory = lazyNamed(() => import('@/pages/portal/PortalHistory'), 'PortalHistory');
const PortalOps = lazyNamed(() => import('@/pages/portal/PortalOps'), 'PortalOps');
const PortalCandidates = lazyNamed(() => import('@/pages/portal/PortalCandidates'), 'PortalCandidates');
const MessagesHome = lazyNamed(() => import('@/pages/messages/MessagesHome'), 'MessagesHome');
const RegionHome = lazyNamed(() => import('@/pages/region/RegionHome'), 'RegionHome');
const WorkerTypesAdmin = lazyNamed(() => import('@/pages/admin/WorkerTypesAdmin'), 'WorkerTypesAdmin');
const AgentRegistryAdmin = lazyNamed(() => import('@/pages/admin/AgentRegistryAdmin'), 'AgentRegistryAdmin');
const AgentRecordPage = lazyNamed(() => import('@/pages/admin/AgentRecordPage'), 'AgentRecordPage');
const AgentGovernance = lazyNamed(() => import('@/pages/admin/AgentGovernance'), 'AgentGovernance');
const ClientDetail = lazyNamed(() => import('@/pages/clients/ClientDetail'), 'ClientDetail');
const ClientStatementsRollup = lazyNamed(() => import('@/pages/clients/ClientStatementsRollup'), 'ClientStatementsRollup');
const PipelinePage = lazyNamed(() => import('@/pages/clients/PipelinePage'), 'PipelinePage');
const PeopleDirectory = lazyNamed(() => import('@/pages/people/PeopleDirectory'), 'PeopleDirectory');
const PersonRecord = lazyNamed(() => import('@/pages/people/PersonRecord'), 'PersonRecord');
const OrgHome = lazyNamed(() => import('@/pages/org/OrgHome'), 'OrgHome');
const NativeHandoff = lazyNamed(() => import('@/pages/NativeHandoff'), 'NativeHandoff');
const OrgChart = lazyNamed(() => import('@/pages/org/OrgChart'), 'OrgChart');
const CallOutsDesk = lazyNamed(() => import('@/pages/callouts/CallOutsDesk'), 'CallOutsDesk');
const RetentionDesk = lazyNamed(() => import('@/pages/retention/RetentionDesk'), 'RetentionDesk');
const HeadcountHome = lazyNamed(() => import('@/pages/headcount/HeadcountHome'), 'HeadcountHome');
const HeadcountPlan = lazyNamed(() => import('@/pages/headcount/HeadcountPlan'), 'HeadcountPlan');
const MassUpdate = lazyNamed(() => import('@/pages/people/MassUpdate'), 'MassUpdate');
const PolicyCampaignsHome = lazyNamed(() => import('@/pages/compliance/PolicyCampaignsHome'), 'PolicyCampaignsHome');
const PeopleAnalytics = lazyNamed(() => import('@/pages/reports/PeopleAnalytics'), 'PeopleAnalytics');
const DocumentRetentionAdmin = lazyNamed(() => import('@/pages/admin/DocumentRetentionAdmin'), 'DocumentRetentionAdmin');
const TeamHome = lazyNamed(() => import('@/pages/team/TeamHome'), 'TeamHome');
const DirCommsHome = lazyNamed(() => import('@/pages/dirComms/DirCommsHome'), 'DirCommsHome');

// Documents / compliance
const DocumentsHome = lazyNamed(() => import('@/pages/documents/DocumentsHome'), 'DocumentsHome');
const ComplianceHome = lazyNamed(() => import('@/pages/compliance/ComplianceHome'), 'ComplianceHome');
const ProgramsHome = lazyNamed(() => import('@/pages/programs/ProgramsHome'), 'ProgramsHome');
const SeasonPlannerHome = lazyNamed(() => import('@/pages/planner/SeasonPlannerHome'), 'SeasonPlannerHome');
const ForecastHome = lazyNamed(() => import('@/pages/forecast/ForecastHome'), 'ForecastHome');
const OshaWcEeoHome = lazyNamed(() => import('@/pages/compliance/OshaWcEeoHome'), 'OshaWcEeoHome');
const VaccinationsHome = lazyNamed(() => import('@/pages/vaccinations/VaccinationsHome'), 'VaccinationsHome');
const AgreementsHome = lazyNamed(() => import('@/pages/agreements/AgreementsHome'), 'AgreementsHome');
const ExpirationsHome = lazyNamed(() => import('@/pages/expirations/ExpirationsHome'), 'ExpirationsHome');

// Communications / HR cases
const CommunicationsHome = lazyNamed(() => import('@/pages/communications/CommunicationsHome'), 'CommunicationsHome');
const HrCasesHome = lazyNamed(() => import('@/pages/hrCases/HrCasesHome'), 'HrCasesHome');
const LeaveHome = lazyNamed(() => import('@/pages/leave/LeaveHome'), 'LeaveHome');
const UnemploymentClaimsHome = lazyNamed(() => import('@/pages/claims/UnemploymentClaimsHome'), 'UnemploymentClaimsHome');
const WorkersCompHome = lazyNamed(() => import('@/pages/claims/WorkersCompHome'), 'WorkersCompHome');
const RelayBoard = lazyNamed(() => import('@/pages/relay/RelayBoard'), 'RelayBoard');
const HotlineAdmin = lazyNamed(() => import('@/pages/hotline/HotlineAdmin'), 'HotlineAdmin');

// Performance / recruiting / learning
const PerformanceHome = lazyNamed(() => import('@/pages/performance/PerformanceHome'), 'PerformanceHome');
const PerformanceExtras = lazyNamed(() => import('@/pages/performance/PerformanceExtras'), 'PerformanceExtras');
const ReviewCalibration = lazyNamed(() => import('@/pages/performance/ReviewCalibration'), 'ReviewCalibration');
const RecruitingHome = lazyNamed(() => import('@/pages/recruiting/RecruitingHome'), 'RecruitingHome');
const RecruitingExtras = lazyNamed(() => import('@/pages/recruiting/RecruitingExtras'), 'RecruitingExtras');
const RecruitingAnalytics = lazyNamed(() => import('@/pages/recruiting/RecruitingAnalytics'), 'RecruitingAnalytics');
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
const WhatsNewPage = lazyNamed(() => import('@/pages/WhatsNewPage'), 'WhatsNewPage');
const UsersAdmin = lazyNamed(() => import('@/pages/admin/UsersAdmin'), 'UsersAdmin');
const RolesPage = lazyNamed(() => import('@/pages/admin/RolesPage'), 'RolesPage');
const BrandingHome = lazyNamed(() => import('@/pages/admin/BrandingHome'), 'BrandingHome');
// F500 G4: the settings that were misfiled on Branding, each in its own Settings page.
const FinanceSettingsPage = lazyNamed(() => import('@/pages/admin/FinanceSettingsPage'), 'FinanceSettingsPage');
const ApprovalRulesPage = lazyNamed(() => import('@/pages/admin/ApprovalRulesPage'), 'ApprovalRulesPage');
const TenantProfileHome = lazyNamed(() => import('@/pages/admin/TenantProfileHome'), 'TenantProfileHome');
const SettingsHome = lazyNamed(() => import('@/pages/admin/SettingsHome'), 'SettingsHome');
const SignInSettings = lazyNamed(() => import('@/pages/admin/SignInSettings'), 'SignInSettings');
const AccessCertifications = lazyNamed(() => import('@/pages/admin/AccessCertifications'), 'AccessCertifications');
const AccessCertificationPage = lazyNamed(() => import('@/pages/admin/AccessCertifications'), 'AccessCertificationPage');
const SupportPage = lazyNamed(() => import('@/pages/support/SupportPage'), 'SupportPage');
const PlatformSupportInbox = lazyNamed(() => import('@/pages/support/PlatformSupportInbox'), 'PlatformSupportInbox');
const EmployersAdmin = lazyNamed(() => import('@/pages/admin/EmployersAdmin'), 'EmployersAdmin');
const OrgUnitsAdmin = lazyNamed(() => import('@/pages/admin/OrgUnitsAdmin'), 'OrgUnitsAdmin');
const SitesAdmin = lazyNamed(() => import('@/pages/admin/SitesAdmin'), 'SitesAdmin');
const TasksBoard = lazyNamed(() => import('@/pages/tasks/TasksBoard'), 'TasksBoard');
const ControlRoomPage = lazyNamed(() => import('@/pages/controlRoom/ControlRoomPage'), 'ControlRoomPage');
const TaskPolicyPage = lazyNamed(() => import('@/pages/tasks/TaskPolicyPage'), 'TaskPolicyPage');
const ComplianceEvidenceHome = lazyNamed(() => import('@/pages/admin/ComplianceEvidenceHome'), 'ComplianceEvidenceHome');
const BillingHome = lazyNamed(() => import('@/pages/admin/BillingHome'), 'BillingHome');
const AuditHome = lazyNamed(() => import('@/pages/audit/AuditHome'), 'AuditHome');
const ApprovalRecord = lazyNamed(() => import('@/pages/audit/ApprovalRecord'), 'ApprovalRecord');
const AnalyticsHome = lazyNamed(() => import('@/pages/analytics/AnalyticsHome'), 'AnalyticsHome');
const ProductAnalytics = lazyNamed(() => import('@/pages/analytics/ProductAnalytics'), 'ProductAnalytics');
const DesignSystemPage = lazyNamed(() => import('@/pages/platform/DesignSystemPage'), 'DesignSystemPage');
const SettingsArea = lazyNamed(() => import('@/pages/settings/SettingsArea'), 'SettingsArea');
const CommunicationsSettings = lazyNamed(() => import('@/pages/settings/CommunicationsSettings'), 'CommunicationsSettings');
const TrustCenterPage = lazyNamed(() => import('@/pages/trust/TrustCenterPage'), 'TrustCenterPage');
const PublicTrustPage = lazyNamed(() => import('@/pages/trust/PublicTrustPage'), 'PublicTrustPage');
const PublicStatusPage = lazyNamed(() => import('@/pages/status/PublicStatusPage'), 'PublicStatusPage');
const AccessibilityPage = lazyNamed(() => import('@/pages/trust/AccessibilityPage'), 'AccessibilityPage');
const ReliabilityHome = lazyNamed(() => import('@/pages/analytics/ReliabilityHome'), 'ReliabilityHome');
const RobotsHome = lazyNamed(() => import('@/pages/robots/RobotsHome'), 'RobotsHome');
const RobotRecord = lazyNamed(() => import('@/pages/robots/RobotRecord'), 'RobotRecord');
const SiteSafetyZones = lazyNamed(() => import('@/pages/robots/SiteSafetyZones'), 'SiteSafetyZones');
const RobotChecklistTemplates = lazyNamed(() => import('@/pages/robots/RobotChecklistTemplates'), 'RobotChecklistTemplates');
const MeHome = lazyNamed(() => import('@/pages/me/MeHome'), 'MeHome');
const PayNotices = lazyNamed(() => import('@/pages/me/PayNotices'), 'PayNotices');
const MyWallet = lazyNamed(() => import('@/pages/me/MyWallet'), 'MyWallet');
const MyW9 = lazyNamed(() => import('@/pages/me/MyW9'), 'MyW9');
const WalletVerifyPage = lazyNamed(() => import('@/pages/public/WalletVerifyPage'), 'WalletVerifyPage');
const VerifyCredentialPage = lazyNamed(() => import('@/pages/public/VerifyCredentialPage'), 'VerifyCredentialPage');
const MyDiscipline = lazyNamed(() => import('@/pages/me/MyDiscipline'), 'MyDiscipline');
const CelebrationsHome = lazyNamed(() => import('@/pages/celebrations/CelebrationsHome'), 'CelebrationsHome');
const AssetsHome = lazyNamed(() => import('@/pages/assets/AssetsHome'), 'AssetsHome');
const PulseHome = lazyNamed(() => import('@/pages/pulse/PulseHome'), 'PulseHome');
const HolidaysHome = lazyNamed(() => import('@/pages/holidays/HolidaysHome'), 'HolidaysHome');
const WorkflowsHome = lazyNamed(() => import('@/pages/workflows/WorkflowsHome'), 'WorkflowsHome');
const MarketplaceHome = lazyNamed(() => import('@/pages/marketplace/MarketplaceHome'), 'MarketplaceHome');
const TemplatesHome = lazyNamed(() => import('@/pages/templates/TemplatesHome'), 'TemplatesHome');
const IntegrationsHome = lazyNamed(() => import('@/pages/integrations/IntegrationsHome'), 'IntegrationsHome');
const DevelopersPage = lazyNamed(() => import('@/pages/integrations/DevelopersPage'), 'DevelopersPage');
const IntegrationConnectionPage = lazyNamed(() => import('@/pages/integrations/connections/ConnectionPage'), 'ConnectionPage');
const WorktagsHome = lazyNamed(() => import('@/pages/worktags/WorktagsHome'), 'WorktagsHome');
const ReportsHome = lazyNamed(() => import('@/pages/reports/ReportsHome'), 'ReportsHome');

// Public, no-Layout pages — lazy too. face-api lives in the kiosk chunk.
const KioskPage = lazyNamed(() => import('@/pages/kiosk/KioskPage'), 'KioskPage');
const KioskAdmin = lazyNamed(() => import('@/pages/kiosk/KioskAdmin'), 'KioskAdmin');
const HotlinePage = lazyNamed(() => import('@/pages/hotline/HotlinePage'), 'HotlinePage');
const TrackPage = lazyNamed(() => import('@/pages/transport/TrackPage'), 'TrackPage');
const CareersListPage = lazyNamed(() => import('@/pages/careers/CareersPage'), 'CareersListPage');
const CareerPostingPage = lazyNamed(() => import('@/pages/careers/CareersPage'), 'CareerPostingPage');
const OfferLetterPage = lazyNamed(() => import('@/pages/offer/OfferLetterPage'), 'OfferLetterPage');
// The office pack (2026-10-17): the candidate's page and the client NPS answer
// page are public signed links; marketing and the NPS results are signed-in.
const CandidatePortalPage = lazyNamed(() => import('@/pages/candidate/CandidatePortalPage'), 'CandidatePortalPage');
const NpsSurveyPage = lazyNamed(() => import('@/pages/nps/NpsSurveyPage'), 'NpsSurveyPage');
const MarketingHome = lazyNamed(() => import('@/pages/marketing/MarketingHome'), 'MarketingHome');
const ReferralBonusDesk = lazyNamed(() => import('@/pages/marketing/ReferralBonusDesk'), 'ReferralBonusDesk');
const ClientNpsPage = lazyNamed(() => import('@/pages/clients/ClientNpsPage'), 'ClientNpsPage');
// The executive portal (2026-10-27): the chairman's drill-downs, one per board topic.
const ExecFinancialsPage = lazyNamed(() => import('@/pages/executive/FinancialsPage'), 'ExecFinancialsPage');
const ExecClientsPage = lazyNamed(() => import('@/pages/executive/ClientsPage'), 'ExecClientsPage');
const ExecPeoplePage = lazyNamed(() => import('@/pages/executive/PeoplePage'), 'ExecPeoplePage');
const ExecRiskPage = lazyNamed(() => import('@/pages/executive/RiskPage'), 'ExecRiskPage');
const ExecScenariosPage = lazyNamed(() => import('@/pages/executive/ScenariosPage'), 'ExecScenariosPage');
const ExecBoardPacksPage = lazyNamed(() => import('@/pages/executive/BoardPacksPage'), 'ExecBoardPacksPage');
const ExecOperationsPage = lazyNamed(() => import('@/pages/executive/OperationsPage'), 'ExecOperationsPage');

// Hover-prefetch registry. The Sidebar (and any other navigator) looks
// up the user's hovered link here and fires the chunk loader before the
// click lands, so the navigation only pays the data-fetch cost. Module
// roots only — the registry resolves by longest-prefix match so child
// routes (e.g. /payroll/runs/123) reuse the parent module's chunk
// loader automatically.
registerPrefetch('/onboarding', () => import('@/pages/onboarding/OnboardingHome'));
registerPrefetch('/recruiting', () => import('@/pages/recruiting/RecruitingHome'));
// The person record (/people/<id>) imports the directory's sections, and the
// prefetcher matches by path prefix (an id can't be registered), so the
// People key warms both chunks — on the nav link and on a name in the grid.
registerPrefetch('/people', () => Promise.all([import('@/pages/people/PeopleDirectory'), import('@/pages/people/PersonRecord')]));
registerPrefetch('/clients', () => import('@/pages/clients/ClientsHome'));
registerPrefetch('/clients/pipeline', () => import('@/pages/clients/PipelinePage'));
registerPrefetch('/time-attendance', () => import('@/pages/time/TimeHome'));
registerPrefetch('/time-off', () => import('@/pages/timeoff/TimeOffHome'));
registerPrefetch('/scheduling', () => Promise.all([import('@/pages/scheduling/SchedulingHome'), import('@/pages/scheduling/AdminSchedulingView')]));
registerPrefetch('/approvals', () => import('@/pages/approvals/ApprovalsHome'));
registerPrefetch('/inbox', () => import('@/pages/inbox/InboxHome'));
registerPrefetch('/payroll', () => import('@/pages/payroll/PayrollHome'));
registerPrefetch('/documents', () => import('@/pages/documents/DocumentsHome'));
registerPrefetch('/communications', () => import('@/pages/communications/CommunicationsHome'));
registerPrefetch('/compliance', () => import('@/pages/compliance/ComplianceHome'));
registerPrefetch('/programs', () => import('@/pages/programs/ProgramsHome'));
registerPrefetch('/season-planner', () => import('@/pages/planner/SeasonPlannerHome'));
registerPrefetch('/forecast', () => import('@/pages/forecast/ForecastHome'));
registerPrefetch('/workers', () => import('@/pages/admin/WorkerTypesAdmin'));
registerPrefetch('/agents', () => Promise.all([import('@/pages/admin/AgentRegistryAdmin'), import('@/pages/admin/AgentRecordPage')]));
registerPrefetch('/admin/agents', () => import('@/pages/admin/AgentGovernance'));
registerPrefetch('/performance', () => import('@/pages/performance/PerformanceHome'));
registerPrefetch('/benefits', () => import('@/pages/benefits/BenefitsHome'));
registerPrefetch('/analytics', () => import('@/pages/analytics/AnalyticsHome'));
registerPrefetch('/product-analytics', () => import('@/pages/analytics/ProductAnalytics'));
registerPrefetch('/reliability', () => import('@/pages/analytics/ReliabilityHome'));
registerPrefetch('/robots', () => import('@/pages/robots/RobotsHome'));
registerPrefetch('/audit', () => import('@/pages/audit/AuditHome'));
registerPrefetch('/me', () => import('@/pages/me/MeHome'));
registerPrefetch('/settings', () => import('@/pages/Settings'));
registerPrefetch('/admin/users', () => import('@/pages/admin/UsersAdmin'));
registerPrefetch('/admin/branding', () => import('@/pages/admin/BrandingHome'));
registerPrefetch('/admin/organization', () => import('@/pages/admin/TenantProfileHome'));
registerPrefetch('/admin', () => import('@/pages/admin/SettingsHome'));
registerPrefetch('/admin/employers', () => import('@/pages/admin/EmployersAdmin'));
registerPrefetch('/admin/org-units', () => import('@/pages/admin/OrgUnitsAdmin'));
registerPrefetch('/admin/sites', () => import('@/pages/admin/SitesAdmin'));
registerPrefetch('/tasks', () => import('@/pages/tasks/TasksBoard'));
registerPrefetch('/admin/billing', () => import('@/pages/admin/BillingHome'));
registerPrefetch('/reports', () => import('@/pages/reports/ReportsHome'));
// Public, no-auth routes. Prefetched from any link that points at them
// (e.g. "Report an issue" links inside the authed app surface that send
// users to the public hotline page).
registerPrefetch('/kiosk', () => import('@/pages/kiosk/KioskPage'));
registerPrefetch('/hotline', () => import('@/pages/hotline/HotlinePage'));

// Hover-prime the React Query cache for the heaviest pages. By the
// time the user clicks, the chunk and the initial list have already
// downloaded in parallel — the destination page mounts with data
// already cached instead of waterfalling chunk → mount → fetch →
// render. queryKey strings here MUST match the ones in the page
// components or the cache write won't hit. Failures are swallowed.
registerDataPrefetch('/people', () => {
  // Same query the page runs with no filters set — an infinite query, so
  // the cache holds { pages, pageParams }, never a bare array.
  void queryClient.prefetchInfiniteQuery(directoryQuery({}));
  void queryClient.prefetchQuery({
    queryKey: ['clients', 'list'],
    // Full response object — must match useClients()'s cache shape, or a
    // prefetch here poisons the shared key with a bare array.
    queryFn: () => listClients({ status: 'ACTIVE' }),
    staleTime: 5 * 60_000,
  });
});
registerDataPrefetch('/clients', () => {
  void queryClient.prefetchQuery({
    queryKey: ['clients', 'list'],
    // Full response object — must match useClients()'s cache shape, or a
    // prefetch here poisons the shared key with a bare array.
    queryFn: () => listClients({ status: 'ACTIVE' }),
    staleTime: 5 * 60_000,
  });
});
registerDataPrefetch('/clients/pipeline', () => {
  // Same key and loader as PipelinePage's own query.
  void queryClient.prefetchQuery({ queryKey: PROSPECTS_KEY, queryFn: listProspects, staleTime: 30_000 });
});

// Tiny in-page fallback for top-level (no-Layout) routes while their chunk
// streams in. The Layout has its own Suspense around <Outlet />.
/**
 * /transport is the desk's (view:transport). A driver holds drive:transport —
 * their runs are their home — so a link or a typed URL takes them there instead
 * of a "you don't have access" page (transport review 2026-10-28).
 */
function TransportRoute() {
  const { can } = useAuth();
  if (!can('view:transport') && can('drive:transport')) return <Navigate to="/" replace />;
  return <TransportHome />;
}

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
  { path: 'onboarding/templates', element: <RequireCapability cap="manage:onboarding"><TemplatesList /></RequireCapability> },
  { path: 'onboarding/templates/new', element: <RequireCapability cap="manage:onboarding"><TemplateEditor /></RequireCapability> },
  { path: 'onboarding/templates/:id', element: <RequireCapability cap="manage:onboarding"><TemplateEditor /></RequireCapability> },
  // Phase 62 — time-to-completion analytics (view:dashboard required).
  { path: 'onboarding/analytics', element: <RequireCapability cap="view:analytics"><OnboardingAnalytics /></RequireCapability> },
  {
    path: 'onboarding/applications/:id',
    element: <ApplicationDetail />,
  },
  // Phase 145 — in-person onboarding workspace (admin sits with the
  // associate at the office, scans IDs via webcam, and approves once
  // the checklist is at 100%).
  {
    path: 'onboarding/in-person/:applicationId',
    element: (
      <RequireCapability cap="manage:onboarding">
        <InPersonOnboarding />
      </RequireCapability>
    ),
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
  { path: 'onboarding/me/:applicationId/tasks/wotc_screening', element: <WotcScreeningTask /> },
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
  {
    path: 'onboarding/me/:applicationId/tasks/profile_photo',
    element: <ProfilePhotoTask />,
  },
  {
    path: 'onboarding/me/:applicationId/tasks/availability',
    element: <AvailabilityTask />,
  },
  // Every TaskKind has a page above; a bogus kind in the URL is a 404.
  {
    path: 'onboarding/me/:applicationId/tasks/:taskKind',
    element: <NotFound />,
  },
];

// Authenticated routes that live under the Layout shell.
const LAYOUT_ROUTES = [
  { index: true, element: <Dashboard /> },
  { path: 'time-attendance', element: <TimeHome /> },
  // Finance's alias for the same surface — their nav says "Timesheets".
  { path: 'timesheets', element: <TimeHome /> },
  { path: 'time-off', element: <TimeOffHome /> },
  // Route-level capability gates below mirror the sidebar's module gating
  // (lib/modules.ts) so a bounded role (SHIFT_SUPERVISOR, CLIENT_PORTAL,
  // FINANCE_ACCOUNTANT…) deep-linking into a module it can't see gets the
  // styled "no access" screen instead of a broken page of 403s.
  { path: 'clients', element: <RequireCapability cap="view:clients"><ClientsHome /></RequireCapability> },
  // Weekly-close roll-up — same audience as ClientDetail's StatementsSection:
  // payroll finalizes, executives read. Static segment outranks `clients/:id`.
  { path: 'clients/statements', element: <RequireCapability cap="process:payroll" anyOf={['view:executive']}><ClientStatementsRollup /></RequireCapability> },
  { path: 'clients/nps', element: <RequireCapability cap="view:executive" anyOf={['view:marketing']}><ClientNpsPage /></RequireCapability> },
  // The executive portal's drill-downs: whoever reads the executive numbers.
  { path: 'executive/financials', element: <RequireCapability cap="view:executive"><ExecFinancialsPage /></RequireCapability> },
  { path: 'executive/clients', element: <RequireCapability cap="view:executive"><ExecClientsPage /></RequireCapability> },
  { path: 'executive/people', element: <RequireCapability cap="view:executive"><ExecPeoplePage /></RequireCapability> },
  { path: 'executive/risk', element: <RequireCapability cap="view:executive"><ExecRiskPage /></RequireCapability> },
  { path: 'executive/scenarios', element: <RequireCapability cap="view:executive"><ExecScenariosPage /></RequireCapability> },
  { path: 'executive/board-packs', element: <RequireCapability cap="view:executive"><ExecBoardPacksPage /></RequireCapability> },
  { path: 'executive/operations', element: <RequireCapability cap="view:executive"><ExecOperationsPage /></RequireCapability> },
  // The new-business pipeline: whoever works it (manage:clients) and the executives who read it.
  { path: 'clients/pipeline', element: <RequireCapability cap="manage:clients" anyOf={['view:executive']} notClientBounded><PipelinePage /></RequireCapability> },
  { path: 'clients/:id', element: <RequireCapability cap="view:clients"><ClientDetail /></RequireCapability> },
  // The client portal home — CLIENT_PORTAL's landing view; admins with
  // view:executive/manage:org preview any client via ?clientId= (the
  // page gates internally, since no single capability fits both).
  { path: 'portal', element: <ClientPortalHome /> },
  { path: 'portal/today', element: <PortalToday /> },
  // The store supervisors' Today — the same page, opened on their client.
  { path: 'today', element: <PortalToday /> },
  { path: 'portal/schedule', element: <PortalSchedule /> },
  { path: 'portal/requests', element: <PortalRequestsPage /> },
  { path: 'portal/history', element: <PortalHistory /> },
  { path: 'portal/ops', element: <PortalOps /> },
  { path: 'portal/candidates', element: <PortalCandidates /> },
  { path: 'region', element: <RegionHome /> },
  { path: 'messages', element: <MessagesHome /> },
  { path: 'messages/:id', element: <MessagesHome /> },
  { path: 'scheduling', element: <SchedulingHome /> },
  // Every store's next seven days on one screen (role walk HR 6).
  { path: 'scheduling/coverage', element: <RequireCapability cap="view:scheduling"><CoverageBoard /></RequireCapability> },
  // The supervisor corps: field leadership places a supervisor at a store and shift.
  { path: 'scheduling/supervisors', element: <RequireCapability cap="manage:org"><SupervisorCorps /></RequireCapability> },
  { path: 'approvals', element: <RequireCapability cap="manage:scheduling"><ApprovalsHome /></RequireCapability> },
  // Every decision waiting on the signed-in person; the API decides which
  // queues they may see, so any authenticated role can open it.
  { path: 'inbox', element: <InboxHome /> },
  { path: 'decisions/open', element: <DecisionOpen /> },
  // notClientBounded: the shift supervisor holds manage:scheduling, but labor
  // cost is org economics — the API refuses bounded roles on every read here.
  { path: 'labor-costs', element: <RequireCapability cap="manage:scheduling" anyOf={['view:executive', 'process:payroll']} notClientBounded><LaborCostsHome /></RequireCapability> },
  { path: 'ops', element: <RequireCapability cap="run:ops-shifts" anyOf={['view:ops', 'assist:ops-shifts']}><OpsHome /></RequireCapability> },
  { path: 'rides', element: <RequireCapability cap="ride:transport"><RideHome /></RequireCapability> },
  { path: 'transport', element: <RequireCapability cap="view:transport" anyOf={['drive:transport']}><TransportRoute /></RequireCapability> },
  { path: 'emergency', element: <RequireCapability cap="view:emergency"><EmergencyHome /></RequireCapability> },
  { path: 'payroll', element: <RequireCapability cap="view:payroll"><PayrollHome /></RequireCapability> },
  { path: 'documents', element: <RequireCapability cap="view:documents"><DocumentsHome /></RequireCapability> },
  { path: 'compliance', element: <RequireCapability cap="view:compliance"><ComplianceHome /></RequireCapability> },
  { path: 'programs', element: <RequireCapability cap="view:compliance"><ProgramsHome /></RequireCapability> },
  { path: 'season-planner', element: <RequireCapability cap="view:org"><SeasonPlannerHome /></RequireCapability> },
  { path: 'forecast', element: <RequireCapability cap="view:org"><ForecastHome /></RequireCapability> },
  { path: 'communications', element: <CommunicationsHome /> },
  { path: 'performance', element: <RequireCapability cap="view:performance"><PerformanceHome /></RequireCapability> },
  { path: 'recruiting', element: <RecruitingHome /> },
  { path: 'analytics', element: <RequireCapability cap="view:analytics"><AnalyticsHome /></RequireCapability> },
  // Brief 3-2: tasks and their assignment.
  { path: 'tasks', element: <RequireCapability cap="view:time-live"><TasksBoard /></RequireCapability> },
  { path: 'control-room', element: <RequireCapability cap="view:time-live"><ControlRoomPage /></RequireCapability> },
  { path: 'support', element: <SupportPage /> },
  // People: the workforce roster and the agents (the People door, lib/modules.ts).
  // One address each — not inside the Settings area, whose rail would otherwise
  // sit beside the sidebar's People door. Governance is /admin/agents, below.
  { path: 'workers', element: <RequireCapability cap="view:org"><WorkerTypesAdmin /></RequireCapability> },
  { path: 'agents', element: <RequireCapability cap="view:org"><AgentRegistryAdmin /></RequireCapability> },
  { path: 'agents/:id', element: <RequireCapability cap="view:org"><AgentRecordPage /></RequireCapability> },
  // Brief 3-1: the robot fleet (Operations), one robot's record, a site's safety zones.
  { path: 'robots', element: <RequireCapability cap="view:org"><RobotsHome /></RequireCapability> },
  { path: 'robots/sites/:locationId/zones', element: <RequireCapability cap="view:org"><SiteSafetyZones /></RequireCapability> },
  { path: 'robots/checklists', element: <RequireCapability cap="view:org"><RobotChecklistTemplates /></RequireCapability> },
  { path: 'robots/:id', element: <RequireCapability cap="view:org"><RobotRecord /></RequireCapability> },
  // UX upgrade step 3: Settings & Trust — one area (rail + eyebrow) around the pages
  // an organization configures and an auditor checks. Paths unchanged.
  {
    element: <SettingsArea />,
    children: [
    { path: 'product-analytics', element: <RequireCapability cap="view:product-analytics"><OperatorOnly><ProductAnalytics /></OperatorOnly></RequireCapability> },
    { path: 'design-system', element: <RequireCapability cap="view:product-analytics"><OperatorOnly><DesignSystemPage /></OperatorOnly></RequireCapability> },
    { path: 'reliability', element: <RequireCapability cap="view:product-analytics"><OperatorOnly><ReliabilityHome /></OperatorOnly></RequireCapability> },
    // Settings & trust — the one door to the admin pages below (SettingsHome).
    // The hub admits everyone its sidebar door is shown to (a workforce
    // manager holds manage:org, not view:hr-admin); its cards are each gated.
    { path: 'admin', element: <RequireCapability cap="view:hr-admin" anyOf={['manage:org', 'view:integrations', 'view:product-analytics']}><SettingsHome /></RequireCapability> },
    { path: 'admin/users', element: <RequireCapability cap="view:hr-admin"><UsersAdmin /></RequireCapability> },
    // Roles & permissions: its own Settings entry, out of Users (audit Tier 3).
    { path: 'admin/roles', element: <RequireCapability cap="view:hr-admin"><RolesPage /></RequireCapability> },
    // Regions are edited in the Org chart's field view now; old links land there.
    { path: 'admin/regions', element: <Navigate to="/org/chart?view=field" replace /> },
    // Agents & gates: who approves what, certification, credentials, the MCP tools,
    // the decision record and the kill switches. The agents themselves live in People (/agents).
    { path: 'admin/agents', element: <RequireCapability cap="view:org"><AgentGovernance /></RequireCapability> },
    { path: 'admin/branding', element: <RequireCapability cap="view:hr-admin"><BrandingHome /></RequireCapability> },
    // Finance's own settings (mailbox, unverified-bank policy, remit-to, cash floor) and the
    // second-person approval rules — both used to sit on Branding (F500 G4).
    { path: 'admin/finance', element: <RequireCapability cap="view:hr-admin"><FinanceSettingsPage /></RequireCapability> },
    { path: 'admin/approvals', element: <RequireCapability cap="view:hr-admin"><ApprovalRulesPage /></RequireCapability> },
    // Settings & trust → Communications: channels, WhatsApp, the do-not-email list, routing.
    { path: 'admin/communications', element: <RequireCapability cap="manage:communications"><CommunicationsSettings /></RequireCapability> },
    { path: 'admin/organization', element: <RequireCapability cap="view:hr-admin"><TenantProfileHome /></RequireCapability> },
    { path: 'admin/sign-in', element: <RequireCapability cap="manage:org"><SignInSettings /></RequireCapability> },
    // Access pack: certification campaigns — any signed-in reviewer may open theirs; running one needs manage:org (the page gates the button).
    { path: 'admin/access-certifications', element: <AccessCertifications /> },
    { path: 'admin/access-certifications/:id', element: <AccessCertificationPage /> },
    { path: 'platform/support', element: <RequireCapability cap="manage:org"><PlatformSupportInbox /></RequireCapability> },
    { path: 'admin/employers', element: <RequireCapability cap="view:org"><EmployersAdmin /></RequireCapability> },
    { path: 'admin/document-retention', element: <RequireCapability cap="view:hr-admin"><DocumentRetentionAdmin /></RequireCapability> },
    { path: 'admin/org-units', element: <RequireCapability cap="view:org"><OrgUnitsAdmin /></RequireCapability> },
    { path: 'admin/sites', element: <RequireCapability cap="view:org"><SitesAdmin /></RequireCapability> },
    { path: 'admin/task-policy', element: <RequireCapability cap="view:scheduling"><TaskPolicyPage /></RequireCapability> },
    { path: 'admin/compliance-evidence', element: <RequireCapability cap="view:org"><ComplianceEvidenceHome /></RequireCapability> },
    { path: 'admin/billing', element: <RequireCapability cap="manage:org" anyOf={['process:payroll']}><BillingHome /></RequireCapability> },
    { path: 'audit', element: <RequireCapability cap="view:audit"><AuditHome /></RequireCapability> },
    // The approval engine's record: every second-person request, under the audit desk.
    { path: 'audit/approvals', element: <RequireCapability cap="view:audit" anyOf={['manage:org', 'process:payroll']}><ApprovalRecord /></RequireCapability> },
    { path: 'trust', element: <RequireCapability cap="view:audit" anyOf={['manage:org', 'view:executive']}><TrustCenterPage /></RequireCapability> },
    { path: 'integrations', element: <RequireCapability cap="view:integrations"><IntegrationsHome /></RequireCapability> },
    { path: 'developers', element: <RequireCapability cap="view:integrations"><DevelopersPage /></RequireCapability> },
    // Brief 3-5: one HR or VMS connection with its sync log.
    { path: 'integrations/connections/:id', element: <RequireCapability cap="view:integrations"><IntegrationConnectionPage /></RequireCapability> },
    ],
  },
  // `settings` is universal — every authenticated user manages their own
  // profile / password / preferences here. RequireAuth above is enough.
  { path: 'settings', element: <Settings /> },
  // Release notes are for everyone who can sign in; editing is gated inside.
  { path: 'whats-new', element: <WhatsNewPage /> },
  // Brief 2-6 step 5: anyone signed in asks for help; the platform operator's admins answer.
  // No dedicated view:benefits capability exists — benefits elections are
  // paycheck deductions, so the module (see lib/modules.ts) is gated on
  // view:payroll; the route matches it.
  { path: 'benefits', element: <RequireCapability cap="view:payroll"><BenefitsHome /></RequireCapability> },
  { path: 'people', element: <RequireCapability cap="view:org"><PeopleDirectory /></RequireCapability> },
  { path: 'people/mass-update', element: <RequireCapability cap="manage:org"><MassUpdate /></RequireCapability> },
  { path: 'people/:associateId', element: <RequireCapability cap="view:org"><PersonRecord /></RequireCapability> },
  { path: 'org', element: <RequireCapability cap="view:org"><OrgHome /></RequireCapability> },
  { path: 'org/chart', element: <RequireCapability cap="view:org"><OrgChart /></RequireCapability> },
  { path: 'call-outs', element: <RequireCapability cap="view:scheduling" anyOf={['manage:scheduling']}><CallOutsDesk /></RequireCapability> },
  { path: 'retention', element: <RequireCapability cap="view:org" anyOf={['manage:scheduling']}><RetentionDesk /></RequireCapability> },
  // F500 fix-up: every capability-gated page carries its module's guard, so a
  // deep link shows the access page instead of "Missing capability: …".
  { path: 'celebrations', element: <RequireCapability cap="view:org" anyOf={['message:crew']}><CelebrationsHome /></RequireCapability> },
  { path: 'assets', element: <RequireCapability cap="view:org"><AssetsHome /></RequireCapability> },
  { path: 'pulse', element: <PulseHome /> },
  { path: 'headcount', element: <RequireCapability cap="view:org"><HeadcountHome /></RequireCapability> },
  { path: 'headcount/plan', element: <RequireCapability cap="view:org"><HeadcountPlan /></RequireCapability> },
  // Marketing: the funnel, the brand page, campaigns; the bonus desk is Finance's.
  { path: 'marketing', element: <RequireCapability cap="view:marketing"><MarketingHome /></RequireCapability> },
  { path: 'marketing/bonuses', element: <RequireCapability cap="process:payroll" anyOf={['view:marketing']}><ReferralBonusDesk /></RequireCapability> },
  { path: 'skills', element: <RequireCapability cap="view:org"><SkillsHome /></RequireCapability> },
  { path: 'mentorship', element: <RequireCapability cap="view:org"><MentorshipHome /></RequireCapability> },
  { path: 'expirations', element: <RequireCapability cap="view:org" selfService="/me/wallet"><ExpirationsHome /></RequireCapability> },
  { path: 'learning-paths', element: <RequireCapability cap="view:compliance"><LearningPathsHome /></RequireCapability> },
  { path: 'succession', element: <RequireCapability cap="view:hr-admin"><SuccessionHome /></RequireCapability> },
  { path: 'probation', element: <RequireCapability cap="view:hr-admin"><ProbationHome /></RequireCapability> },
  { path: 'holidays', element: <HolidaysHome /> },
  { path: 'discipline', element: <RequireCapability cap="view:hr-admin"><DisciplineHome /></RequireCapability> },
  { path: 'separations', element: <RequireCapability cap="view:hr-admin"><SeparationHome /></RequireCapability> },
  { path: 'internal-jobs', element: <InternalJobsHome /> },
  { path: 'vaccinations', element: <RequireCapability cap="view:compliance"><VaccinationsHome /></RequireCapability> },
  { path: 'agreements', element: <AgreementsHome /> },
  { path: 'hr-cases', element: <HrCasesHome /> },
  { path: 'leave', element: <LeaveHome /> },
  { path: 'claims/unemployment', element: <RequireCapability cap="manage:claims"><UnemploymentClaimsHome /></RequireCapability> },
  { path: 'claims/workers-comp', element: <RequireCapability cap="manage:claims"><WorkersCompHome /></RequireCapability> },
  { path: 'policy-campaigns', element: <RequireCapability cap="view:hr-admin"><PolicyCampaignsHome /></RequireCapability> },
  { path: 'relay', element: <RequireCapability cap="view:org"><RelayBoard /></RequireCapability> },
  { path: 'help-center', element: <KbHome /> },
  { path: 'ramp', element: <RequireCapability cap="view:hr-admin"><RampHome /></RequireCapability> },
  { path: 'career', element: <CareerHome /> },
  { path: 'tuition', element: <TuitionHome /> },
  { path: 'hotline-admin', element: <RequireCapability cap="manage:performance"><HotlineAdmin /></RequireCapability> },
  { path: 'equity', element: <EquityHome /> },
  { path: 'volunteer', element: <VtoHome /> },
  { path: 'team', element: <RequireCapability cap="view:my-team"><TeamHome /></RequireCapability> },
  { path: 'workflows', element: <RequireCapability cap="view:org"><WorkflowsHome /></RequireCapability> },
  { path: 'me', element: <MeHome /> },
  { path: 'me/pay-notices', element: <PayNotices /> },
  { path: 'me/pay-notices/:id', element: <PayNotices /> },
  // The associate's own disciplinary record — the page the "please
  // acknowledge" notification links to. Both bare and :id forms resolve.
  // What they've earned, carried with them — and the link that shows it.
  { path: 'me/wallet', element: <MyWallet /> },
  { path: 'me/w9', element: <MyW9 /> },
  { path: 'me/discipline', element: <MyDiscipline /> },
  { path: 'me/discipline/:actionId', element: <MyDiscipline /> },
  { path: 'compensation', element: <RequireCapability cap="view:comp"><CompensationHome /></RequireCapability> },
  { path: 'performance/extras', element: <RequireCapability cap="view:performance"><PerformanceExtras /></RequireCapability> },
  { path: 'performance/calibration', element: <RequireCapability cap="manage:performance"><ReviewCalibration /></RequireCapability> },
  { path: 'marketplace', element: <MarketplaceHome /> },
  { path: 'payrules', element: <RequireCapability cap="process:payroll"><PayRulesHome /></RequireCapability> },
  { path: 'directory', element: <RequireCapability cap="view:org"><DirCommsHome /></RequireCapability> },
  { path: 'compliance/osha', element: <RequireCapability cap="view:compliance"><OshaWcEeoHome /></RequireCapability> },
  { path: 'templates', element: <RequireCapability cap="view:hr-admin"><TemplatesHome /></RequireCapability> },
  { path: 'recruiting/extras', element: <RequireCapability cap="view:recruiting"><RecruitingExtras /></RequireCapability> },
  { path: 'recruiting/analytics', element: <RequireCapability cap="view:recruiting"><RecruitingAnalytics /></RequireCapability> },
  // Retired: tax forms live on the Returns tab, garnishments on their desk (pages/payroll/legacyPayrollRoutes).
  { path: 'payroll/tax', element: <LegacyPayrollRedirect /> },
  { path: 'payroll/taxes', element: <RequireCapability cap="process:payroll"><PayrollTaxesDesk /></RequireCapability> },
  { path: 'payroll/certified', element: <RequireCapability cap="process:payroll"><CertifiedPayrollDesk /></RequireCapability> },
  { path: 'payroll/garnishments', element: <RequireCapability cap="process:payroll"><GarnishmentDesk /></RequireCapability> },
  { path: 'payroll/retirement', element: <RequireCapability cap="process:payroll"><RetirementPlans /></RequireCapability> },
  { path: 'benefits/carriers', element: <RequireCapability cap="process:payroll"><CarrierFeeds /></RequireCapability> },
  { path: 'payroll/certified/:id', element: <RequireCapability cap="process:payroll"><CertifiedProject /></RequireCapability> },
  { path: 'payroll/certified/:id/weeks/:weekEnding', element: <RequireCapability cap="process:payroll"><CertifiedWeek /></RequireCapability> },
  { path: 'payroll/contractors', element: <RequireCapability cap="process:payroll"><LegacyPayrollRedirect><ContractorsDesk /></LegacyPayrollRedirect></RequireCapability> },
  { path: 'payroll/banking', element: <RequireCapability cap="process:payroll"><PayrollBankingPage /></RequireCapability> },
  { path: 'payroll/schedules', element: <RequireCapability cap="process:payroll"><PaySchedulesPage /></RequireCapability> },
  { path: 'payroll/schedules/new', element: <RequireCapability cap="process:payroll"><NewPaySchedulePage /></RequireCapability> },
  { path: 'payroll/schedules/:id', element: <RequireCapability cap="process:payroll"><PayScheduleDetailPage /></RequireCapability> },
  { path: 'payroll/tax-tables', element: <RequireCapability cap="process:payroll"><TaxTablesPage /></RequireCapability> },
  // Retired: tax reference lives on Tax tables (pages/payroll/legacyPayrollRoutes).
  { path: 'payroll/config', element: <LegacyPayrollRedirect /> },
  // ?tab=deposits and ?tab=remittances moved to the taxes and garnishment desks; the other tabs stay.
  { path: 'payroll/compliance', element: <RequireCapability cap="process:payroll"><LegacyPayrollRedirect><PayrollCompliance /></LegacyPayrollRedirect></RequireCapability> },
  { path: 'payroll/readiness', element: <RequireCapability cap="process:payroll"><PayrollReadiness /></RequireCapability> },
  { path: 'payroll/go-live', element: <RequireCapability cap="process:payroll"><PayrollGoLivePage /></RequireCapability> },
  { path: 'payroll/financial-changes', element: <RequireCapability cap="process:payroll"><FinancialChangesQueue /></RequireCapability> },
  { path: 'payroll/ytd', element: <RequireCapability cap="process:payroll"><PayrollYtd /></RequireCapability> },
  // One run, one record (F500 G3): /payroll/runs/:id and its tabs by path — /review, /close and
  // /checks (every existing link) land on that tab, plus /paychecks and /confirmations.
  { path: 'payroll/runs/:id', element: <RequireCapability cap="process:payroll"><RunRecordPage /></RequireCapability> },
  { path: 'payroll/runs/:id/:tab', element: <RequireCapability cap="process:payroll"><RunRecordPage /></RequireCapability> },
  { path: 'payroll/review', element: <RequireCapability cap="process:payroll"><PayrollReviewsPage /></RequireCapability> },
  { path: 'payroll/earned-wage', element: <RequireCapability cap="process:payroll"><EarnedWageDesk /></RequireCapability> },
  { path: 'payroll/daily-pay', element: <RequireCapability cap="process:payroll"><DailyPayDesk /></RequireCapability> },
  { path: 'payroll/manual-checks', element: <RequireCapability cap="process:payroll"><ManualChecksPage /></RequireCapability> },
  { path: 'payroll/pay-checks', element: <RequireCapability cap="process:payroll"><PayChecksPage /></RequireCapability> },
  { path: 'payroll/w4-estimator', element: <W4Estimator /> },
  { path: 'payroll/state-tax', element: <LegacyPayrollRedirect /> },
  { path: 'payroll/tax-jurisdictions', element: <LegacyPayrollRedirect /> },
  { path: 'payroll/wotc', element: <RequireCapability cap="process:payroll" anyOf={['manage:onboarding']}><WotcDesk /></RequireCapability> },
  { path: 'benefits/aca', element: <RequireCapability cap="process:payroll"><AcaHours /></RequireCapability> },
  { path: 'finance/cash-forecast', element: <RequireCapability cap="process:payroll"><CashForecastPage /></RequireCapability> },
  // The company's own books (2027-01).
  { path: 'books', element: <RequireCapability cap="view:books"><BooksHome /></RequireCapability> },
  { path: 'books/reports', element: <RequireCapability cap="view:books"><BooksReportsPage /></RequireCapability> },
  { path: 'books/journal', element: <RequireCapability cap="view:books"><JournalPage /></RequireCapability> },
  { path: 'books/journal/:id', element: <RequireCapability cap="view:books"><JournalEntryPage /></RequireCapability> },
  { path: 'books/accounts', element: <RequireCapability cap="view:books"><AccountsPage /></RequireCapability> },
  { path: 'books/accounts/:id', element: <RequireCapability cap="view:books"><AccountDetailPage /></RequireCapability> },
  { path: 'books/receivables', element: <RequireCapability cap="view:books"><ReceivablesPage /></RequireCapability> },
  { path: 'books/bills', element: <RequireCapability cap="view:books"><BillsPage /></RequireCapability> },
  { path: 'books/bills/:id', element: <RequireCapability cap="view:books"><BillDetailPage /></RequireCapability> },
  { path: 'books/vendors', element: <RequireCapability cap="view:books"><VendorsPage /></RequireCapability> },
  { path: 'books/vendors/:id', element: <RequireCapability cap="view:books"><VendorDetailPage /></RequireCapability> },
  { path: 'books/bank', element: <RequireCapability cap="view:books"><BankPage /></RequireCapability> },
  { path: 'books/bank/:id', element: <RequireCapability cap="view:books"><BankAccountPage /></RequireCapability> },
  { path: 'books/bank/:id/reconcile', element: <RequireCapability cap="view:books"><ReconcilePage /></RequireCapability> },
  { path: 'books/close', element: <RequireCapability cap="view:books"><ClosePage /></RequireCapability> },
  { path: 'books/close/:periodKey', element: <RequireCapability cap="view:books"><ClosePeriodPage /></RequireCapability> },
  { path: 'books/budgets', element: <RequireCapability cap="view:books"><BudgetsPage /></RequireCapability> },
  { path: 'books/budgets/:id', element: <RequireCapability cap="view:books"><BudgetDetailPage /></RequireCapability> },
  { path: 'books/assets', element: <RequireCapability cap="view:books"><FixedAssetsPage /></RequireCapability> },
  { path: 'books/assets/:id', element: <RequireCapability cap="view:books"><FixedAssetDetailPage /></RequireCapability> },
  { path: 'books/quickbooks', element: <RequireCapability cap="view:books"><QuickbooksSyncPage /></RequireCapability> },
  { path: 'finance/pay-bill', element: <RequireCapability cap="process:payroll" anyOf={['view:executive']}><PayBillPage /></RequireCapability> },
  { path: 'market-rates', element: <RequireCapability cap="view:clients"><MarketRatesHome /></RequireCapability> },
  { path: 'payroll/labor-rules', element: <RequireCapability cap="process:payroll" anyOf={['manage:org', 'view:executive']}><LaborRulesPage /></RequireCapability> },
  { path: 'payroll/year-end', element: <RequireCapability cap="process:payroll"><YearEndPage /></RequireCapability> },
  // Retired: year-end lives on one page (pages/payroll/legacyPayrollRoutes).
  { path: 'payroll/year-end-close', element: <LegacyPayrollRedirect /> },
  { path: 'payroll/year-end/reconciliation', element: <LegacyPayrollRedirect /> },
  { path: 'payroll/w4-recollection', element: <RequireCapability cap="process:payroll"><W4SsnRecollection /></RequireCapability> },
  { path: 'benefits/lifecycle', element: <RequireCapability cap="view:hr-admin"><BenefitsLifecycle /></RequireCapability> },
  { path: 'learning', element: <RequireCapability cap="view:dashboard"><LearningHome /></RequireCapability> },
  { path: 'worktags', element: <RequireCapability cap="view:hr-admin"><WorktagsHome /></RequireCapability> },
  { path: 'reports', element: <RequireCapability cap="view:analytics"><ReportsHome /></RequireCapability> },
  { path: 'reports/people', element: <RequireCapability cap="view:analytics"><PeopleAnalytics /></RequireCapability> },
  { path: 'reimbursements', element: <RequireCapability cap="view:dashboard"><ReimbursementsHome /></RequireCapability> },
  { path: 'time-attendance/kiosk', element: <RequireCapability cap="manage:time"><KioskAdmin /></RequireCapability> },
  { path: 'time-attendance/timesheets', element: <RequireCapability cap="manage:time"><TimesheetsView /></RequireCapability> },
  { path: 'time-attendance/timesheets/history/:associateId', element: <RequireCapability cap="manage:time"><TimesheetHistory /></RequireCapability> },
  { path: 'fieldglass', element: <RequireCapability cap="process:payroll"><FieldglassSetup /></RequireCapability> },
];

/** The signed-in shell's route (RequireAuth → Layout); warmSignedInStart looks for it. */
const SHELL_ROUTE_ID = 'shell';

export const router = createBrowserRouter([
  { path: '/login', element: <Login />, errorElement: <RouterErrorPage /> },
  // Brief 2-3: an organization's sign-in by its slug, for shared email domains.
  { path: '/login/:slug', element: <Login />, errorElement: <RouterErrorPage /> },
  // Self-serve password reset — public, two-step flow. /forgot-password
  // takes an email and emails a magic link; /reset-password/:token
  // accepts the new password.
  {
    path: '/forgot-password',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <ForgotPassword />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    path: '/reset-password/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <ResetPassword />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // Two-step email change — public, the token in the URL is the
  // authorization. Confirm endpoint swaps the email server-side and
  // bumps tokenVersion (every existing session is now stale).
  {
    path: '/confirm-email-change/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <ConfirmEmailChange />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // Public landing for "add this app to your home screen" — no auth, so we
  // can drop the link in invite emails before the associate has a password.
  {
    path: '/install',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <Install />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // The native app's system-browser sign-in (SSO, passkeys) lands here and
  // hands back to the app with a one-time code (pages/NativeHandoff).
  {
    path: '/native-handoff',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <NativeHandoff />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // The public Trust Center (UX upgrade step 4): no auth and no Layout; a
  // prospect's security review has no account.
  {
    path: '/trust-center',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <PublicTrustPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // The public status page and the accessibility statement sit beside the
  // Trust Center: a buyer's review and a person who needs the contact line
  // read them without an account.
  {
    path: '/status',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <PublicStatusPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    path: '/accessibility',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <AccessibilityPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    path: '/accept-invite/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <AcceptInvite />
      </Suspense>
    ),
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
  // An organization's own hotline (F500 G5): the server files the report
  // into the organization the address names.
  {
    path: '/hotline/:slug',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <HotlinePage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // A driver's shared trip — public by its signed, expiring link. Shows the
  // van and its next stop, never the riders (routes/transportOps /track).
  {
    path: '/track/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <TrackPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // The public careers site — the address every job posting shows. No
  // auth and no Layout: an applicant has no account.
  {
    path: '/careers',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <CareersListPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    path: '/careers/:slug',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <CareerPostingPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // A candidate's offer: read the letter, sign it. The link in the offer
  // email is the key — no login, retired once used.
  // Check a signed credential (W3C Verifiable Credential) — no login: an
  // outside employer pastes or uploads what a worker gave them.
  {
    path: '/verify',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <VerifyCredentialPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // A shared credential wallet: the link is the key, there is no account.
  {
    path: '/w/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <WalletVerifyPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // A candidate's own page: their stage, interview and the documents we
  // asked for. The link in the email or text is the key — no login.
  {
    path: '/candidate/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <CandidatePortalPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  // A store manager's quarterly NPS answer — outside the portal, no login.
  {
    path: '/nps/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <NpsSurveyPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    path: '/offer/:token',
    element: (
      <Suspense fallback={<PublicRouteFallback />}>
        <OfferLetterPage />
      </Suspense>
    ),
    errorElement: <RouterErrorPage />,
  },
  {
    id: SHELL_ROUTE_ID,
    path: '/',
    element: (
      <RequireAuth>
        {/* Layout is lazy now, so it needs a boundary. Same full-screen
            spinner the auth splash uses, so the /auth/me wait and the chunk
            fetch read as one continuous load, not two loading states. */}
        <Suspense fallback={<PublicRouteFallback />}>
          <Layout />
        </Suspense>
      </RequireAuth>
    ),
    errorElement: <RouterErrorPage />,
    children: [
      ...LAYOUT_ROUTES,
      ...ONBOARDING_ROUTES,
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
        {/* Layout is lazy now, so it needs a boundary. Same full-screen
            spinner the auth splash uses, so the /auth/me wait and the chunk
            fetch read as one continuous load, not two loading states. */}
        <Suspense fallback={<PublicRouteFallback />}>
          <Layout />
        </Suspense>
      </RequireAuth>
    ),
    errorElement: <RouterErrorPage />,
    children: [{ index: true, element: <NotFound /> }],
  },
]);

/**
 * A returning visitor's signed-in first screen starts downloading with the
 * session check instead of after it.
 *
 * Without this the boot was a relay: /auth/me, then (RequireAuth satisfied)
 * the Layout chunk, then (the Layout rendered) the home's chunk, then its
 * data — on a phone each leg a few round trips, and the associate's home
 * waited out all of them. main.tsx calls this before the first render with
 * the identity this device remembers (lib/offlineSession); both imports are
 * the very modules the lazy routes resolve later, so nothing loads twice.
 * The remembered identity only chooses what to fetch — RequireAuth still
 * waits for /auth/me before anything signed-in renders.
 */
export function warmSignedInStart(remembered: AuthUser): void {
  const matches = matchRoutes(router.routes, window.location);
  if (!matches || matches[0]?.route.id !== SHELL_ROUTE_ID) return;
  void loadLayout().catch(() => undefined);
  // The sidebar is its own chunk, fetched only where it shows (ShellSidebar).
  if (window.matchMedia?.(SIDEBAR_QUERY).matches) void importSidebar().catch(() => undefined);
  const leaf = matches[matches.length - 1]?.route;
  if (leaf?.index) preloadDashboard(remembered);
  // Any other page opened straight (a reload, a link in a notification)
  // starts its own chunk now too, instead of after the shell has rendered.
  else preloadElement(leaf?.element);
}
