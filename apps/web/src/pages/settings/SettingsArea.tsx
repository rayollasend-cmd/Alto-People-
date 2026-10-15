import { useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import {
  Activity,
  Bot,
  Building2,
  CreditCard,
  FileSpreadsheet,
  Inbox,
  KeyRound,
  Map,
  Network,
  Palette,
  Plug,
  ScrollText,
  Shapes,
  ShieldCheck,
  Store,
  Users,
  Workflow,
  Briefcase,
} from 'lucide-react';
import { useAuth, useTenant } from '@/lib/auth';
import { PLATFORM_OPERATOR_TENANT_ID } from '@alto-people/shared';
import { SettingsTemplate, type SettingsRailItem } from '@/components/templates';

/**
 * Settings & Trust (UX upgrade step 3; design system §4.4): one area, one
 * rail, for everything an organization configures and everything an
 * auditor or IT admin checks. The pages did not move: this is a layout
 * route around their existing paths, so every link and pin still works
 * and each page keeps its own header. The rail shows only what this
 * person may open.
 */
export function SettingsArea() {
  const { can } = useAuth();
  const tenant = useTenant();
  const rail = useMemo<SettingsRailItem[]>(() => {
    const items: Array<SettingsRailItem & { show: boolean }> = [
      // Organization
      { key: 'organization', label: 'Organization', to: '/admin/organization', icon: Building2, section: 'Organization', show: can('view:hr-admin') },
      { key: 'sites', label: 'Sites', to: '/admin/sites', icon: Store, section: 'Organization', show: can('view:org') },
      { key: 'org-units', label: 'Organizational tree', to: '/admin/org-units', icon: Network, section: 'Organization', show: can('view:org') },
      { key: 'regions', label: 'Regions', to: '/admin/regions', icon: Map, section: 'Organization', show: can('view:org') && tenant.modules.clientPortal },
      { key: 'employers', label: 'Employers of record', to: '/admin/employers', icon: Briefcase, section: 'Organization', show: can('view:org') },
      { key: 'branding', label: 'Branding & terminology', to: '/admin/branding', icon: Palette, section: 'Organization', show: can('view:hr-admin') },
      // Access & trust
      { key: 'users', label: 'Users, roles & access', to: '/admin/users', icon: Users, section: 'Access & trust', show: can('view:hr-admin') },
      { key: 'sign-in', label: 'Sign-in & provisioning', to: '/admin/sign-in', icon: KeyRound, section: 'Access & trust', show: can('manage:org') },
      { key: 'audit', label: 'Audit & integrity', to: '/audit', icon: ScrollText, section: 'Access & trust', show: can('view:audit') },
      { key: 'compliance-evidence', label: 'Security & compliance', to: '/admin/compliance-evidence', icon: ShieldCheck, section: 'Access & trust', show: can('view:org') },
      { key: 'agents', label: 'Agents & gates', to: '/agents', icon: Bot, section: 'Access & trust', show: can('view:org') },
      { key: 'workers', label: 'Worker types', to: '/workers', icon: Workflow, section: 'Access & trust', show: can('view:org') && tenant.modules.robotics },
      // Platform
      { key: 'billing', label: 'Billing', to: '/admin/billing', icon: CreditCard, section: 'Platform', show: can('manage:org') || can('process:payroll') },
      { key: 'integrations', label: 'Integrations', to: '/integrations', icon: Plug, section: 'Platform', show: can('view:integrations') },
      { key: 'developers', label: 'Developers', to: '/developers', icon: FileSpreadsheet, section: 'Platform', show: can('view:integrations') },
      { key: 'reliability', label: 'Reliability', to: '/reliability', icon: Activity, section: 'Platform', show: can('view:product-analytics') },
      { key: 'product-analytics', label: 'Product usage', to: '/product-analytics', icon: Activity, section: 'Platform', show: can('view:product-analytics') },
      { key: 'design-system', label: 'Design system', to: '/design-system', icon: Shapes, section: 'Platform', show: can('view:product-analytics') },
      { key: 'platform-support', label: 'Support inbox', to: '/platform/support', icon: Inbox, section: 'Platform', show: can('manage:org') && tenant.id === PLATFORM_OPERATOR_TENANT_ID },
    ];
    return items.filter((i) => i.show).map(({ show: _show, ...rest }) => rest);
  }, [can, tenant.modules.clientPortal, tenant.modules.robotics, tenant.id]);

  return (
    <SettingsTemplate areaLabel="Settings & Trust" rail={rail}>
      <Outlet />
    </SettingsTemplate>
  );
}
