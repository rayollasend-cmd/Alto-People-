import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_MODELS,
  BUSINESS_MODEL_LABEL,
  TENANT_MODULES,
  TENANT_MODULE_LABEL,
  TERM_KEYS,
  type BusinessModel,
  type TenantModule,
  type TenantModules,
  type TermKey,
  type TermLang,
  type Terminology,
  type UpdateTenantProfileInput,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { getTenantProfile, saveTenantProfile } from '@/lib/tenantProfileApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Brief 2-1b — the Organization profile: what kind of organization this
 * tenant is, which modules it runs, and what it calls things. The business
 * model only sets the defaults; the switches and the words are what the
 * app reads.
 */

const MODULE_NOTE: Record<TenantModule, string> = {
  scheduling: 'Shifts, the marketplace, approvals and holidays.',
  time: 'Time and attendance, timesheets, the kiosk and time off.',
  hrCases: 'HR cases, discipline and the hotline.',
  compliance: 'The compliance scorecard, documents, expirations, agreements and the audit packet.',
  payrollSync: 'The payroll integrations: Fieldglass, QuickBooks, external payments and the API. Payroll itself is always on.',
  housingLink: 'Bed counts on the season planner and the housing agreement.',
  transportation: 'Rides, vans, dispatch, the ride deduction and the transportation roles.',
  programs: 'Visa and sponsor programs and the season planner.',
  billRates: 'Client statements, billing and margin.',
  clientPortal: 'Clients, regions, the store and market portals and their digests.',
  robotics: 'The robot worker type and its page.',
  agentBuilder: 'Registering new agents from the Agents page.',
};

const TERM_GROUPS: Array<{ title: string; keys: TermKey[] }> = [
  { title: 'Nouns', keys: ['worker', 'workers', 'site', 'sites', 'manager', 'managers'] },
  { title: 'Navigation', keys: TERM_KEYS.filter((k) => k.startsWith('nav.')) },
  { title: 'Roles', keys: TERM_KEYS.filter((k) => k.startsWith('role.')) },
  { title: 'Labels', keys: TERM_KEYS.filter((k) => k.startsWith('label.')) },
];

const LANGS: Array<{ code: TermLang; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'tr', label: 'Türkçe' },
];

/** What each row is, in neutral words: the key, never one tenant's word for it. */
const TERM_DESCRIPTION: Record<TermKey, string> = {
  worker: 'Worker (one)',
  workers: 'Workers (many)',
  site: 'Site (one)',
  sites: 'Sites (many)',
  manager: 'Manager (one)',
  managers: 'Managers (many)',
  'nav.people': 'Navigation: people',
  'nav.scheduling': 'Navigation: scheduling',
  'nav.time': 'Navigation: time',
  'nav.kiosk': 'Navigation: kiosk',
  'nav.hrCases': 'Navigation: HR cases',
  'nav.compliance': 'Navigation: compliance',
  'nav.documents': 'Navigation: documents',
  'nav.payroll': 'Navigation: payroll',
  'nav.transport': 'Navigation: transportation',
  'nav.clients': 'Navigation: customer organizations',
  'nav.programs': 'Navigation: programs',
  'nav.headcount': 'Navigation: headcount',
  'role.associate': 'Role: the worker',
  'role.shiftSupervisor': 'Role: shift lead',
  'role.floorSupervisor': 'Role: floor lead',
  'role.manager': 'Role: manager',
  'role.clientPortal': 'Role: customer portal account',
  'role.transportationDirector': 'Role: transportation director',
  'role.driver': 'Role: driver',
  'label.client': 'Label: customer organization (one)',
  'label.clients': 'Label: customer organizations (many)',
  'label.shift': 'Label: shift',
  'label.timesheet': 'Label: timesheet',
  'label.paystub': 'Label: pay statement',
  'label.supervisor': 'Label: the manager (one)',
  'label.supervisors': 'Label: the managers (many)',
  'label.store': 'Label: the site (one)',
  'label.stores': 'Label: the sites (many)',
};

function termLabel(key: TermKey): string {
  return TERM_DESCRIPTION[key] ?? key;
}

export function TenantProfileHome() {
  const { can, refreshUser } = useAuth();
  const canManage = can('manage:org');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['tenant', 'profile'], queryFn: getTenantProfile });

  // Draft edits sit beside the loaded profile; Save sends only what changed.
  const [modelDraft, setModelDraft] = useState<BusinessModel | null>(null);
  const [moduleDraft, setModuleDraft] = useState<Partial<TenantModules>>({});
  const [termDraft, setTermDraft] = useState<Partial<Record<TermKey, Partial<Record<TermLang, string>>>>>({});

  const profile = query.data?.profile;
  const model = modelDraft ?? profile?.businessModel ?? 'WORKFORCE_PROVIDER';
  const modules: TenantModules | null = profile ? { ...profile.modules, ...moduleDraft } : null;
  const terms: Terminology | null = useMemo(() => {
    if (!profile) return null;
    const out = { ...profile.terminology } as Terminology;
    for (const [k, v] of Object.entries(termDraft)) {
      const key = k as TermKey;
      out[key] = { ...out[key], ...(v ?? {}) };
    }
    return out;
  }, [profile, termDraft]);

  const dirty = modelDraft !== null || Object.keys(moduleDraft).length > 0 || Object.keys(termDraft).length > 0;

  const save = useMutation({
    mutationFn: (body: UpdateTenantProfileInput) => saveTenantProfile(body),
    onSuccess: async () => {
      setModelDraft(null);
      setModuleDraft({});
      setTermDraft({});
      toast.success('Organization profile saved.');
      await queryClient.invalidateQueries({ queryKey: ['tenant', 'profile'] });
      // The navigation and the words read the session; refresh it.
      await refreshUser();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save the profile.'),
  });

  const onSave = () => {
    const body: UpdateTenantProfileInput = {};
    if (modelDraft) body.businessModel = modelDraft;
    if (Object.keys(moduleDraft).length) body.modules = moduleDraft;
    if (Object.keys(termDraft).length) {
      body.terminology = Object.fromEntries(
        Object.entries(termDraft).map(([k, v]) => [k, Object.fromEntries(Object.entries(v ?? {}).filter(([, s]) => (s ?? '').trim().length > 0))]),
      );
    }
    save.mutate(body);
  };

  const onReset = async () => {
    const ok = await confirm({
      title: `Reset to the ${BUSINESS_MODEL_LABEL[model].toLowerCase()} defaults?`,
      description: 'Every module switch and every term goes back to what this business model starts with. Nothing else changes.',
      confirmLabel: 'Reset',
      destructive: true,
    });
    if (!ok) return;
    setModuleDraft({});
    setTermDraft({});
    save.mutate({ businessModel: model, resetToDefaults: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization profile"
        subtitle="What kind of organization this is, which modules it runs, and what it calls things. The words here reach the navigation, the roles and Hugo."
        breadcrumbs={[{ label: 'Admin' }, { label: 'Organization profile' }]}
      />

      {query.isError ? <QueryError what="the organization profile" query={query} /> : null}
      {query.isPending ? <Skeleton className="h-64" /> : null}

      {profile && modules && terms ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Business model</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="Business model" hint="Sets the defaults for the switches and the words below. The app reads the switches and the words, not the model.">
                {(p) => (
                  <Select {...p} value={model} onChange={(e) => setModelDraft(e.target.value as BusinessModel)} disabled={!canManage || save.isPending}>
                    {BUSINESS_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {BUSINESS_MODEL_LABEL[m]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {canManage ? (
                <Button type="button" variant="secondary" onClick={() => void onReset()} disabled={save.isPending}>
                  Reset to the model's defaults
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Modules</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-navy-secondary" data-testid="module-switches">
                {TENANT_MODULES.map((key) => (
                  <li key={key} className="flex items-start gap-3 py-3">
                    <input
                      id={`module-${key}`}
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-gold"
                      checked={modules[key]}
                      disabled={!canManage || save.isPending}
                      onChange={(e) => setModuleDraft((d) => ({ ...d, [key]: e.target.checked }))}
                    />
                    <label htmlFor={`module-${key}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block text-sm font-medium text-white">{TENANT_MODULE_LABEL[key]}</span>
                      <span className="block text-xs text-silver">{MODULE_NOTE[key]}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Terminology</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-sm text-silver">
                The nouns and the labels the screens and Hugo use, in each language. Leave a cell as it is to keep the current word.
              </p>
              {TERM_GROUPS.map((group) => (
                <section key={group.title} aria-labelledby={`terms-${group.title}`}>
                  <h3 id={`terms-${group.title}`} className="mb-2 text-xs font-medium uppercase tracking-wider text-silver">
                    {group.title}
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="text-left text-xs2 uppercase tracking-wider text-silver/70">
                          <th scope="col" className="py-2 pr-3 font-medium">
                            Term
                          </th>
                          {LANGS.map((l) => (
                            <th key={l.code} scope="col" className="py-2 pr-3 font-medium">
                              {l.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {group.keys.map((key) => (
                          <tr key={key} className="border-t border-navy-secondary">
                            <th scope="row" className="py-2 pr-3 text-left font-normal text-white">
                              {termLabel(key)}
                              <span className="block font-mono text-xs2 text-silver/60">{key}</span>
                            </th>
                            {LANGS.map((l) => (
                              <td key={l.code} className="py-1.5 pr-3">
                                <Input
                                  aria-label={`${termLabel(key)} in ${l.label}`}
                                  size="sm"
                                  value={termDraft[key]?.[l.code] ?? terms[key][l.code]}
                                  maxLength={60}
                                  disabled={!canManage || save.isPending}
                                  onChange={(e) => setTermDraft((d) => ({ ...d, [key]: { ...(d[key] ?? {}), [l.code]: e.target.value } }))}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </CardContent>
          </Card>

          {canManage ? (
            <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-lg border border-navy-secondary bg-navy/95 p-3 backdrop-blur">
              <p className="text-xs text-silver">
                {dirty ? 'Unsaved changes.' : 'Everything is saved.'} Branding, the assistant's name and the workweek live on the{' '}
                <Link to="/admin/branding" className="text-gold underline-offset-2 hover:underline">
                  Branding page
                </Link>
                .
              </p>
              <Button type="button" onClick={onSave} loading={save.isPending} disabled={!dirty || save.isPending}>
                Save
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
