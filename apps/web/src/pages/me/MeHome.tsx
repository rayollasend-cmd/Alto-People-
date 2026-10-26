import { lazy, Suspense, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { Eye, EyeOff, MapPin, Pencil, Phone, Plus, Trash2, UserRound } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { isPending } from '@/lib/approvalRequestsApi';
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
import { MySkillsCard } from './MySkillsCard';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import { updateProfile } from '@/lib/settingsApi';
import { useAuth } from '@/lib/auth';
import { fmtPhone } from '@/lib/format';
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
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { AddressAutocomplete, pickedFields } from '@/components/ui/AddressAutocomplete';
import { Field } from '@/components/ui/Field';
import { Label } from '@/components/ui/Label';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { toast } from 'sonner';
import '@/lib/i18n/en/dash';
import '@/lib/i18n/en/me';

const TAB_VALUES = [
  'profile',
  'emergency',
  'dependents',
  'beneficiaries',
  'life-events',
  'tax-docs',
] as const;

type Tab = (typeof TAB_VALUES)[number];
const TAB_LABEL: Record<Tab, MessageKey> = {
  profile: 'me.tab.profile',
  emergency: 'me.tab.emergency',
  dependents: 'me.tab.dependents',
  beneficiaries: 'me.tab.beneficiaries',
  'life-events': 'me.tab.lifeEvents',
  'tax-docs': 'me.tab.taxDocs',
};

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

/** The photo uploader Settings uses for staff; an associate's photo lives here (F500 G5: one home). */
const ProfilePhotoCard = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.ProfilePhotoCard })));

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD',
  'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR',
] as const;

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

function settledError(t: Translate, r: PromiseSettledResult<unknown> | undefined): string | null {
  if (!r || r.status === 'fulfilled') return null;
  return r.reason instanceof ApiError
    ? r.reason.message
    : t('me.sectionFailed');
}

function fulfilled<T>(r: PromiseSettledResult<T> | undefined): T | null {
  return r && r.status === 'fulfilled' ? r.value : null;
}

/**
 * The sign-in has no person record behind it (an administrator, a store's
 * portal login): there is no personal profile to show, and nothing to
 * retry. The API says so with `no_person_record`; older builds sent a 403
 * about "associate-linked accounts".
 */
export function isNoPersonRecord(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'no_person_record' || err.code === 'not_an_associate') return true;
  return err.status === 403 && /associate-linked|person record/i.test(err.message);
}

/** How a person is employed, in words (the enum's "W-2" is a tax form, not a word). */
const EMPLOYMENT_WORDS: Record<string, { label: MessageKey; hint: MessageKey }> = {
  W2_EMPLOYEE: { label: 'me.empType.employee', hint: 'me.empType.employeeHint' },
  CONTRACTOR_1099_INDIVIDUAL: { label: 'me.empType.contractor', hint: 'me.empType.contractorHint' },
  CONTRACTOR_1099_BUSINESS: { label: 'me.empType.business', hint: 'me.empType.contractorHint' },
};

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
  // allSettled, not all: one flaky endpoint must not blank the whole
  // portal. Each section keeps its own data/error; the page-level error
  // only fires when everything failed (likely network/auth-wide).
  const sectionsQuery = useQuery({
    queryKey: ['MeHome', 'sections'],
    queryFn: () =>
      Promise.allSettled([
        getProfile(),
        getEmployeeNumber(),
        listEmergency(),
        listDependents(),
        listBeneficiaries(),
        listLifeEvents(),
        listTaxDocs(),
      ] as const),
  });
  const results = sectionsQuery.data;
  const [p, n, c, d, b, e, taxRes] = results ?? [];
  const profile = fulfilled(p) as SelfProfile | null;
  const employeeNumber = fulfilled(n) as EmployeeNumber | null;
  const contacts =
    (fulfilled(c) as { contacts: EmergencyContact[] } | null)?.contacts ?? null;
  const dependents =
    (fulfilled(d) as { dependents: Dependent[] } | null)?.dependents ?? null;
  const beneficiaries =
    (fulfilled(b) as { beneficiaries: Beneficiary[] } | null)?.beneficiaries ?? null;
  const events = (fulfilled(e) as { events: LifeEvent[] } | null)?.events ?? null;
  const taxDocs = (fulfilled(taxRes) as { documents: TaxDoc[] } | null)?.documents ?? null;
  const sectionErrors: SectionErrors = results
    ? {
        profile: settledError(t, p) ?? settledError(t, n),
        contacts: settledError(t, c),
        dependents: settledError(t, d),
        beneficiaries: settledError(t, b),
        events: settledError(t, e),
        taxDocs: settledError(t, taxRes),
      }
    : NO_SECTION_ERRORS;
  const error =
    results && results.every((r) => r.status === 'rejected')
      ? p && p.status === 'rejected' && p.reason instanceof ApiError
        ? p.reason.message
        : t('me.loadFailed')
      : null;
  const refresh = async () => {
    await sectionsQuery.refetch();
  };

  const pullState = usePullToRefresh(refresh);
  // The personal-details drawer: opened from the Profile tab, the "what's
  // missing" row, Life events (moving is an address change), or ?edit=1.
  const [editing, setEditing] = useState(() => searchParams.get('edit') === 'address');
  // No person behind this sign-in: one designed state, not the API's
  // sentence twice with a Retry that can never work (F500 audit).
  const noPerson = !!p && p.status === 'rejected' && isNoPersonRecord(p.reason);

  if (noPerson) {
    return (
      <ListTemplate title={t('me.title')}>
        <EmptyState
          icon={UserRound}
          title={t('me.noPerson.title')}
          description={t('me.noPerson.body')}
          action={
            <Button asChild>
              <Link to="/settings">{t('me.noPerson.cta')}</Link>
            </Button>
          }
        />
      </ListTemplate>
    );
  }

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.2 (UX upgrade step 6, the sweep): the List template. */}
      <ListTemplate
        title={t('me.title')}
        subtitle={t('me.subtitle')}
        // A worker reads at 16px on a phone (helper lines at 14px).
        className="max-sm:[&_.text-sm]:text-base max-sm:[&_.text-xs]:text-sm max-sm:[&_.text-xs2]:text-sm"
        // No breadcrumb: one crumb repeating the title said nothing (F500 G5).
        secondaryActions={
          <Button asChild variant="outline" size="sm">
            <Link to="/settings">{t('me.securityLink')}</Link>
          </Button>
        }
      >

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
        {/* A phone gets the six sections as one picker; "Tax documents" sat off-screen in a strip. */}
        <div className="mb-3 sm:hidden">
          <Select aria-label={t('me.sectionPick')} value={tab} onChange={(e) => setTab(e.target.value as Tab)} data-testid="me-tab-select">
            {TAB_VALUES.map((v) => (
              <option key={v} value={v}>
                {t(TAB_LABEL[v])}
              </option>
            ))}
          </Select>
        </div>
        <TabsList className="hidden sm:flex">
          <TabsTrigger value="profile">{t('me.tab.profile')}</TabsTrigger>
          <TabsTrigger value="emergency">{t('me.tab.emergency')}</TabsTrigger>
          <TabsTrigger value="dependents">{t('me.tab.dependents')}</TabsTrigger>
          <TabsTrigger value="beneficiaries">{t('me.tab.beneficiaries')}</TabsTrigger>
          <TabsTrigger value="life-events">{t('me.tab.lifeEvents')}</TabsTrigger>
          <TabsTrigger value="tax-docs">{t('me.tab.taxDocs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          {profile && (
            <ProfileGaps
              missing={[
                ...(contacts !== null && contacts.length === 0 ? (['emergency'] as const) : []),
                ...(!profile.addressLine1 ? (['address'] as const) : []),
                ...(!profile.photoUrl ? (['photo'] as const) : []),
              ]}
              onTab={setTab}
              onEditAddress={() => setEditing(true)}
            />
          )}
          <ProfilePanel
            profile={profile}
            employeeNumber={employeeNumber}
            error={sectionErrors.profile}
            onRetry={refresh}
            onSaved={refresh}
            editing={editing}
            setEditing={setEditing}
          />
          {profile && (
            <div className="mt-4" id="me-photo">
              <Suspense fallback={<SkeletonRows count={2} />}>
                <ProfilePhotoCard />
              </Suspense>
            </div>
          )}
          {/* My skills: added here, verified by HR (HR walk, wave 2). */}
          {profile && <MySkillsCard />}
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
            onEditAddress={() => {
              setTab('profile');
              setEditing(true);
            }}
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
      </ListTemplate>
    </>
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

/**
 * What is still missing from their profile, said once at the top with the
 * way to fix each — the page used to open on fields and a toggle without
 * saying there was no emergency contact or street address on file.
 */
function ProfileGaps({
  missing,
  onTab,
  onEditAddress,
}: {
  missing: ReadonlyArray<'emergency' | 'address' | 'photo'>;
  onTab: (t: Tab) => void;
  onEditAddress: () => void;
}) {
  const { t } = useI18n();
  if (missing.length === 0) return null;
  const link = 'inline-flex min-h-6 items-center text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-11';
  return (
    <div className="mb-4 rounded-lg border border-gold/40 bg-gold/[0.06] px-4 py-3 text-sm" data-testid="me-gaps">
      <div className="font-medium text-ink">{t('me.gaps.title', { count: missing.length })}</div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {missing.includes('emergency') && (
          <li>
            <button type="button" className={link} onClick={() => onTab('emergency')}>
              {t('me.gaps.emergency')}
            </button>
          </li>
        )}
        {missing.includes('address') && (
          <li>
            <button type="button" className={link} onClick={onEditAddress}>
              {t('me.gaps.address')}
            </button>
          </li>
        )}
        {missing.includes('photo') && (
          <li>
            <a href="#me-photo" className={link}>
              {t('me.gaps.photo')}
            </a>
          </li>
        )}
      </ul>
    </div>
  );
}

/** "100 Seaside Dr, Apt 2, Destin, FL 32541" — the address on one line. */
function addressLine(p: SelfProfile): string | null {
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const parts = [p.addressLine1, p.addressLine2, cityLine].filter((x) => x && x.trim());
  return parts.length ? parts.join(', ') : null;
}

function ProfilePanel({
  profile,
  employeeNumber,
  error,
  onRetry,
  onSaved,
  editing,
  setEditing,
}: {
  profile: SelfProfile | null;
  employeeNumber: EmployeeNumber | null;
  error: string | null;
  onRetry: () => void;
  onSaved: () => void;
  editing: boolean;
  setEditing: (open: boolean) => void;
}) {
  const { t } = useI18n();

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

  const address = addressLine(profile);
  return (
    <Card>
      <CardContent className="space-y-5">
        <EmployeeNumberRow employeeNumber={employeeNumber} />
        <FaceConsentRow />

        {/* Read first, edit on purpose: the phone and address were always-open
            boxes under a heading called "Editable" (F500 G5). */}
        <section aria-labelledby="me-personal" className="rounded-md border border-navy-secondary p-4" data-testid="me-personal">
          <div className="flex items-center justify-between gap-3">
            <h2 id="me-personal" className="text-sm font-medium text-ink">{t('me.personal.title')}</h2>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="me-personal-edit">
              <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('me.personal.edit')}
            </Button>
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            {/* Each item is one div of dt + dd (the only grouping a <dl> allows);
                the icon rides in the term, the value lines up under the words. */}
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-silver">
                <UserRound className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('me.fld.name')}
              </dt>
              <dd className="pl-6 text-ink">{`${profile.firstName} ${profile.lastName}`}</dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-silver">
                <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('me.fld.phone')}
              </dt>
              <dd className={profile.phone ? 'pl-6 text-ink' : 'pl-6 text-silver'}>{profile.phone ? fmtPhone(profile.phone) : t('me.personal.none')}</dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-silver">
                <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('me.personal.address')}
              </dt>
              <dd className={address ? 'break-words pl-6 text-ink' : 'pl-6 text-silver'} data-testid="me-address">{address ?? t('me.personal.none')}</dd>
            </div>
          </dl>
        </section>

        {/* Only what is on file: a column of "—" under Department, Manager
            and Job profile read as broken, not as "none" (F500 audit). */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadonlyField label={t('me.fld.workEmail')} value={profile.email} />
          {profile.department?.name && (
            <ReadonlyField label={t('me.fld.department')} value={profile.department.name} />
          )}
          {/* The manager is a person you can REACH, not an inert string —
              associates have no directory access, so tel:/mailto: here is
              their only in-app route to their boss (running late, sick,
              lost at a new site). */}
          {profile.managerName && (
          <div>
            <ReadonlyField label={t('me.fld.manager')} value={profile.managerName} />
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
          )}
          {profile.jobProfile?.title && (
            <ReadonlyField label={t('me.fld.jobProfile')} value={profile.jobProfile.title} />
          )}
          {EMPLOYMENT_WORDS[profile.employmentType] ? (
            <ReadonlyField
              label={t('me.fld.employmentType')}
              value={t(EMPLOYMENT_WORDS[profile.employmentType]!.label)}
              hint={t(EMPLOYMENT_WORDS[profile.employmentType]!.hint)}
            />
          ) : (
            <ReadonlyField label={t('me.fld.employmentType')} value={EMPLOYMENT_LABEL[profile.employmentType] ?? profile.employmentType} />
          )}
        </div>
      </CardContent>
      <Drawer open={editing} onOpenChange={(o) => !o && setEditing(false)}>
        {editing && (
          <PersonalDrawer
            profile={profile}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onSaved();
            }}
          />
        )}
      </Drawer>
    </Card>
  );
}

/** Name, phone and home address — the one place an associate changes them. */
function PersonalDrawer({ profile, onClose, onSaved }: { profile: SelfProfile; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { refreshUser } = useAuth();
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [addressLine1, setAddressLine1] = useState(profile.addressLine1 ?? '');
  const [addressLine2, setAddressLine2] = useState(profile.addressLine2 ?? '');
  const [city, setCity] = useState(profile.city ?? '');
  const [stateCode, setStateCode] = useState(profile.state ?? '');
  const [zip, setZip] = useState(profile.zip ?? '');
  const [saving, setSaving] = useState(false);
  const nameChanged = firstName.trim() !== profile.firstName || lastName.trim() !== profile.lastName;

  const onSave = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast.error(t('me.personal.nameRequired'));
      return;
    }
    // The API takes 12345 or 12345-6789; a ZIP+4 typed (or filled in by the
    // address lookup) without its dash is fixed here rather than refused there.
    const zipValue = zip.trim() ? normalizeZip(zip) : null;
    if (zip.trim() && !zipValue) {
      toast.error(t('me.zipInvalid'));
      return;
    }
    setSaving(true);
    try {
      if (nameChanged) {
        await updateProfile({ firstName: firstName.trim(), lastName: lastName.trim() });
        await refreshUser();
      }
      const r = await updateSelfProfile({
        phone: phone.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: stateCode || null,
        zip: zipValue,
      });
      // The organization may ask HR to confirm an address change first (202).
      toast.success(isPending(r) ? t('me.pendingApproval') : t('me.profileUpdated'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('me.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  // Field, not a wrapping label: a control inside the label inherited its
  // letter-spacing, so typed names read "M a r i a" next to the address box.
  const field = (label: string, value: string, set: (v: string) => void, extra: { type?: string; inputMode?: 'tel' | 'numeric'; autoComplete?: string; maxLength?: number } = {}) => (
    <Field label={label}>
      {(p) => <Input {...p} value={value} onChange={(e) => set(e.target.value)} type={extra.type} inputMode={extra.inputMode} autoComplete={extra.autoComplete} maxLength={extra.maxLength} />}
    </Field>
  );
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{t('me.personal.editTitle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {field(t('me.fld.firstName'), firstName, setFirstName, { autoComplete: 'given-name', maxLength: 100 })}
          {field(t('me.fld.lastName'), lastName, setLastName, { autoComplete: 'family-name', maxLength: 100 })}
        </div>
        {field(t('me.fld.phone'), phone, setPhone, { type: 'tel', inputMode: 'tel', autoComplete: 'tel' })}
        {/* Suggestions as they type; a pick fills city, state, ZIP and the unit on line 2. */}
        <Field label={t('me.fld.addr1')}>
          {(p) => (
            <AddressAutocomplete
              {...p}
              value={addressLine1}
              onChange={setAddressLine1}
              onPick={(s) => {
                const f = pickedFields(s);
                setAddressLine1(f.line1);
                if (f.line2) setAddressLine2(f.line2);
                setCity(f.city);
                setStateCode((US_STATES as readonly string[]).includes(f.state) ? f.state : '');
                setZip(f.zip);
              }}
            />
          )}
        </Field>
        {field(t('me.fld.addr2'), addressLine2, setAddressLine2, { autoComplete: 'address-line2' })}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_7rem_8rem]">
          {field(t('me.fld.city'), city, setCity, { autoComplete: 'address-level2' })}
          <Field label={t('me.fld.state')}>
            {(p) => (
              <Select {...p} value={stateCode} onChange={(e) => setStateCode(e.target.value)} autoComplete="address-level1">
                <option value="">—</option>
                {US_STATES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {field(t('me.fld.zip'), zip, setZip, { inputMode: 'numeric', autoComplete: 'postal-code', maxLength: 10 })}
        </div>
        {/* Said where the home state is changed (it sat under the old form, about a "work state"). */}
        <p className="text-xs text-silver">{t('me.homeStateNote')}</p>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('me.cancel')}
        </Button>
        <Button onClick={onSave} disabled={saving} data-testid="me-personal-save">
          {saving ? t('me.saving') : t('me.save')}
        </Button>
      </DrawerFooter>
    </>
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
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  // A failed fetch must NOT render as "Not set" — that's a real consent
  // state with its own copy. Show a retry affordance instead.
  const consentQuery = useQuery({
    queryKey: ['FaceConsentRow', 'consent', attempt],
    queryFn: () => getFaceConsent(),
  });
  const loadError = consentQuery.error ? consentQuery.error instanceof ApiError
            ? consentQuery.error.message
            : t('me.face.loadFailed') : null;
  useEffect(() => {
    setConsent(null);
  }, [attempt]);
  useEffect(() => {
    const c = consentQuery.data;
    if (c === undefined) return;
    setConsent(c);
  }, [consentQuery.data]);

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
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver">
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
          {consent.status === null ? (
            // Nothing chosen yet: a question, not "Turn off" for something that isn't on.
            <span className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => change(true)}>
                {t('me.face.allow')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(false)}>
                {t('me.face.dontAllow')}
              </Button>
            </span>
          ) : consent.status === 'GRANTED' ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(false)}>
              {t('me.face.turnOff')}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(true)}>
              {t('me.face.turnOn')}
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
  // Masked like the home's number line: it is the key to their punches,
  // and this page is the one people show over a shoulder.
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver">
        {t('me.num.title')}
      </div>
      {employeeNumber === null ? (
        <Skeleton className="mt-1 h-9 w-56" />
      ) : employeeNumber.employeeNumber ? (
        <>
          <div className="mt-1 flex items-center gap-3">
            <span className="font-mono text-3xl tracking-[0.5em] text-ink" data-testid="me-employee-number">
              {revealed ? employeeNumber.employeeNumber : '••••'}
            </span>
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              className="inline-flex items-center rounded p-1.5 text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11 coarse:min-w-11 coarse:justify-center"
              aria-label={revealed ? t('dash.hideNumber') : t('dash.showNumber')}
              aria-pressed={revealed}
            >
              {revealed ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            </button>
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

function ReadonlyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 text-sm text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-muted">{hint}</div>}
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
      {rows !== null && rows.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" /> {t('me.em.add')}
          </Button>
        </div>
      )}
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
            <DataGrid<NonNullable<typeof rows>[number]>
              id="me-emergency-contacts"
              caption={t('me.tab.emergency')}
              rows={rows}
              rowKey={(row) => row.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columnChooser={false}
              onRowClick={(row) => setDraft({ id: row.id, name: row.name, relation: row.relation, phone: row.phone, email: row.email ?? '', isPrimary: row.isPrimary })}
              rowActionLabel={(row) => row.name}
              columns={[
                { key: 'name', header: t('me.th.name'), accessor: (row) => row.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'relation', header: t('me.th.relation'), accessor: (row) => relLabel(t, row.relation), sortable: true, cardMeta: true },
                { key: 'phone', header: t('me.th.phone'), accessor: (row) => row.phone, cardMeta: true },
                { key: 'email', header: t('me.th.email'), accessor: (row) => row.email, cell: (row) => row.email ?? '—' },
                { key: 'primary', header: t('me.th.primary'), accessor: (row) => (row.isPrimary ? t('me.primary') : ''), sortable: true, searchable: false, cell: (row) => (row.isPrimary ? <Badge variant="accent">{t('me.primary')}</Badge> : '—') },
                {
                  key: 'actions',
                  header: t('me.th.actions'),
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (row) => (
                    <Button size="sm" variant="ghost" className="text-silver hover:text-alert" aria-label={t('me.deleteAria')} onClick={() => onDelete(row.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ),
                },
              ]}
            />
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
      {rows !== null && rows.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" /> {t('me.dep.add')}
          </Button>
        </div>
      )}
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
            <DataGrid<NonNullable<typeof rows>[number]>
              id="me-dependents"
              caption={t('me.tab.dependents')}
              rows={rows}
              rowKey={(row) => row.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columnChooser={false}
              onRowClick={(row) => setDraft({ id: row.id, firstName: row.firstName, lastName: row.lastName, relation: row.relation, dob: row.dob ? row.dob.slice(0, 10) : '', ssnLast4: row.ssnLast4 ?? '', isCovered: row.isCovered })}
              rowActionLabel={(row) => `${row.firstName} ${row.lastName}`}
              columns={[
                { key: 'name', header: t('me.th.name'), accessor: (row) => `${row.firstName} ${row.lastName}`, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'relation', header: t('me.th.relation'), accessor: (row) => relLabel(t, row.relation), sortable: true, cardMeta: true },
                { key: 'dob', header: t('me.th.dob'), accessor: (row) => row.dob, sortable: true, searchable: false, cardMeta: true, cell: (row) => fmtDate(parseYmd(row.dob)) },
                { key: 'ssn4', header: t('me.th.ssn4'), accessor: (row) => row.ssnLast4, searchable: false, cell: (row) => (row.ssnLast4 ? `•••-••-${row.ssnLast4}` : '—') },
                { key: 'covered', header: t('me.th.covered'), accessor: (row) => (row.isCovered ? t('me.yes') : t('me.no')), sortable: true, searchable: false, cell: (row) => (row.isCovered ? <Badge variant="accent">{t('me.yes')}</Badge> : t('me.no')) },
                {
                  key: 'actions',
                  header: t('me.th.actions'),
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (row) => (
                    <Button size="sm" variant="ghost" className="text-silver hover:text-alert" aria-label={t('me.deleteAria')} onClick={() => onDelete(row.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ),
                },
              ]}
            />
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
        {rows !== null && rows.length > 0 && (
          <Button onClick={openAdd}>
            <Plus className="mr-2 h-4 w-4" /> {t('me.ben.add')}
          </Button>
        )}
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
            <DataGrid<NonNullable<typeof rows>[number]>
              id="me-beneficiaries"
              caption={t('me.tab.beneficiaries')}
              rows={rows}
              rowKey={(row) => row.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columnChooser={false}
              onRowClick={(row) => setDraft({ id: row.id, name: row.name, relation: row.relation, kind: row.kind, percentage: row.percentage, dependentId: row.dependentId })}
              rowActionLabel={(row) => row.name}
              columns={[
                { key: 'name', header: t('me.th.name'), accessor: (row) => row.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'relation', header: t('me.th.relation'), accessor: (row) => relLabel(t, row.relation), sortable: true, cardMeta: true },
                { key: 'kind', header: t('me.th.kind'), accessor: (row) => benkLabel(t, row.kind), sortable: true, cardMeta: true, cell: (row) => <Badge variant={row.kind === 'PRIMARY' ? 'accent' : 'default'}>{benkLabel(t, row.kind)}</Badge> },
                { key: 'percentage', header: t('me.th.percentage'), accessor: (row) => row.percentage, csv: (row) => `${row.percentage}%`, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (row) => `${row.percentage}%` },
                {
                  key: 'actions',
                  header: t('me.th.actions'),
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (row) => (
                    <Button size="sm" variant="ghost" className="text-silver hover:text-alert" aria-label={t('me.deleteAria')} onClick={() => onDelete(row.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ),
                },
              ]}
            />
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
  onEditAddress,
}: {
  rows: LifeEvent[] | null;
  error: string | null;
  onRetry: () => void;
  onChange: () => void;
  onEditAddress: () => void;
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
      {/* Moving is an address change: one place to make it (F500 G5). */}
      <p className="text-sm text-silver" data-testid="me-ev-address">
        {t('me.ev.movedHint')}{' '}
        <button type="button" onClick={onEditAddress} className="inline-flex min-h-6 items-center text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-11">
          {t('me.ev.movedLink')}
        </button>
      </p>
      {rows !== null && rows.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> {t('me.ev.report')}
          </Button>
        </div>
      )}
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
              description={t('me.ev.emptyDesc2')}
              action={
                <Button onClick={() => setOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" /> {t('me.ev.report')}
                </Button>
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof rows>[number]>
              id="me-life-events"
              caption={t('me.tab.lifeEvents')}
              rows={rows}
              rowKey={(row) => row.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columnChooser={false}
              columns={[
                { key: 'event', header: t('me.th.event'), accessor: (row) => evkLabel(t, row.kind), sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'date', header: t('me.th.date'), accessor: (row) => row.eventDate, sortable: true, searchable: false, cardMeta: true, cell: (row) => fmtDate(parseYmd(row.eventDate)) },
                {
                  key: 'status',
                  header: t('me.th.status'),
                  accessor: (row) => evsLabel(t, row.status),
                  sortable: true,
                  cardMeta: true,
                  cell: (row) => <Badge variant={row.status === 'APPROVED' ? 'success' : row.status === 'REJECTED' ? 'destructive' : 'pending'}>{evsLabel(t, row.status)}</Badge>,
                },
                { key: 'submitted', header: t('me.th.submitted'), accessor: (row) => row.createdAt, sortable: true, searchable: false, cell: (row) => fmtDate(row.createdAt) },
                { key: 'notes', header: t('me.th.notes'), accessor: (row) => row.notes, className: 'max-w-xs truncate', cell: (row) => row.notes ?? '—' },
              ]}
            />
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
              {/* An address change is made on the Profile tab (the line above links it). */}
              {LIFE_EVENT_KINDS.filter((k) => k !== 'ADDRESS_CHANGE').map((k) => (
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
          <DataGrid<NonNullable<typeof rows>[number]>
            id="me-tax-documents"
            caption={t('me.tab.taxDocs')}
            rows={rows}
            rowKey={(row) => row.id}
            search={false}
            urlState={false}
            exportCsv={false}
            columnChooser={false}
            columns={[
              { key: 'form', header: t('me.th.form'), accessor: (row) => TAX_DOC_LABEL[row.kind] ?? row.kind, sortable: true, primary: true, className: 'font-medium text-white' },
              { key: 'year', header: t('me.th.taxYear'), accessor: (row) => row.taxYear, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
              { key: 'issued', header: t('me.th.issued'), accessor: (row) => row.issuedAt, sortable: true, searchable: false, cardMeta: true, cell: (row) => fmtDate(row.issuedAt) },
              { key: 'size', header: t('me.th.size'), accessor: (row) => row.fileSize, csv: (row) => (row.fileSize ? `${Math.round(row.fileSize / 1024)} KB` : ''), sortable: true, searchable: false, align: 'right', className: 'tabular-nums whitespace-nowrap', cell: (row) => (row.fileSize ? `${Math.round(row.fileSize / 1024)} KB` : '—') },
              {
                key: 'action',
                header: t('me.th.action'),
                accessor: () => null,
                searchable: false,
                csv: () => '',
                align: 'right',
                stopRowClick: true,
                cell: (row) =>
                  row.downloadUrl ? (
                    <Button asChild variant="ghost" size="sm">
                      <a href={row.downloadUrl} download>
                        {t('me.tax.download')}
                      </a>
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" disabled title={t('me.tax.legacyHint')}>
                      {t('me.tax.download')}
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** "32541", "32541-1234", or nine digits in a row (ZIP+4 without its dash) — null when it can't be a US ZIP. */
export function normalizeZip(raw: string): string | null {
  const d = raw.replace(/[\s-]/g, '');
  if (/^\d{5}$/.test(d)) return d;
  if (/^\d{9}$/.test(d)) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return null;
}
