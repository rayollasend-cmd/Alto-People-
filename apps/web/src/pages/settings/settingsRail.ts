import { createElement, useMemo } from 'react';
import {
  Activity,
  ArrowUpRight,
  Archive,
  Bot,
  Building2,
  CreditCard,
  FileSpreadsheet,
  Inbox,
  Landmark,
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
  UserCog,
  ListTodo,
  Briefcase,
  ClipboardCheck,
  Megaphone,
  Workflow,
} from 'lucide-react';
import { PLATFORM_OPERATOR_TENANT_ID } from '@alto-people/shared';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { applyTerms, MODULES, type ModuleKey } from '@/lib/modules';
import { MODULE_ICONS } from '@/lib/moduleIcons';
import type { SettingsRailItem } from '@/components/templates';

/** A rail row with the one line the overview shows beneath its name. */
export interface SettingsRailEntry extends SettingsRailItem {
  description: string;
  /**
   * The words people search for that are not in the name or the line
   * ("two-step", "MFA", "finance mailbox"): the overview's search reads
   * them, so a setting is found by what it does, not only by its page.
   */
  keywords?: string;
  /** Opens a page outside Settings & trust (the rail disappears there): drawn with ↗. */
  leaves?: boolean;
}

/**
 * The rail rows that ARE a module take the module's name — the one the
 * sidebar, the palette, the page's own title and its breadcrumb use, in the
 * tenant's words ("Stores", not a hard-coded "Sites" over a page that says
 * Stores). The rest are pages only this rail lists.
 */
const RAIL_MODULE: Partial<Record<string, ModuleKey>> = {
  organization: 'tenant-profile',
  sites: 'sites',
  'org-units': 'org-units',
  employers: 'employers',
  'document-retention': 'document-retention',
  workflows: 'workflows',
  branding: 'branding',
  users: 'users',
  'sign-in': 'sign-in',
  audit: 'audit',
  'approval-record': 'approval-record',
  'access-certifications': 'access-certifications',
  'compliance-evidence': 'compliance-evidence',
  trust: 'trust-center',
  billing: 'billing',
  integrations: 'integrations',
  reliability: 'reliability',
  'product-analytics': 'product-analytics',
  'design-system': 'design-system',
};

/**
 * Settings & Trust, as one list: the area shell draws it as the rail and the
 * overview (SettingsHome) draws it as cards, so the two can never disagree
 * about what the area holds. Only what this person may open.
 */
export function useSettingsRail(): SettingsRailEntry[] {
  const { can } = useAuth();
  const tenant = useTenant();
  const term = useTerm();
  return useMemo<SettingsRailEntry[]>(() => {
    // (`Map` here is the lucide icon; the lookup is a plain record.)
    const named: Partial<Record<ModuleKey, string>> = Object.fromEntries(applyTerms(MODULES, term, tenant.modules).map((m) => [m.key, m.label]));
    const items: Array<SettingsRailEntry & { show: boolean }> = [
      // Organization
      { key: 'organization', label: 'Organization', to: '/admin/organization', icon: Building2, section: 'Organization', description: 'Business model, the modules this organization runs, what it calls things, the workweek and time zone.', keywords: 'workweek week starts company time zone timezone business model modules terminology words terms', show: can('view:hr-admin') },
      { key: 'sites', label: 'Sites', to: '/admin/sites', icon: Store, section: 'Organization', description: 'Every place work happens: time zone, state, and the unit of the tree it belongs to.', keywords: 'stores locations address geofence', show: can('view:org') },
      { key: 'task-policy', label: 'Task assignment', to: '/admin/task-policy', icon: ListTodo, section: 'Organization', description: 'How work is handed to people, agents and robots at each site.', show: can('view:scheduling') },
      { key: 'org-chart', label: 'Regions & places', to: '/org/chart?view=field', icon: Map, section: 'Organization', description: 'Regions, their places and who leads them — arranged in the Org chart.', keywords: 'regions markets districts', leaves: true, show: can('view:org') },
      { key: 'org-units', label: 'Cost centers & ledger codes', to: '/admin/org-units', icon: Network, section: 'Organization', description: 'The ledger code labor posts to, and which places map to each.', show: can('view:org') },
      { key: 'employers', label: 'Employers of record', to: '/admin/employers', icon: Briefcase, section: 'Organization', description: 'Who legally employs each person: the name, EIN and address their forms print.', show: can('view:org') },
      { key: 'document-retention', label: 'Document retention', to: '/admin/document-retention', icon: Archive, section: 'Organization', description: 'How long each kind of document is kept after a person leaves, and what the next sweep would purge.', show: can('view:hr-admin') },
      { key: 'workflows', label: 'Workflows', to: '/workflows', icon: Workflow, section: 'Organization', description: 'Automations that run on hires, time-off decisions, position changes and other events.', keywords: 'automation trigger', leaves: true, show: can('view:org') },
      { key: 'communications', label: 'Communications', to: '/admin/communications', icon: Megaphone, section: 'Organization', description: 'Which channels can send, WhatsApp templates, the do-not-email list, and who hears about what.', keywords: 'email sms text whatsapp push notifications provider unsubscribe', show: can('manage:communications') },
      { key: 'branding', label: 'Branding', to: '/admin/branding', icon: Palette, section: 'Organization', description: 'Name, colour, logo, sender and support email on every email, and the assistant’s name.', keywords: 'logo color colour sender support email assistant name hugo', show: can('view:hr-admin') },
      { key: 'finance', label: 'Finance', to: '/admin/finance', icon: Landmark, section: 'Organization', description: 'The finance mailbox, an unverified bank change at cutoff, the remit-to on invoices, and the cash floor.', keywords: 'finance mailbox alerts remit-to remit to invoice statement how to pay ach cash floor minimum bank verification unverified payout hold', show: can('view:hr-admin') },
      // Access & trust
      { key: 'users', label: 'Users & access', to: '/admin/users', icon: Users, section: 'Access & trust', description: 'Every account, its role, reach and status; invite someone; open an account to change it.', keywords: 'accounts invite user disable deactivate password reset unlock locked break-glass last sign-in two-step mfa', show: can('view:hr-admin') },
      { key: 'roles', label: 'Roles & permissions', to: '/admin/roles', icon: UserCog, section: 'Access & trust', description: 'What each role may do, the custom roles built on them, and who holds each.', keywords: 'permissions capabilities custom role holders', show: can('view:hr-admin') },
      { key: 'approvals', label: 'Approval rules', to: '/admin/approvals', icon: ClipboardCheck, section: 'Access & trust', description: 'Which changes take a second person before they land: pay rates, payroll, separations, access.', keywords: 'second person maker checker approval approve pay rate bill rate separation elevation requisition payroll review sign-off', show: can('view:hr-admin') },
      { key: 'sign-in', label: 'Sign-in', to: '/admin/sign-in', icon: KeyRound, section: 'Access & trust', description: 'Two-step sign-in, your identity provider and its domains, directory provisioning, and sessions.', keywords: 'two-step two step 2fa mfa multi-factor authenticator sso saml oidc okta entra scim directory groups sessions password passkey', show: can('manage:org') },
      { key: 'audit', label: 'Audit & integrity', to: '/audit', icon: ScrollText, section: 'Access & trust', description: 'Every event, searchable and exportable, on a chain you can verify.', keywords: 'audit log trail history who did what sign-ins exports SIEM retention hash chain investigation', show: can('view:audit') },
      { key: 'approval-record', label: 'Approval record', to: '/audit/approvals', icon: ClipboardCheck, section: 'Access & trust', description: 'Every change that went to a second person: who asked, who decided, the before and after.', show: can('view:audit') || can('manage:org') || can('process:payroll') },
      { key: 'access-certifications', label: 'Access certifications', to: '/admin/access-certifications', icon: ClipboardCheck, section: 'Access & trust', description: 'The access review: campaigns where every account is kept, revoked or changed on the record, and the access report.', keywords: 'access review quarterly certification access report flagged accounts', show: can('manage:org') },
      { key: 'compliance-evidence', label: 'Compliance evidence', to: '/admin/compliance-evidence', icon: ShieldCheck, section: 'Access & trust', description: 'Every control with its latest evidence, and the sign-offs a person owes.', keywords: 'SOC 2 controls evidence security contact alerts encryption backups TLS', show: can('view:org') },
      { key: 'trust', label: 'Trust Center', to: '/trust', icon: ShieldCheck, section: 'Access & trust', description: 'How the platform is run, with the evidence, and your own numbers.', keywords: 'SOC 2 report security questionnaire sub-processors DPA penetration test', show: can('manage:org') || can('view:executive') || can('view:audit') },
      // The agents themselves are a People page (/agents); this is their governance.
      { key: 'agents', label: 'Agents & gates', to: '/admin/agents', icon: Bot, section: 'Access & trust', description: 'Who approves what, certification and credentials across agents, the MCP tools, the decision record, and the switch that stops every agent.', keywords: 'AI agents approval gates policies kill switch suspend MCP credentials certification', show: can('view:org') },
      // Platform
      { key: 'billing', label: 'Billing', to: '/admin/billing', icon: CreditCard, section: 'Platform', description: 'Your plan, this month, and your invoices.', show: can('manage:org') || can('process:payroll') },
      { key: 'integrations', label: 'Integrations', to: '/integrations', icon: Plug, section: 'Platform', description: 'Payouts, screening, filing, tax, your bank, and your HR and VMS systems.', keywords: 'Wise payouts E-Verify background checks drug tests tax filing ACH bank feeds Fieldglass ADP Workday UKG Beeline', show: can('view:integrations') },
      { key: 'developers', label: 'API & webhooks', to: '/developers', icon: FileSpreadsheet, section: 'Platform', description: 'The public API: the apps and keys that call it, the webhooks it sends, and its reference.', keywords: 'developers API keys OAuth apps webhooks OpenAPI reference', show: can('view:integrations') },
      { key: 'reliability', label: 'Reliability', to: '/reliability', icon: Activity, section: 'Platform', description: 'Errors against the budget, speed by route, and what restarted.', show: can('view:product-analytics') },
      { key: 'product-analytics', label: 'Product usage', to: '/product-analytics', icon: Activity, section: 'Platform', description: 'Who signs in, what they open, and what breaks.', show: can('view:product-analytics') },
      { key: 'design-system', label: 'Design system', to: '/design-system', icon: Shapes, section: 'Platform', description: 'The written standard the product follows.', show: can('view:product-analytics') },
      { key: 'platform-support', label: 'Support inbox', to: '/platform/support', icon: Inbox, section: 'Platform', description: 'Requests from every organization on the platform.', keywords: 'support tickets help requests', show: can('manage:org') && tenant.id === PLATFORM_OPERATOR_TENANT_ID },
    ];
    return items
      .filter((i) => i.show)
      .map(({ show: _show, ...item }) => {
        // A row that leaves the area says so (the rail is gone on the other side).
        const rest: SettingsRailEntry = item.leaves
          ? { ...item, status: createElement(ArrowUpRight, { className: 'h-3.5 w-3.5 text-ink-muted', role: 'img', 'aria-label': 'Opens outside Settings & trust' }) }
          : item;
        // A module's own name and glyph — the sidebar's and the palette's —
        // so "Approval record" and "Access certifications" stop sharing one icon.
        const key = RAIL_MODULE[rest.key];
        const label = key ? named[key] : undefined;
        return key ? { ...rest, label: label ?? rest.label, icon: MODULE_ICONS[key] ?? rest.icon } : rest;
      });
  }, [can, tenant.modules, tenant.id, term]);
}
