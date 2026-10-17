import { useMemo } from 'react';
import {
  Activity,
  Archive,
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
  ListTodo,
  Briefcase,
  ClipboardCheck,
} from 'lucide-react';
import { PLATFORM_OPERATOR_TENANT_ID } from '@alto-people/shared';
import { useAuth, useTenant } from '@/lib/auth';
import type { SettingsRailItem } from '@/components/templates';

/** A rail row with the one line the overview shows beneath its name. */
export interface SettingsRailEntry extends SettingsRailItem {
  description: string;
}

/**
 * Settings & Trust, as one list: the area shell draws it as the rail and the
 * overview (SettingsHome) draws it as cards, so the two can never disagree
 * about what the area holds. Only what this person may open.
 */
export function useSettingsRail(): SettingsRailEntry[] {
  const { can } = useAuth();
  const tenant = useTenant();
  return useMemo<SettingsRailEntry[]>(() => {
    const items: Array<SettingsRailEntry & { show: boolean }> = [
      // Organization
      { key: 'organization', label: 'Organization', to: '/admin/organization', icon: Building2, section: 'Organization', description: 'Business model, the modules this organization runs, and what it calls things.', show: can('view:hr-admin') },
      { key: 'sites', label: 'Sites', to: '/admin/sites', icon: Store, section: 'Organization', description: 'Every place work happens: time zone, state, and the unit of the tree it belongs to.', show: can('view:org') },
      { key: 'task-policy', label: 'Task assignment', to: '/admin/task-policy', icon: ListTodo, section: 'Organization', description: 'How work is handed to people, agents and robots at each site.', show: can('view:scheduling') },
      { key: 'org-units', label: 'Organizational tree', to: '/admin/org-units', icon: Network, section: 'Organization', description: 'Divisions, regions, business units and cost centers with their ledger codes.', show: can('view:org') },
      { key: 'regions', label: 'Regions', to: '/admin/regions', icon: Map, section: 'Organization', description: 'Which sites roll up to which region, and the accounts that run each one.', show: can('view:org') && tenant.modules.clientPortal },
      { key: 'employers', label: 'Employers of record', to: '/admin/employers', icon: Briefcase, section: 'Organization', description: 'Who legally employs each person: the name, EIN and address their forms print.', show: can('view:org') },
      { key: 'document-retention', label: 'Document retention', to: '/admin/document-retention', icon: Archive, section: 'Organization', description: 'How long each kind of document is kept after a person leaves, and what the next sweep would purge.', show: can('view:hr-admin') },
      { key: 'branding', label: 'Branding & terminology', to: '/admin/branding', icon: Palette, section: 'Organization', description: 'Name, colour and logo on every email; the words the product uses for your people and places.', show: can('view:hr-admin') },
      // Access & trust
      { key: 'users', label: 'Users, roles & access', to: '/admin/users', icon: Users, section: 'Access & trust', description: 'Every account, its role and status; the permission matrix.', show: can('view:hr-admin') },
      { key: 'sign-in', label: 'Sign-in & provisioning', to: '/admin/sign-in', icon: KeyRound, section: 'Access & trust', description: 'Your identity provider, the email domains that lead to it, and SCIM.', show: can('manage:org') },
      { key: 'audit', label: 'Audit & integrity', to: '/audit', icon: ScrollText, section: 'Access & trust', description: 'Every event, searchable and exportable, on a chain you can verify.', show: can('view:audit') },
      { key: 'approval-record', label: 'Approval record', to: '/audit/approvals', icon: ClipboardCheck, section: 'Access & trust', description: 'Every change that went to a second person: who asked, who decided, the before and after.', show: can('view:audit') || can('manage:org') || can('process:payroll') },
      { key: 'access-certifications', label: 'Access certifications', to: '/admin/access-certifications', icon: ClipboardCheck, section: 'Access & trust', description: 'Every account reviewed by its manager on a campaign with a due date — keep, revoke or change, on the record.', show: can('manage:org') },
      { key: 'compliance-evidence', label: 'Security & compliance', to: '/admin/compliance-evidence', icon: ShieldCheck, section: 'Access & trust', description: 'Every control with its latest evidence, and the sign-offs a person owes.', show: can('view:org') },
      { key: 'trust', label: 'Trust Center', to: '/trust', icon: ShieldCheck, section: 'Access & trust', description: 'How the platform is run, with the evidence, and your own numbers.', show: can('manage:org') || can('view:executive') || can('view:audit') },
      // The agents themselves are a People page (/agents); this is their governance.
      { key: 'agents', label: 'Agents & gates', to: '/admin/agents', icon: Bot, section: 'Access & trust', description: 'Who approves what, certification and credentials across agents, the MCP tools, the decision record, and the switch that stops every agent.', show: can('view:org') },
      // Platform
      { key: 'billing', label: 'Billing', to: '/admin/billing', icon: CreditCard, section: 'Platform', description: 'Your plan, this month, and your invoices.', show: can('manage:org') || can('process:payroll') },
      { key: 'integrations', label: 'Integrations', to: '/integrations', icon: Plug, section: 'Platform', description: 'API keys, webhooks, and the systems this one talks to.', show: can('view:integrations') },
      { key: 'developers', label: 'Developers', to: '/developers', icon: FileSpreadsheet, section: 'Platform', description: 'The public API, its reference and your clients.', show: can('view:integrations') },
      { key: 'reliability', label: 'Reliability', to: '/reliability', icon: Activity, section: 'Platform', description: 'Errors against the budget, speed by route, and what restarted.', show: can('view:product-analytics') },
      { key: 'product-analytics', label: 'Product usage', to: '/product-analytics', icon: Activity, section: 'Platform', description: 'Who signs in, what they open, and what breaks.', show: can('view:product-analytics') },
      { key: 'design-system', label: 'Design system', to: '/design-system', icon: Shapes, section: 'Platform', description: 'The written standard the product follows.', show: can('view:product-analytics') },
      { key: 'platform-support', label: 'Support inbox', to: '/platform/support', icon: Inbox, section: 'Platform', description: 'Requests from every organization on the platform.', show: can('manage:org') && tenant.id === PLATFORM_OPERATOR_TENANT_ID },
    ];
    return items.filter((i) => i.show).map(({ show: _show, ...rest }) => rest);
  }, [can, tenant.modules.clientPortal, tenant.id]);
}
