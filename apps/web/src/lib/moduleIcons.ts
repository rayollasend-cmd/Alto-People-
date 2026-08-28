import type { LucideIcon } from 'lucide-react';
import {
  Award,
  Briefcase,
  Building2,
  Calendar,
  CalendarOff,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  FileText,
  HeartPulse,
  LineChart,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Smartphone,
  Timer,
  UserPlus,
} from 'lucide-react';
import { Inbox as ApprovalsIcon, Receipt as ReimbursementsIcon, GraduationCap as LearningIcon, Network as OrgChartIcon, Users as UsersIcon, Workflow as WorkflowIcon, UserCircle as UserCircleIcon, Wallet as WalletIcon, Store as StoreIcon, BadgeDollarSign as PayRulesIcon, Megaphone as MegaphoneIcon, PartyPopper as CelebrationsIcon, Laptop as AssetsIcon, Activity as PulseIcon, BarChart3 as HeadcountIcon, Sparkles as SkillsIcon, GraduationCap as MentorshipIcon, ShieldAlert as ExpirationsIcon, Route as LearningPathsIcon, Crown as SuccessionIcon, ShieldQuestion as ProbationIcon, CalendarDays as HolidayIcon, Gavel as DisciplineIcon, LogOut as SeparationIcon, Briefcase as InternalJobsIcon, Syringe as VaccinationsIcon, FileSignature as AgreementsIcon, MessageCircle as HrCasesIcon, BookOpen as KbIcon, Target as RampIcon, TrendingUp as CareerIcon, GraduationCap as TuitionIcon, Siren as HotlineIcon, Coins as EquityIcon, Heart as VolunteerIcon, Plug as IntegrationsIcon, Palette as BrandingIcon, CreditCard as BillingIcon, FileBarChart as ReportsIcon } from 'lucide-react';
import type { ModuleKey } from './modules';

/**
 * Module icons, deliberately separate from lib/modules.ts.
 *
 * App.tsx imports MODULES eagerly to generate routes, and it only reads
 * path/key/label/description. While the icon components hung off those same
 * objects, importing the route metadata dragged ~78 lucide icons into the
 * blocking `main` chunk — downloaded by everyone who opened /login and
 * rendered by none of them.
 *
 * Only the nav surfaces (Sidebar, MobileNav, BottomTabBar, CommandPalette)
 * need the icons, and all of those live under the lazy Layout, so keying them
 * here moves the whole icon graph into the Layout chunk.
 */
export const MODULE_ICONS: Record<ModuleKey, LucideIcon> = {
  'me': UserCircleIcon,
  'onboarding': ClipboardList,
  'recruiting': UserPlus,
  'people': UsersIcon,
  'org': OrgChartIcon,
  'org-chart': OrgChartIcon,
  'celebrations': CelebrationsIcon,
  'assets': AssetsIcon,
  'pulse': PulseIcon,
  'headcount': HeadcountIcon,
  'skills': SkillsIcon,
  'mentorship': MentorshipIcon,
  'expirations': ExpirationsIcon,
  'learning-paths': LearningPathsIcon,
  'succession': SuccessionIcon,
  'probation': ProbationIcon,
  'holidays': HolidayIcon,
  'discipline': DisciplineIcon,
  'separations': SeparationIcon,
  'internal-jobs': InternalJobsIcon,
  'vaccinations': VaccinationsIcon,
  'agreements': AgreementsIcon,
  'hr-cases': HrCasesIcon,
  'help-center': KbIcon,
  'ramp': RampIcon,
  'career': CareerIcon,
  'learning': LearningIcon,
  'tuition': TuitionIcon,
  'hotline': HotlineIcon,
  'equity': EquityIcon,
  'volunteer': VolunteerIcon,
  'team': UsersIcon,
  'workflows': WorkflowIcon,
  'clients': Building2,
  'performance': Award,
  'time-attendance': Timer,
  'kiosk': Smartphone,
  'time-off': CalendarOff,
  'scheduling': Calendar,
  'ops': ClipboardCheck,
  'approvals': ApprovalsIcon,
  'payroll': DollarSign,
  'payroll-tax': DollarSign,
  'payroll-compliance': DollarSign,
  'marketplace': StoreIcon,
  'payrules': PayRulesIcon,
  'reimbursements': ReimbursementsIcon,
  'compensation': WalletIcon,
  'benefits': HeartPulse,
  'documents': FileText,
  'doc-templates': ScrollText,
  'labor-costs': DollarSign,
  'compliance': ShieldCheck,
  'audit': ScrollText,
  'users': UsersIcon,
  'branding': BrandingIcon,
  'billing': BillingIcon,
  'dircomms': MegaphoneIcon,
  'communications': MessageSquare,
  'analytics': LineChart,
  'reports': ReportsIcon,
  'integrations': IntegrationsIcon,
};

/** Icon for the Dashboard entry, which isn't a module. */
export const DASHBOARD_ICON: LucideIcon = Briefcase;

// Re-exported so nav components don't need their own lucide imports.
export {
  Award,
  Briefcase,
  Building2,
  Calendar,
  CalendarOff,
  ClipboardList,
  DollarSign,
  FileText,
  HeartPulse,
  LineChart,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Timer,
  UserPlus,
};
