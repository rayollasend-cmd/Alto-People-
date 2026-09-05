import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  createBeneficiary,
  createDependent,
  createEmergency,
  createLifeEvent,
  deleteBeneficiary,
  deleteDependent,
  deleteEmergency,
  getEmployeeNumber,
  getFaceConsent,
  getProfile,
  listBeneficiaries,
  listDependents,
  listEmergency,
  listLifeEvents,
  listTaxDocs,
  updateBeneficiary,
  updateDependent,
  setFaceConsent,
  updateEmergency,
  updateSelfProfile,
  type Beneficiary,
  type Dependent,
  type EmergencyContact,
  type EmployeeNumber,
  type FaceConsent,
  type LifeEvent,
  type SelfProfile,
  type TaxDoc,
} from '@/lib/selfApi';
import { useConfirm } from '@/lib/confirm';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from 'sonner';

const TAB_VALUES = [
  'profile',
  'emergency',
  'dependents',
  'beneficiaries',
  'life-events',
  'tax-docs',
] as const;

type Tab = (typeof TAB_VALUES)[number];

type ContactDraft = {
  id?: string;
  name: string;
  relation: EmergencyContact['relation'];
  phone: string;
  email: string;
  isPrimary: boolean;
};

type DependentDraft = {
  id?: string;
  firstName: string;
  lastName: string;
  relation: Dependent['relation'];
  dob: string;
  ssnLast4: string;
  isCovered: boolean;
};

type BeneficiaryDraft = {
  id?: string;
  name: string;
  relation: Beneficiary['relation'];
  kind: Beneficiary['kind'];
  percentage: number;
  dependentId: string | null;
};

const relLabel = (t: Translate, r: string): string =>
  t(('me.rel.' + r) as MessageKey);

const LIFE_EVENT_KINDS = [
  'MARRIAGE',
  'DIVORCE',
  'BIRTH',
  'ADOPTION',
  'DEATH_OF_DEPENDENT',
  'ADDRESS_CHANGE',
  'NAME_CHANGE',
  'OTHER',
] as const;

const evkLabel = (t: Translate, k: string): string =>
  t(('me.evk.' + k) as MessageKey);
const evsLabel = (t: Translate, st: string): string =>
  t(('me.evs.' + st) as MessageKey);
const benkLabel = (t: Translate, k: string): string =>
  t(('me.benk.' + k) as MessageKey);

const TAX_DOC_LABEL: Record<TaxDoc['kind'], string> = {
  W2: 'Form W-2',
  W3: 'Form W-3',
  N_1099_NEC: 'Form 1099-NEC',
  N_1095_C: 'Form 1095-C',
};

type SectionErrors = {
  profile: string | null;
  contacts: string | null;
  dependents: string | null;
  beneficiaries: string | null;
  events: string | null;
  taxDocs: string | null;
};

const NO_SECTION_ERRORS: SectionErrors = {
  profile: null,
  contacts: null,
  dependents: null,
  beneficiaries: null,
  events: null,
  taxDocs: null,
};

function settledError(t: Translate, r: PromiseSettledResult<unknown>): string | null {
  if (r.status === 'fulfilled') return null;
  return r.reason instanceof ApiError
    ? r.reason.message
    : t('me.sectionFailed');
}

export function MeHome() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = (TAB_VALUES as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as Tab)
    : 'profile';
  const setTab = (v: Tab) => {
    const next = new URLSearchParams(searchParams);
    if (v === 'profile') next.delete('tab');
    else next.set('tab', v);
    setSearchParams(next, { replace: true });
  };
  const [profile, setProfile] = useState<SelfProfile | null>(null);
  const [employeeNumber, setEmployeeNumberState] =
    useState<EmployeeNumber | null>(null);
  const [contacts, setContacts] = useState<EmergencyContact[] | null>(null);
  const [dependents, setDependents] = useState<Dependent[] | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[] | null>(null);
  const [events, setEvents] = useState<LifeEvent[] | null>(null);
  const [taxDocs, setTaxDocs] = useState<TaxDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] =
    useState<SectionErrors>(NO_SECTION_ERRORS);

  // allSettled, not all: one flaky endpoint must not blank the whole
  // portal. Each section keeps its own data/error; the page-level error
  // only fires when everything failed (likely network/auth-wide).
  const refresh = async () => {
    setError(null);
    const results = await Promise.allSettled([
      getProfile(),
      getEmployeeNumber(),
      listEmergency(),
      listDependents(),
      listBeneficiaries(),
      listLifeEvents(),
      listTaxDocs(),
    ] as const);
    const [p, n, c, d, b, e, taxRes] = results;
    if (p.status === 'fulfilled') setProfile(p.value as SelfProfile);
    if (n.status === 'fulfilled')
      setEmployeeNumberState(n.value as EmployeeNumber);
    if (c.status === 'fulfilled')
      setContacts((c.value as { contacts: EmergencyContact[] }).contacts);
    if (d.status === 'fulfilled')
      setDependents((d.value as { dependents: Dependent[] }).dependents);
    if (b.status === 'fulfilled')
      setBeneficiaries(
        (b.value as { beneficiaries: Beneficiary[] }).beneficiaries,
      );
    if (e.status === 'fulfilled')
      setEvents((e.value as { events: LifeEvent[] }).events);
    if (taxRes.status === 'fulfilled')
      setTaxDocs((taxRes.value as { documents: TaxDoc[] }).documents);
    setSectionErrors({
      profile: settledError(t, p) ?? settledError(t, n),
      contacts: settledError(t, c),
      dependents: settledError(t, d),
      beneficiaries: settledError(t, b),
      events: settledError(t, e),
      taxDocs: settledError(t, taxRes),
    });
    if (results.every((r) => r.status === 'rejected')) {
      const first = results[0];
      setError(
        first.status === 'rejected' && first.reason instanceof ApiError
          ? first.reason.message
          : t('me.loadFailed'),
      );
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const pullState = usePullToRefresh(refresh);

  return (
    <div className="space-y-5">
      <PullToRefreshIndicator state={pullState} />
      <PageHeader
        title={t('me.title')}
        subtitle={t('me.subtitle')}
        // No "Workforce" breadcrumb — that's internal HR taxonomy, and it
        // wasn't clickable anyway. This page is simply theirs.
        breadcrumbs={[{ label: t('me.title') }]}
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">{t('me.settingsLink')}</Link>
          </Button>
        }
      />

      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="profile">{t('me.tab.profile')}</TabsTrigger>
          <TabsTrigger value="emergency">{t('me.tab.emergency')}</TabsTrigger>
          <TabsTrigger value="dependents">{t('me.tab.dependents')}</TabsTrigger>
          <TabsTrigger value="beneficiaries">{t('me.tab.beneficiaries')}</TabsTrigger>
          <TabsTrigger value="life-events">{t('me.tab.lifeEvents')}</TabsTrigger>
          <TabsTrigger value="tax-docs">{t('me.tab.taxDocs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <ProfilePanel
            profile={profile}
            employeeNumber={employeeNumber}
            error={sectionErrors.profile}
            onRetry={refresh}
            onSaved={refresh}
          />
        </TabsContent>

        <TabsContent value="emergency">
          <EmergencyPanel
            rows={contacts}
            error={sectionErrors.contacts}
            onRetry={refresh}
            onChange={refresh}
          />
        </TabsContent>

        <TabsContent value="dependents">
          <DependentsPanel
            rows={dependents}
            error={sectionErrors.dependents}
            onRetry={refresh}
            onChange={refresh}
          />
        </TabsContent>

        <TabsContent value="beneficiaries">
          <BeneficiariesPanel
            rows={beneficiaries}
            dependents={dependents}
            error={sectionErrors.beneficiaries}
            onRetry={refresh}
            onChange={refresh}
          />
        </TabsContent>

        <TabsContent value="life-events">
          <LifeEventsPanel
            rows={events}
            error={sectionErrors.events}
            onRetry={refresh}
            onChange={refresh}
          />
        </TabsContent>

        <TabsContent value="tax-docs">
          <TaxDocsPanel
            rows={taxDocs}
            error={sectionErrors.taxDocs}
            onRetry={refresh}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Shared per-section failure UI: alert copy + a Retry button. */
function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

// ============ Profile ============

function ProfilePanel({
  profile,
  employeeNumber,
  error,
  onRetry,
  onSaved,
}: {
  profile: SelfProfile | null;
  employeeNumber: EmployeeNumber | null;
  error: string | null;
  onRetry: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [zip, setZip] = useState('');
  const [saving, setSaving] = useState(false);

  // Seed once per mount, then hands off. Re-seeding on every profile
  // identity change meant an accidental pull-to-refresh mid-edit silently
  // discarded every keystroke and snapped the old values back.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!profile || seededRef.current) return;
    seededRef.current = true;
    setPhone(profile.phone ?? '');
    setAddressLine1(profile.addressLine1 ?? '');
    setAddressLine2(profile.addressLine2 ?? '');
    setCity(profile.city ?? '');
    setStateCode(profile.state ?? '');
    setZip(profile.zip ?? '');
  }, [profile]);

  if (!profile) {
    return (
      <Card>
        <CardContent className={error ? 'p-0' : 'p-6'}>
          {error ? (
            <SectionError message={error} onRetry={onRetry} />
          ) : (
            <SkeletonRows count={4} />
          )}
        </CardContent>
      </Card>
    );
  }

  const onSave = async () => {
    setSaving(true);
    try {
      await updateSelfProfile({
        phone: phone.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: stateCode.trim() ? stateCode.trim().toUpperCase() : null,
        zip: zip.trim() || null,
      });
      toast.success(t('me.profileUpdated'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-6 space-y-5">
        <EmployeeNumberRow employeeNumber={employeeNumber} />
        <FaceConsentRow />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadonlyField label={t('me.fld.name')} value={`${profile.firstName} ${profile.lastName}`} />
          <ReadonlyField label={t('me.fld.workEmail')} value={profile.email} />
          <ReadonlyField
            label={t('me.fld.department')}
            value={profile.department?.name ?? '—'}
          />
          {/* The manager is a person you can REACH, not an inert string —
              associates have no directory access, so tel:/mailto: here is
              their only in-app route to their boss (running late, sick,
              lost at a new site). */}
          <div>
            <ReadonlyField label={t('me.fld.manager')} value={profile.managerName ?? '—'} />
            {(profile.managerPhone || profile.managerEmail) && (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {profile.managerPhone && (
                  <a
                    href={`tel:${profile.managerPhone.replace(/[^\d+]/g, '')}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-navy-secondary px-2.5 py-1 text-xs text-gold hover:bg-navy-secondary/40 coarse:min-h-11 coarse:px-3"
                  >
                    {t('me.mgr.call')}
                  </a>
                )}
                {profile.managerPhone && (
                  <a
                    href={`sms:${profile.managerPhone.replace(/[^\d+]/g, '')}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-navy-secondary px-2.5 py-1 text-xs text-gold hover:bg-navy-secondary/40 coarse:min-h-11 coarse:px-3"
                  >
                    {t('me.mgr.text')}
                  </a>
                )}
                {profile.managerEmail && (
                  <a
                    href={`mailto:${profile.managerEmail}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-navy-secondary px-2.5 py-1 text-xs text-gold hover:bg-navy-secondary/40 coarse:min-h-11 coarse:px-3"
                  >
                    {t('me.mgr.email')}
                  </a>
                )}
              </div>
            )}
          </div>
          <ReadonlyField
            label={t('me.fld.jobProfile')}
            value={profile.jobProfile?.title ?? '—'}
          />
          <ReadonlyField label={t('me.fld.employmentType')} value={profile.employmentType} />
        </div>

        <div className="border-t border-navy-secondary pt-5 space-y-4">
          <div className="text-sm font-medium text-white">{t('me.fld.editable')}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FieldInput
              label={t('me.fld.phone')}
              value={phone}
              onChange={setPhone}
              placeholder="+1 555 555 5555"
              type="tel"
              inputMode="tel"
            />
            <FieldInput
              label={t('me.fld.addr1')}
              value={addressLine1}
              onChange={setAddressLine1}
            />
            <FieldInput
              label={t('me.fld.addr2')}
              value={addressLine2}
              onChange={setAddressLine2}
            />
            <FieldInput label={t('me.fld.city')} value={city} onChange={setCity} />
            <FieldInput
              label={t('me.fld.state')}
              value={stateCode}
              onChange={(v) => setStateCode(v.toUpperCase().slice(0, 2))}
              placeholder="CA"
            />
            <FieldInput
              label={t('me.fld.zip')}
              value={zip}
              onChange={setZip}
              placeholder="94110"
            />
          </div>
          <div className="text-xs text-silver">
            {t('me.stateChangeNote')}
          </div>
          <div className="flex justify-end">
            <Button onClick={onSave} disabled={saving}>
              {saving ? t('me.saving') : t('me.saveChanges')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Self-service biometric consent — the associate's own switch for kiosk
// face verification, mirroring the kiosk's one-time question. Declining
// here scrubs stored selfies + the face template immediately (server
// enforces it); granting from your own authenticated profile is valid
// affirmative consent. This closes the loop the kiosk copy promises —
// without making anyone go through their manager.
function FaceConsentRow() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [consent, setConsent] = useState<FaceConsent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  // A failed fetch must NOT render as "Not set" — that's a real consent
  // state with its own copy. Show a retry affordance instead.
  useEffect(() => {
    let cancelled = false;
    setConsent(null);
    setLoadError(null);
    getFaceConsent()
      .then((c) => !cancelled && setConsent(c))
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError
            ? err.message
            : t('me.face.loadFailed'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const change = async (next: boolean) => {
    const ok = await confirm(
      next
        ? {
            title: t('me.face.onTitle'),
            description: t('me.face.onDesc'),
          }
        : {
            title: t('me.face.offTitle'),
            description: t('me.face.offDesc'),
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await setFaceConsent(next);
      setConsent({ status: r.status, at: new Date().toISOString() });
      toast.success(
        next ? t('me.face.onToast') : t('me.face.offToast'),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : t('me.face.changeFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        {t('me.face.title')}
      </div>
      {loadError ? (
        <ErrorBanner
          className="mt-2"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAttempt((a) => a + 1)}
            >
              {t('common.retry')}
            </Button>
          }
        >
          {loadError}
        </ErrorBanner>
      ) : consent === null ? (
        <Skeleton className="mt-2 h-9 w-56" />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {consent.status === 'GRANTED' ? (
            <Badge variant="success">{t('me.face.on')}</Badge>
          ) : consent.status === 'DECLINED' ? (
            <Badge variant="outline">{t('me.face.offBadge')}</Badge>
          ) : (
            <Badge variant="pending">{t('me.face.notSet')}</Badge>
          )}
          <span className="text-xs text-silver">
            {consent.status === 'GRANTED'
              ? t('me.face.onHint')
              : consent.status === 'DECLINED'
                ? t('me.face.offHint')
                : t('me.face.askHint')}
          </span>
          {consent.status !== 'GRANTED' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(true)}>
              {t('me.face.turnOn')}
            </Button>
          )}
          {consent.status !== 'DECLINED' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(false)}>
              {t('me.face.turnOff')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function EmployeeNumberRow({
  employeeNumber,
}: {
  employeeNumber: EmployeeNumber | null;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        {t('me.num.title')}
      </div>
      {employeeNumber === null ? (
        <Skeleton className="mt-1 h-9 w-56" />
      ) : employeeNumber.employeeNumber ? (
        <>
          <div className="mt-1 font-mono text-3xl tracking-[0.5em] text-white">
            {employeeNumber.employeeNumber}
          </div>
          <div className="mt-1 text-xs text-silver">
            {t('me.num.hint', { date: fmtDate(employeeNumber.issuedAt) })}
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-silver">
          {t('me.num.none')}
        </div>
      )}
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 text-sm text-white">{value}</div>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  type,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: 'tel' | 'numeric' | 'email';
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        className="mt-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        inputMode={inputMode}
      />
    </div>
  );
}

// ============ Emergency contacts ============

function EmergencyPanel({
  rows,
  error,
  onRetry,
  onChange,
}: {
  rows: EmergencyContact[] | null;
  error: string | null;
  onRetry: () => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<ContactDraft | null>(null);

  const openAdd = () =>
    setDraft({
      name: '',
      relation: 'SPOUSE',
      phone: '',
      email: '',
      isPrimary: rows?.length === 0,
    });

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: t('me.em.removeTitle'), destructive: true }))) return;
    try {
      await deleteEmergency(id);
      toast.success(t('me.em.removed'));
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.removeFailed'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" /> {t('me.em.add')}
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            error ? (
              <SectionError message={error} onRetry={onRetry} />
            ) : (
              <div className="p-6"><SkeletonRows count={3} /></div>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('me.em.emptyTitle')}
              description={t('me.em.emptyDesc')}
              action={
                <Button onClick={openAdd}>
                  <Plus className="mr-2 h-4 w-4" /> {t('me.em.add')}
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('me.th.name')}</TableHead>
                  <TableHead>{t('me.th.relation')}</TableHead>
                  <TableHead>{t('me.th.phone')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('me.th.email')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('me.th.primary')}</TableHead>
                  <TableHead className="w-32 text-right">{t('me.th.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="group cursor-pointer"
                    onClick={() =>
                      setDraft({
                        id: row.id,
                        name: row.name,
                        relation: row.relation,
                        phone: row.phone,
                        email: row.email ?? '',
                        isPrimary: row.isPrimary,
                      })
                    }
                  >
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">{row.name}</div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {row.email ?? '—'}{row.isPrimary ? ` · ${t('me.primary')}` : ''}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{relLabel(t, row.relation)}</TableCell>
                    <TableCell>{row.phone}</TableCell>
                    <TableCell className="hidden md:table-cell">{row.email ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {row.isPrimary ? <Badge variant="accent">{t('me.primary')}</Badge> : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        aria-label={t('me.deleteAria')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(row.id);
                        }}
                        className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition p-1 coarse:p-2.5"
                      >
                        <Trash2 className="h-4 w-4 inline" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <ContactDrawer
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              onChange();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function ContactDrawer({
  draft,
  setDraft,
  onClose,
  onSaved,
}: {
  draft: ContactDraft;
  setDraft: (d: ContactDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.name.trim() || !draft.phone.trim()) {
      toast.error(t('me.em.required'));
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        relation: draft.relation,
        phone: draft.phone.trim(),
        email: draft.email.trim() || null,
        isPrimary: draft.isPrimary,
      };
      if (draft.id) await updateEmergency(draft.id, body);
      else await createEmergency(body);
      toast.success(draft.id ? t('me.em.updated') : t('me.em.added'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? t('me.em.editTitle') : t('me.em.addTitle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{t('me.th.name')}</Label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label>{t('me.th.relation')}</Label>
          <Select
            className="mt-1"
            value={draft.relation}
            onChange={(e) =>
              setDraft({ ...draft, relation: e.target.value as ContactDraft['relation'] })
            }
          >
            {(['SPOUSE', 'PARENT', 'CHILD', 'SIBLING', 'FRIEND', 'OTHER'] as const).map((r) => (
              <option key={r} value={r}>
                {relLabel(t, r)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('me.th.phone')}</Label>
          <Input
            className="mt-1"
            type="tel"
            inputMode="tel"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          />
        </div>
        <div>
          <Label>{t('me.th.email')}</Label>
          <Input
            className="mt-1"
            type="email"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={draft.isPrimary}
            onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })}
          />
          {t('me.em.primaryCheckbox')}
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('me.cancel')}
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? t('me.saving') : t('me.save')}
        </Button>
      </DrawerFooter>
    </>
  );
}

// ============ Dependents ============

function DependentsPanel({
  rows,
  error,
  onRetry,
  onChange,
}: {
  rows: Dependent[] | null;
  error: string | null;
  onRetry: () => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<DependentDraft | null>(null);

  const openAdd = () =>
    setDraft({
      firstName: '',
      lastName: '',
      relation: 'CHILD',
      dob: '',
      ssnLast4: '',
      isCovered: true,
    });

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: t('me.dep.removeTitle'), destructive: true }))) return;
    try {
      await deleteDependent(id);
      toast.success(t('me.dep.removed'));
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.removeFailed'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" /> {t('me.dep.add')}
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            error ? (
              <SectionError message={error} onRetry={onRetry} />
            ) : (
              <div className="p-6"><SkeletonRows count={3} /></div>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('me.dep.emptyTitle')}
              description={t('me.dep.emptyDesc')}
              action={
                <Button onClick={openAdd}>
                  <Plus className="mr-2 h-4 w-4" /> {t('me.dep.add')}
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('me.th.name')}</TableHead>
                  <TableHead>{t('me.th.relation')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('me.th.dob')}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t('me.th.ssn4')}</TableHead>
                  <TableHead>{t('me.th.covered')}</TableHead>
                  <TableHead className="w-32 text-right">{t('me.th.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="group cursor-pointer"
                    onClick={() =>
                      setDraft({
                        id: row.id,
                        firstName: row.firstName,
                        lastName: row.lastName,
                        relation: row.relation,
                        dob: row.dob ? row.dob.slice(0, 10) : '',
                        ssnLast4: row.ssnLast4 ?? '',
                        isCovered: row.isCovered,
                      })
                    }
                  >
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">
                          {row.firstName} {row.lastName}
                        </div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {row.dob ? t('me.dobPrefix', { date: fmtDate(parseYmd(row.dob)) }) : '—'}
                          {row.ssnLast4 ? ` · •••-••-${row.ssnLast4}` : ''}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{relLabel(t, row.relation)}</TableCell>
                    <TableCell className="hidden md:table-cell">{fmtDate(parseYmd(row.dob))}</TableCell>
                    <TableCell className="hidden lg:table-cell">{row.ssnLast4 ? `•••-••-${row.ssnLast4}` : '—'}</TableCell>
                    <TableCell>
                      {row.isCovered ? <Badge variant="accent">{t('me.yes')}</Badge> : t('me.no')}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        aria-label={t('me.deleteAria')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(row.id);
                        }}
                        className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition p-1 coarse:p-2.5"
                      >
                        <Trash2 className="h-4 w-4 inline" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <DependentDrawer
            draft={draft}
            setDraft={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              onChange();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function DependentDrawer({
  draft,
  setDraft,
  onClose,
  onSaved,
}: {
  draft: DependentDraft;
  setDraft: (d: DependentDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      toast.error(t('me.dep.namesRequired'));
      return;
    }
    if (draft.ssnLast4 && !/^\d{4}$/.test(draft.ssnLast4)) {
      toast.error(t('me.dep.ssn4Invalid'));
      return;
    }
    setSaving(true);
    try {
      const body = {
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        relation: draft.relation,
        dob: draft.dob || null,
        ssnLast4: draft.ssnLast4 || null,
        isCovered: draft.isCovered,
      };
      if (draft.id) await updateDependent(draft.id, body);
      else await createDependent(body);
      toast.success(draft.id ? t('me.dep.updated') : t('me.dep.added'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? t('me.dep.editTitle') : t('me.dep.addTitle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('me.fld.firstName')}</Label>
            <Input
              className="mt-1"
              value={draft.firstName}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('me.fld.lastName')}</Label>
            <Input
              className="mt-1"
              value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
            />
          </div>
        </div>
        <div>
          <Label>{t('me.th.relation')}</Label>
          <Select
            className="mt-1"
            value={draft.relation}
            onChange={(e) =>
              setDraft({ ...draft, relation: e.target.value as DependentDraft['relation'] })
            }
          >
            {(['SPOUSE', 'CHILD', 'DOMESTIC_PARTNER', 'OTHER'] as const).map((r) => (
              <option key={r} value={r}>
                {relLabel(t, r)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('me.fld.dob')}</Label>
          <Input
            className="mt-1"
            type="date"
            max={ymdLocal()}
            value={draft.dob}
            onChange={(e) => setDraft({ ...draft, dob: e.target.value })}
          />
        </div>
        <div>
          <Label>{t('me.fld.ssn4')}</Label>
          <Input
            className="mt-1"
            value={draft.ssnLast4}
            onChange={(e) =>
              setDraft({ ...draft, ssnLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })
            }
            placeholder="1234"
            maxLength={4}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            checked={draft.isCovered}
            onChange={(e) => setDraft({ ...draft, isCovered: e.target.checked })}
          />
          {t('me.dep.coveredCheckbox')}
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('me.cancel')}
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? t('me.saving') : t('me.save')}
        </Button>
      </DrawerFooter>
    </>
  );
}

// ============ Beneficiaries ============

function BeneficiariesPanel({
  rows,
  dependents,
  error,
  onRetry,
  onChange,
}: {
  rows: Beneficiary[] | null;
  dependents: Dependent[] | null;
  error: string | null;
  onRetry: () => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<BeneficiaryDraft | null>(null);

  const tierTotal = (kind: Beneficiary['kind']) =>
    (rows ?? [])
      .filter((b) => b.kind === kind)
      .reduce((sum, b) => sum + b.percentage, 0);
  const primaryTotal = tierTotal('PRIMARY');
  const contingentTotal = tierTotal('CONTINGENT');

  const openAdd = () =>
    setDraft({
      name: '',
      relation: 'SPOUSE',
      kind: 'PRIMARY',
      percentage: Math.max(0, 100 - primaryTotal),
      dependentId: null,
    });

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: t('me.ben.removeTitle'), destructive: true }))) return;
    try {
      await deleteBeneficiary(id);
      toast.success(t('me.ben.removed'));
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.removeFailed'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-silver space-x-4">
          <span>
            {t('me.ben.primaryLabel')}{' '}
            <span
              className={
                primaryTotal === 100
                  ? 'text-success'
                  : primaryTotal > 0
                    ? 'text-alert'
                    : 'text-silver'
              }
            >
              {primaryTotal}%
            </span>
            {primaryTotal !== 100 && primaryTotal > 0 && t('me.ben.mustTotal')}
          </span>
          <span>
            {t('me.ben.contingentLabel')}{' '}
            <span
              className={
                contingentTotal === 100
                  ? 'text-success'
                  : contingentTotal > 0
                    ? 'text-alert'
                    : 'text-silver'
              }
            >
              {contingentTotal}%
            </span>
            {contingentTotal !== 100 &&
              contingentTotal > 0 &&
              t('me.ben.mustTotal')}
          </span>
        </div>
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" /> {t('me.ben.add')}
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            error ? (
              <SectionError message={error} onRetry={onRetry} />
            ) : (
              <div className="p-6"><SkeletonRows count={3} /></div>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('me.ben.emptyTitle')}
              description={t('me.ben.emptyDesc')}
              action={
                <Button onClick={openAdd}>
                  <Plus className="mr-2 h-4 w-4" /> {t('me.ben.add')}
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('me.th.name')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('me.th.relation')}</TableHead>
                  <TableHead>{t('me.th.kind')}</TableHead>
                  <TableHead className="text-right">{t('me.th.percentage')}</TableHead>
                  <TableHead className="w-32 text-right">{t('me.th.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="group cursor-pointer"
                    onClick={() =>
                      setDraft({
                        id: row.id,
                        name: row.name,
                        relation: row.relation,
                        kind: row.kind,
                        percentage: row.percentage,
                        dependentId: row.dependentId,
                      })
                    }
                  >
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">{row.name}</div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {relLabel(t, row.relation)}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{relLabel(t, row.relation)}</TableCell>
                    <TableCell>
                      <Badge variant={row.kind === 'PRIMARY' ? 'accent' : 'default'}>
                        {benkLabel(t, row.kind)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.percentage}%
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        aria-label={t('me.deleteAria')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(row.id);
                        }}
                        className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition p-1 coarse:p-2.5"
                      >
                        <Trash2 className="h-4 w-4 inline" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <BeneficiaryDrawer
            draft={draft}
            setDraft={setDraft}
            rows={rows ?? []}
            dependents={dependents ?? []}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              onChange();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}

function BeneficiaryDrawer({
  draft,
  setDraft,
  rows,
  dependents,
  onClose,
  onSaved,
}: {
  draft: BeneficiaryDraft;
  setDraft: (d: BeneficiaryDraft) => void;
  rows: Beneficiary[];
  dependents: Dependent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [tierError, setTierError] = useState<string | null>(null);

  // What the draft's tier would total AFTER this save (other rows in the
  // same tier + the draft itself, replacing its own stored row on edit).
  const tierTotalAfter =
    rows
      .filter((b) => b.kind === draft.kind && b.id !== draft.id)
      .reduce((sum, b) => sum + b.percentage, 0) + draft.percentage;

  const onSubmit = async () => {
    if (!draft.name.trim()) {
      toast.error(t('me.ben.nameRequired'));
      return;
    }
    if (draft.percentage < 0 || draft.percentage > 100) {
      toast.error(t('me.ben.pctRange'));
      return;
    }
    // Hard-block only over-allocation: requiring exactly 100% on every
    // save would deadlock incremental entry (a first 50% row could never
    // be added). Under-allocation saves but the panel banner keeps
    // flagging the tier until it totals 100%.
    if (tierTotalAfter > 100) {
      setTierError(
        t('me.ben.tierExceed', { kind: benkLabel(t, draft.kind), pct: String(tierTotalAfter) }),
      );
      return;
    }
    setTierError(null);
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        relation: draft.relation,
        kind: draft.kind,
        percentage: draft.percentage,
        dependentId: draft.dependentId,
      };
      if (draft.id) await updateBeneficiary(draft.id, body);
      else await createBeneficiary(body);
      toast.success(draft.id ? t('me.ben.updated') : t('me.ben.added'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? t('me.ben.editTitle') : t('me.ben.addTitle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {dependents.length > 0 && (
          <div>
            <Label>{t('me.ben.copyFrom')}</Label>
            <Select
              className="mt-1"
              value={draft.dependentId ?? ''}
              onChange={(e) => {
                const dep = dependents.find((d) => d.id === e.target.value);
                if (!dep) {
                  setDraft({ ...draft, dependentId: null });
                  return;
                }
                setDraft({
                  ...draft,
                  dependentId: dep.id,
                  name: `${dep.firstName} ${dep.lastName}`,
                  relation: dep.relation,
                });
              }}
            >
              <option value="">{t('me.ben.noneOption')}</option>
              {dependents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.firstName} {d.lastName} (
                  {relLabel(t, d.relation)})
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label>{t('me.th.name')}</Label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label>{t('me.th.relation')}</Label>
          <Select
            className="mt-1"
            value={draft.relation}
            onChange={(e) =>
              setDraft({ ...draft, relation: e.target.value as BeneficiaryDraft['relation'] })
            }
          >
            {(['SPOUSE', 'CHILD', 'DOMESTIC_PARTNER', 'OTHER'] as const).map((r) => (
              <option key={r} value={r}>
                {relLabel(t, r)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('me.th.kind')}</Label>
          <Select
            className="mt-1"
            value={draft.kind}
            onChange={(e) => {
              setTierError(null);
              setDraft({ ...draft, kind: e.target.value as BeneficiaryDraft['kind'] });
            }}
          >
            <option value="PRIMARY">{t('me.benk.PRIMARY')}</option>
            <option value="CONTINGENT">{t('me.benk.CONTINGENT')}</option>
          </Select>
        </div>
        <div>
          <Label>{t('me.fld.percentage')}</Label>
          <Input
            className="mt-1"
            type="number"
            min={0}
            max={100}
            value={draft.percentage}
            onChange={(e) => {
              setTierError(null);
              setDraft({ ...draft, percentage: Number(e.target.value) || 0 });
            }}
          />
          <p
            className={`mt-1 text-xs ${
              tierTotalAfter === 100 ? 'text-success' : 'text-silver'
            }`}
          >
            {t('me.ben.tierTotal', { kind: benkLabel(t, draft.kind), pct: String(tierTotalAfter) })}
            {tierTotalAfter !== 100 && t('me.ben.mustReach')}.
          </p>
        </div>
        {tierError && (
          <p role="alert" className="text-sm text-alert">
            {tierError}
          </p>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('me.cancel')}
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? t('me.saving') : t('me.save')}
        </Button>
      </DrawerFooter>
    </>
  );
}

// ============ Life events ============

function LifeEventsPanel({
  rows,
  error,
  onRetry,
  onChange,
}: {
  rows: LifeEvent[] | null;
  error: string | null;
  onRetry: () => void;
  onChange: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<typeof LIFE_EVENT_KINDS[number]>('MARRIAGE');
  const [eventDate, setEventDate] = useState(ymdLocal());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!eventDate) {
      toast.error(t('me.ev.dateRequired'));
      return;
    }
    setSaving(true);
    try {
      await createLifeEvent({
        kind,
        eventDate,
        notes: notes.trim() || null,
      });
      toast.success(t('me.ev.submitted'));
      setOpen(false);
      setEventDate(ymdLocal());
      setNotes('');
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.ev.submitFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> {t('me.ev.report')}
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            error ? (
              <SectionError message={error} onRetry={onRetry} />
            ) : (
              <div className="p-6"><SkeletonRows count={3} /></div>
            )
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('me.ev.emptyTitle')}
              description={t('me.ev.emptyDesc')}
              action={
                <Button onClick={() => setOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" /> {t('me.ev.report')}
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('me.th.event')}</TableHead>
                  <TableHead>{t('me.th.date')}</TableHead>
                  <TableHead>{t('me.th.status')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('me.th.submitted')}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t('me.th.notes')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">
                          {evkLabel(t, row.kind)}
                        </div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {t('me.submittedPrefix', { date: fmtDate(row.createdAt) })}
                          {row.notes ? ` · ${row.notes}` : ''}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{fmtDate(parseYmd(row.eventDate))}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.status === 'APPROVED'
                            ? 'success'
                            : row.status === 'REJECTED'
                              ? 'destructive'
                              : 'pending'
                        }
                      >
                        {evsLabel(t, row.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{fmtDate(row.createdAt)}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-xs truncate">{row.notes ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerHeader>
          <DrawerTitle>{t('me.ev.drawerTitle')}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div>
            <Label>{t('me.fld.event')}</Label>
            <Select
              className="mt-1"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof LIFE_EVENT_KINDS[number])}
            >
              {LIFE_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {evkLabel(t, k)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('me.fld.eventDate')}</Label>
            <Input
              className="mt-1"
              type="date"
              max={ymdLocal()}
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </div>
          <div>
            <Label>{t('me.fld.notes')}</Label>
            <Textarea
              className="mt-1"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <p className="text-xs text-silver">
            {t('me.ev.review')}
          </p>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('me.cancel')}
          </Button>
          <Button onClick={onSubmit} disabled={saving}>
            {saving ? t('me.ev.submitting') : t('me.ev.submit')}
          </Button>
        </DrawerFooter>
      </Drawer>
    </div>
  );
}

// ============ Tax documents ============

function TaxDocsPanel({
  rows,
  error,
  onRetry,
}: {
  rows: TaxDoc[] | null;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          error ? (
            <SectionError message={error} onRetry={onRetry} />
          ) : (
            <div className="p-6"><SkeletonRows count={3} /></div>
          )
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('me.tax.emptyTitle')}
            description={t('me.tax.emptyDesc')}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('me.th.form')}</TableHead>
                <TableHead className="text-right">{t('me.th.taxYear')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('me.th.issued')}</TableHead>
                <TableHead className="hidden md:table-cell text-right">
                  {t('me.th.size')}
                </TableHead>
                <TableHead className="w-32 text-right">{t('me.th.action')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-white">
                    <div className="min-w-0">
                      <div className="truncate">
                        {TAX_DOC_LABEL[row.kind] ?? row.kind}
                      </div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {t('me.issuedPrefix', { date: fmtDate(row.issuedAt) })}
                        {row.fileSize ? ` · ${Math.round(row.fileSize / 1024)} KB` : ''}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.taxYear}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{fmtDate(row.issuedAt)}</TableCell>
                  <TableCell className="hidden md:table-cell text-right tabular-nums whitespace-nowrap">
                    {row.fileSize ? `${Math.round(row.fileSize / 1024)} KB` : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.downloadUrl ? (
                      <Button asChild variant="ghost" size="sm">
                        <a href={row.downloadUrl} download>
                          {t('me.tax.download')}
                        </a>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled
                        title={t('me.tax.legacyHint')}
                      >
                        {t('me.tax.download')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
