import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { ROLE_LABELS, type OrgBranding } from '@alto-people/shared';
import { DEFAULT_TENANT } from '@/lib/auth';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn(), useConfirmIfMounted: () => null }));

import { apiFetch } from '@/lib/api';
import { SettingsHome } from '@/pages/admin/SettingsHome';
import { ApprovalRulesPage } from '@/pages/admin/ApprovalRulesPage';
import { FinanceSettingsPage } from '@/pages/admin/FinanceSettingsPage';
import { BrandingHome } from '@/pages/admin/BrandingHome';
import { SignInSettings } from '@/pages/admin/SignInSettings';
import { RolesPage } from '@/pages/admin/RolesPage';

/**
 * Settings & trust at the F500 bar (G4): the overview says what needs
 * attention and finds a setting by what it does; the settings that were
 * misfiled on Branding live where people look (Sign-in, Finance, Approval
 * rules, Organization); Roles opens on every role, in words.
 */

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

const org: OrgBranding = {
  orgName: 'Coastal Resort',
  assistantName: 'Hugo',
  activeWindowDays: 14,
  weekStartsOn: 6,
  timezone: 'America/Chicago',
  senderName: null,
  supportEmail: null,
  primaryColor: null,
  logoUrl: null,
  logoUpdatedAt: null,
  mfaRequirement: 'OFF',
  financeMailbox: 'finance@coastal.example',
  unverifiedPayoutPolicy: 'PREVIOUS_VERIFIED',
  payChangeApprovalPct: 10,
  payChangeAlwaysApprove: false,
  billRateApproval: true,
  separationSecondPerson: true,
  selfServiceApproval: false,
  roleChangeApproval: true,
  requisitionApproval: true,
  payrollReviewRequired: true,
  remitToName: null,
  remitToAddress: null,
  remitToInstructions: null,
  cashMinimum: null,
  updatedAt: new Date(0).toISOString(),
};

let patches: Array<Record<string, unknown>> = [];
beforeEach(() => {
  patches = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === '/admin/org/settings' && init?.method === 'PATCH') {
      patches.push(init.body!);
      return { ...org, ...init.body };
    }
    if (path === '/admin/org/settings') return org;
    if (path === '/admin/settings-health')
      return {
        items: [
          { key: 'communications', tone: 'warn', label: 'Email not connected', message: "Email isn't connected", action: 'Connect' },
          { key: 'access-certifications', tone: 'warn', label: '1 past due', message: '1 access review is past due', action: 'Review' },
        ],
      };
    if (path === '/identity') return { connections: [], domains: [], scimTokens: [] };
    if (path === '/identity/security-policy')
      return { sessionIdleMinutes: null, sessionAbsoluteHours: null, allowedCidrsInternal: [], allowedCidrsClient: [], allowedCidrsAssociate: [], deviceTrustEnabled: false, deviceTrustDays: 30, breakGlassEnabled: false };
    if (path === '/tenant-roles/scim-groups') return { mappings: [], groups: [] };
    if (path === '/tenant-roles')
      return {
        capabilities: ['view:payroll', 'process:payroll', 'view:audit'],
        roles: [
          { id: 'system:FINANCE_ACCOUNTANT', name: 'Finance', description: null, archetype: 'FINANCE_ACCOUNTANT', system: true, capabilities: ['process:payroll', 'view:payroll'], holders: 2, offered: true },
          { id: 'system:MANAGER', name: 'Manager', description: null, archetype: 'MANAGER', system: true, capabilities: ['view:audit'], holders: 0, offered: true },
          { id: 'r-custom', name: 'Payroll reader', description: 'Reads, never runs.', archetype: 'FINANCE_ACCOUNTANT', system: false, capabilities: ['view:payroll'], holders: 1, offered: true },
        ],
      };
    if (typeof path === 'string' && path.startsWith('/admin/users')) return { users: [], total: 0, counts: { ACTIVE: 0, INVITED: 0, DISABLED: 0 } };
    return undefined;
  });
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

describe('Settings & trust overview', () => {
  it('leads with what needs attention, each with the one action that fixes it', async () => {
    renderAsAdmin(<SettingsHome />, '/admin');
    const box = await screen.findByRole('region', { name: 'Needs attention' }).catch(() => screen.findByText('Needs attention').then((h) => h.closest('section')!));
    expect(within(box).getByText("Email isn't connected")).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: /Connect/ })).toHaveAttribute('href', '/admin/communications');
    expect(within(box).getByText('1 access review is past due')).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: /Review/ })).toHaveAttribute('href', '/admin/access-certifications');
  });

  it('finds a setting by what it does: two-step, MFA, finance mailbox, workweek', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SettingsHome />, '/admin');
    const search = await screen.findByRole('searchbox', { name: 'Find a setting' }).catch(() => screen.getByLabelText('Find a setting'));
    const only = async (q: string, label: string) => {
      await user.clear(search);
      await user.type(search, q);
      const cards = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/'));
      expect(cards.map((a) => a.textContent)).toEqual(expect.arrayContaining([expect.stringContaining(label)]));
    };
    await only('two-step', 'Sign-in');
    await only('MFA', 'Sign-in');
    await only('finance mailbox', 'Finance');
    await only('workweek', 'Organization');
    await only('second person', 'Approval rules');
  });

  it('marks a card that leaves the area', async () => {
    renderAsAdmin(<SettingsHome />, '/admin');
    const card = (await screen.findByText('Regions & places')).closest('a')!;
    expect(within(card).getByRole('img', { name: 'Opens outside Settings & trust' })).toBeInTheDocument();
  });
});

describe('Branding keeps identity only', () => {
  it('no two-step, finance or approval rules here — one save for the identity fields', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<BrandingHome />, '/admin/branding', { ...DEFAULT_TENANT, assistantName: 'Hugo' });
    const name = (await screen.findByLabelText(/Organization name/)) as HTMLInputElement;
    expect(screen.queryByText('Require two-step sign-in')).toBeNull();
    expect(screen.queryByLabelText(/Finance mailbox/)).toBeNull();
    expect(screen.queryByText('Second person')).toBeNull();
    expect(screen.queryByLabelText(/Workweek/)).toBeNull();
    expect(screen.queryByText(/RESEND_FROM/)).toBeNull();
    expect(screen.queryByText(/data: URI/)).toBeNull();
    const bar = screen.getByTestId('settings-save-bar');
    expect(bar).toHaveTextContent('Everything is saved.');
    await user.clear(name);
    await user.type(name, 'Coastal Resort Holdings');
    expect(bar).toHaveTextContent('1 unsaved change.');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ orgName: 'Coastal Resort Holdings' });
    expect(patches[0]).not.toHaveProperty('mfaRequirement');
  });
});

describe('Settings that moved out of Branding', () => {
  it('Approval rules: the switches, one save, sends only the rules', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<ApprovalRulesPage />, '/admin/approvals');
    const separation = await screen.findByRole('checkbox', { name: 'Completing a separation' });
    // Bill rates are a module; the default tenant has it.
    expect(screen.getByRole('checkbox', { name: 'Bill-rate changes' })).toBeInTheDocument();
    await user.click(separation);
    const bar = screen.getByTestId('settings-save-bar');
    expect(bar).toHaveTextContent('1 unsaved change.');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ separationSecondPerson: false, payChangeApprovalPct: 10 });
    expect(patches[0]).not.toHaveProperty('orgName');
  });

  it('Approval rules: no bill-rate switch for an organization without bill rates', async () => {
    renderAsAdmin(<ApprovalRulesPage />, '/admin/approvals', { ...DEFAULT_TENANT, modules: { ...DEFAULT_TENANT.modules, billRates: false } });
    await screen.findByRole('checkbox', { name: 'Completing a separation' });
    expect(screen.queryByRole('checkbox', { name: 'Bill-rate changes' })).toBeNull();
  });

  it('Finance: the mailbox and the cash floor, validated, one save', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<FinanceSettingsPage />, '/admin/finance');
    const mailbox = (await screen.findByLabelText(/Finance mailbox/)) as HTMLInputElement;
    expect(mailbox.value).toBe('finance@coastal.example');
    const bar = screen.getByTestId('settings-save-bar');
    await user.clear(mailbox);
    await user.type(mailbox, 'not-an-address');
    expect(screen.getByText(/bare address/)).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(mailbox);
    await user.type(mailbox, 'money@coastal.example');
    await user.type(screen.getByLabelText(/Amount/), '25000');
    expect(bar).toHaveTextContent('2 unsaved changes.');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ financeMailbox: 'money@coastal.example', cashMinimum: 25000 });
  });

  it('Sign-in: two-step lives here and saves at once; one Add identity provider asks which kind', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SignInSettings />, '/admin/sign-in');
    const control = await screen.findByRole('radiogroup', { name: 'Require two-step sign-in' });
    expect(screen.getByText('Optional')).toBeInTheDocument();
    await user.click(within(control).getByRole('radio', { name: 'Admins' }));
    await waitFor(() => expect(patches).toEqual([{ mfaRequirement: 'ADMINS' }]));
    expect(await screen.findByText('Required for admins')).toBeInTheDocument();
    // The groups that grant a role sit with directory provisioning.
    expect(screen.getByText('Groups that grant a role')).toBeInTheDocument();
    // One button, then the kind.
    expect(screen.queryByRole('button', { name: /^SAML$/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add identity provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add identity provider' });
    await user.click(within(dialog).getByRole('button', { name: /SAML/ }));
    expect(await screen.findByText('New SAML sign-in')).toBeInTheDocument();
  });
});

describe('Roles & permissions', () => {
  it('opens on every role with its holders linked; a row opens it, in words', async () => {
    const user = userEvent.setup();
    renderAsAdmin(
      <Routes>
        <Route path="/admin/roles" element={<><RolesPage /><Where /></>} />
      </Routes>,
      '/admin/roles',
    );
    const table = await screen.findByRole('table', { name: 'Roles' });
    const custom = within(table).getByText('Payroll reader').closest('tr')!;
    expect(within(custom).getByText('Custom')).toBeInTheDocument();
    expect(within(custom).getByText('1 of 2')).toBeInTheDocument();
    const finance = within(table).getByText(ROLE_LABELS.FINANCE_ACCOUNTANT).closest('tr')!;
    expect(within(finance).getByRole('link', { name: '2' })).toHaveAttribute('href', '/admin/users?role=FINANCE_ACCOUNTANT&status=all');
    // A built-in role reads as a list in words, with no disabled checkboxes.
    await user.click(within(finance).getByText(ROLE_LABELS.FINANCE_ACCOUNTANT));
    const drawer = await screen.findByRole('dialog');
    expect(screen.getByTestId('where')).toHaveTextContent('role=system%3AFINANCE_ACCOUNTANT');
    expect(within(drawer).getByText('Run payroll')).toBeInTheDocument();
    expect(within(drawer).getByText('See payroll')).toBeInTheDocument();
    expect(within(drawer).queryByRole('checkbox')).toBeNull();
    expect(within(drawer).queryByText('process:payroll')).toBeNull();
  });

  it('a custom role is switches, labelled in words with the key beneath', async () => {
    renderAsAdmin(
      <Routes>
        <Route path="/admin/roles" element={<RolesPage />} />
      </Routes>,
      '/admin/roles?role=r-custom',
    );
    const drawer = await screen.findByRole('dialog');
    const run = within(drawer).getByRole('checkbox', { name: /Run payroll/ });
    expect(run).not.toBeChecked();
    expect(within(drawer).getByRole('checkbox', { name: /See payroll/ })).toBeChecked();
    expect(within(drawer).getByText('process:payroll')).toBeInTheDocument();
  });
});
