import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ASSISTANT_PLATFORM_NAME,
  BUSINESS_MODELS,
  BUSINESS_MODEL_LABEL,
  ROLE_LABELS,
  ROLE_MODULE,
  TENANT_MODULES,
  TERM_KEYS,
  type BusinessModel,
  type Role,
  type TenantModule,
  type TenantModules,
  type TermKey,
  type TermLang,
  type Terminology,
  type UpdateTenantProfileInput,
  SUPPORTED_TIMEZONES,
} from '@alto-people/shared';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { getTenantProfile, saveTenantProfile } from '@/lib/tenantProfileApi';
import { getOrgBranding, patchOrgBranding } from '@/lib/brandingApi';
import { ORG_SETTINGS_KEY } from '@/lib/orgSettingsKey';
import { fmtDate, fmtTimeZone } from '@/lib/format';
import { SettingsSection } from '@/components/templates';
import { SettingsSaveBar } from '@/pages/settings/SettingsSaveBar';
import { LearnMore } from '@/pages/settings/LearnMore';
import { SettingsSwitch } from '@/components/settings/SettingsSwitch';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { MODULES, MODULE_GATE } from '@/lib/modules';
import { cn } from '@/lib/cn';

/** The menu pages and the roles each module brings — what a switch adds or takes away. */
const MODULE_REACH: Record<TenantModule, { pages: string[]; roles: string[] }> = Object.fromEntries(
  TENANT_MODULES.map((m) => [
    m,
    {
      // One name once: two menu entries open Time & attendance.
      pages: [...new Set(MODULES.filter((x) => MODULE_GATE[x.key] === m).map((x) => x.label))],
      roles: (Object.entries(ROLE_MODULE) as Array<[Role, string]>).filter(([, g]) => g === m).map(([r]) => ROLE_LABELS[r]),
    },
  ]),
) as Record<TenantModule, { pages: string[]; roles: string[] }>;

/**
 * Brief 2-1b — the Organization profile: what kind of organization this
 * tenant is, which modules it runs, and what it calls things. The business
 * model only sets the defaults; the switches and the words are what the
 * app reads.
 */

/**
 * A short title per module, in the menu's own words ("Time & attendance",
 * not "Time and attendance"); what it covers is the line under it, not a
 * parenthesis in the title (F500 polish, 2026-10-26).
 */
const MODULE_TITLE: Record<TenantModule, string> = {
  scheduling: 'Scheduling',
  time: 'Time & attendance',
  hrCases: 'HR cases',
  compliance: 'Compliance',
  payrollSync: 'Payroll sync',
  housingLink: 'Housing link',
  transportation: 'Transportation',
  programs: 'Programs',
  billRates: 'Bill rates & margin',
  clientPortal: 'Client portal',
  robotics: 'Robotics',
  agentBuilder: 'Agent builder',
  talent: 'Talent programs',
  perks: 'Perks',
  earnedWage: 'Earned-wage access',
};

const MODULE_NOTE: Record<TenantModule, string> = {
  scheduling: 'Shifts, the marketplace, approvals and holidays.',
  time: 'Timesheets, the kiosk and time off.',
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
  talent: 'Skills, career ladders, mentorship, succession, probation, 30/60/90 plans, learning paths, internal jobs and pulse.',
  perks: 'Tuition reimbursement, equity grants and volunteer match.',
  earnedWage: 'Pay before payday: associates draw part of what they have earned, recovered on the next check. Finance sets the cap, fee and limit.',
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
  const term = useTerm();
  // What this tenant's team calls the assistant (Branding sets it); the platform's name only before the session answers.
  const assistantName = useTenant().assistantName ?? ASSISTANT_PLATFORM_NAME;
  const canManage = can('manage:org');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['tenant', 'profile'], queryFn: getTenantProfile });
  // Two halves, one Save: the model and its modules, then the words.
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'terms' ? 'terms' : 'modules';
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'terms') next.set('tab', 'terms');
    else next.delete('tab');
    setParams(next, { replace: true });
  };

  // Draft edits sit beside the loaded profile; Save sends only what changed.
  const [modelDraft, setModelDraft] = useState<BusinessModel | null>(null);
  const [moduleDraft, setModuleDraft] = useState<Partial<TenantModules>>({});
  const [termDraft, setTermDraft] = useState<Partial<Record<TermKey, Partial<Record<TermLang, string>>>>>({});

  const profile = query.data?.profile;
  const facts = query.data?.facts;
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

  // What the pending switches do to the menu, said before Save.
  const moduleChanges = profile
    ? (Object.entries(moduleDraft) as Array<[TenantModule, boolean]>).filter(([k, v]) => profile.modules[k] !== v)
    : [];
  const pagesLeaving = moduleChanges.filter(([, on]) => !on).flatMap(([k]) => MODULE_REACH[k].pages);
  const pagesArriving = moduleChanges.filter(([, on]) => on).flatMap(([k]) => MODULE_REACH[k].pages);

  // The company calendar (the workweek and its time zone) is an org setting
  // (GET/PATCH /admin/org/settings); it moved here from Branding (F500 G4)
  // and saves with the rest of the page, from the one bar.
  const orgSettings = useQuery({ queryKey: ORG_SETTINGS_KEY, queryFn: () => getOrgBranding(), retry: false });
  const savedCalendar = useMemo(
    () => (orgSettings.data ? { weekStartsOn: orgSettings.data.weekStartsOn ?? 6, timezone: orgSettings.data.timezone ?? 'America/New_York' } : null),
    [orgSettings.data],
  );
  const [calendar, setCalendar] = useState<{ weekStartsOn: number; timezone: string } | null>(null);
  useEffect(() => setCalendar(savedCalendar), [savedCalendar]);
  const calendarChanges =
    savedCalendar && calendar ? Number(savedCalendar.weekStartsOn !== calendar.weekStartsOn) + Number(savedCalendar.timezone !== calendar.timezone) : 0;

  const profileChanges = (modelDraft !== null ? 1 : 0) + Object.keys(moduleDraft).length + Object.values(termDraft).reduce((n, v) => n + Object.keys(v ?? {}).length, 0);
  const dirty = profileChanges > 0;
  const [calendarSaving, setCalendarSaving] = useState(false);

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
    if (calendarChanges > 0 && calendar) {
      setCalendarSaving(true);
      patchOrgBranding({ weekStartsOn: calendar.weekStartsOn, timezone: calendar.timezone })
        .then((updated) => {
          queryClient.setQueryData(ORG_SETTINGS_KEY, updated);
          if (!dirty) toast.success('Workweek and time zone saved.');
        })
        .catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'Could not save the workweek.'))
        .finally(() => setCalendarSaving(false));
    }
    if (!dirty) return;
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
        title="Organization"
        subtitle={`What kind of organization this is, which modules it runs, what it calls things, and its workweek. The words here reach the navigation, the roles and ${assistantName}.`}
        facts={[
          { label: 'Name', value: facts?.name ?? null },
          // The plan in the API's words, never its code; an older API without them falls back to the code, capitalized.
          { label: 'Plan', value: facts?.planLabel ?? (facts?.plan ? facts.plan.charAt(0).toUpperCase() + facts.plan.slice(1) : null), to: can('manage:org') ? '/admin/billing' : undefined },
          { label: 'People on the books', value: facts ? facts.onTheBooks.toLocaleString() : null, to: '/people', hint: 'Hired and not separated: the count People and Headcount show.' },
          { label: term('sites'), value: facts ? facts.sites.toLocaleString() : null, to: can('view:org') ? '/admin/sites' : undefined, hint: 'Active places' },
          { label: 'Since', value: facts?.createdAt ? fmtDate(facts.createdAt) : null },
        ]}
      />

      <SettingsSection id="calendar" title="Workweek and time zone" description="The company week for overtime, digests and every weekly number. Each site keeps its own time zone on its record; the week turns at midnight in the company zone.">
        {orgSettings.isError ? (
          <QueryError what="the workweek" query={orgSettings} />
        ) : !calendar ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <Field label="Workweek starts on">
              {(p) => (
                <Select {...p} value={calendar.weekStartsOn} onChange={(e) => setCalendar((c) => c && { ...c, weekStartsOn: Number(e.target.value) })} disabled={!canManage}>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Company time zone">
              {(p) => (
                <Select {...p} value={calendar.timezone} onChange={(e) => setCalendar((c) => c && { ...c, timezone: e.target.value })} disabled={!canManage}>
                  {SUPPORTED_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {fmtTimeZone(tz)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
      </SettingsSection>

      {query.isError ? <QueryError what="the organization profile" query={query} /> : null}
      {query.isPending ? <Skeleton className="h-64" /> : null}

      {profile && modules && terms ? (
        <>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="modules">Model &amp; modules</TabsTrigger>
              <TabsTrigger value="terms">Terminology</TabsTrigger>
            </TabsList>
            <TabsContent value="modules" className="space-y-6">
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
              <p className="mb-3 text-sm text-ink-muted">
                A module that is off leaves everyone’s menu.
                <LearnMore>Its pages can’t be opened while it is off. Nothing is deleted — turn it back on and everything is where it was.</LearnMore>
              </p>
              <ul className="grid gap-3 md:grid-cols-2" data-testid="module-switches">
                {TENANT_MODULES.map((key) => {
                  const reach = MODULE_REACH[key];
                  const changed = profile.modules[key] !== modules[key];
                  return (
                    <li key={key} className={cn('rounded-lg border border-line p-3', changed && 'ring-1 ring-warning/50')}>
                      <div className="flex items-start gap-3">
                        <label htmlFor={`module-${key}`} className="min-w-0 flex-1 cursor-pointer">
                          <span className="flex items-center gap-2 text-sm font-medium text-ink">
                            {MODULE_TITLE[key]}
                            {changed && <span className="text-2xs font-normal text-warning">Unsaved</span>}
                          </span>
                          <span className="block text-xs text-ink-muted">{MODULE_NOTE[key]}</span>
                          {(reach.pages.length > 0 || reach.roles.length > 0) && (
                            <span className="mt-1.5 block text-2xs text-ink-muted">
                              {reach.pages.length > 0 && <>Menu: {reach.pages.slice(0, 6).join(', ')}{reach.pages.length > 6 ? ` and ${reach.pages.length - 6} more` : ''}.</>}
                              {reach.roles.length > 0 && <> Roles: {reach.roles.join(', ')}.</>}
                            </span>
                          )}
                        </label>
                        {/* A switch, not a checkbox with "On" beside it: the state is the control. */}
                        <SettingsSwitch
                          id={`module-${key}`}
                          aria-label={MODULE_TITLE[key]}
                          checked={modules[key]}
                          disabled={!canManage || save.isPending}
                          onCheckedChange={(on) => setModuleDraft((d) => ({ ...d, [key]: on }))}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {(pagesLeaving.length > 0 || pagesArriving.length > 0) && (
                <div className="mt-4 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-ink" role="status">
                  <span className="font-medium">When you save:</span>{' '}
                  {pagesArriving.length > 0 && <>{pagesArriving.length} page{pagesArriving.length === 1 ? '' : 's'} join the menu ({pagesArriving.slice(0, 5).join(', ')}{pagesArriving.length > 5 ? '…' : ''}). </>}
                  {pagesLeaving.length > 0 && <>{pagesLeaving.length} page{pagesLeaving.length === 1 ? '' : 's'} leave it ({pagesLeaving.slice(0, 5).join(', ')}{pagesLeaving.length > 5 ? '…' : ''}) for everyone.</>}
                </div>
              )}
            </CardContent>
          </Card>

            </TabsContent>
            <TabsContent value="terms">
          <Card>
            <CardHeader>
              <CardTitle>Terminology</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-sm text-silver">
                The nouns and the labels the screens and {assistantName} use, in each language. Leave a cell as it is to keep the current word.
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

            </TabsContent>
          </Tabs>

          {canManage ? (
            <SettingsSaveBar
              dirty={profileChanges + calendarChanges}
              saving={save.isPending || calendarSaving}
              onSave={onSave}
              onDiscard={() => {
                setModelDraft(null);
                setModuleDraft({});
                setTermDraft({});
                setCalendar(savedCalendar);
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
