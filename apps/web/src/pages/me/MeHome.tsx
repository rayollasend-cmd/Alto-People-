import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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

const RELATION_LABEL: Record<string, string> = {
  SPOUSE: 'Spouse',
  PARENT: 'Parent',
  CHILD: 'Child',
  SIBLING: 'Sibling',
  FRIEND: 'Friend',
  DOMESTIC_PARTNER: 'Domestic partner',
  OTHER: 'Other',
};

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

// Indexed by the server's raw `kind`, which is typed as a bare string —
// hence the wide index signature. `satisfies` still forces every known
// kind to carry a label, so adding one to LIFE_EVENT_KINDS breaks here.
const LIFE_EVENT_LABEL: Record<string, string> = {
  MARRIAGE: 'Marriage',
  DIVORCE: 'Divorce',
  BIRTH: 'Birth',
  ADOPTION: 'Adoption',
  DEATH_OF_DEPENDENT: 'Death of a dependent',
  ADDRESS_CHANGE: 'Address change',
  NAME_CHANGE: 'Name change',
  OTHER: 'Other',
} satisfies Record<(typeof LIFE_EVENT_KINDS)[number], string>;

const LIFE_EVENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const BENEFICIARY_KIND_LABEL: Record<string, string> = {
  PRIMARY: 'Primary',
  CONTINGENT: 'Contingent',
};

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

function settledError(r: PromiseSettledResult<unknown>): string | null {
  if (r.status === 'fulfilled') return null;
  return r.reason instanceof ApiError
    ? r.reason.message
    : 'Failed to load this section.';
}

export function MeHome() {
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
    const [p, n, c, d, b, e, t] = results;
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
    if (t.status === 'fulfilled')
      setTaxDocs((t.value as { documents: TaxDoc[] }).documents);
    setSectionErrors({
      profile: settledError(p) ?? settledError(n),
      contacts: settledError(c),
      dependents: settledError(d),
      beneficiaries: settledError(b),
      events: settledError(e),
      taxDocs: settledError(t),
    });
    if (results.every((r) => r.status === 'rejected')) {
      const first = results[0];
      setError(
        first.status === 'rejected' && first.reason instanceof ApiError
          ? first.reason.message
          : 'Failed to load self-service data.',
      );
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="My profile"
        subtitle="Personal info, emergency contacts, dependents, beneficiaries, and life events you can manage yourself."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'My profile' }]}
      />

      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="emergency">Emergency contacts</TabsTrigger>
          <TabsTrigger value="dependents">Dependents</TabsTrigger>
          <TabsTrigger value="beneficiaries">Beneficiaries</TabsTrigger>
          <TabsTrigger value="life-events">Life events</TabsTrigger>
          <TabsTrigger value="tax-docs">Tax documents</TabsTrigger>
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
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
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
  const [phone, setPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [zip, setZip] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!profile) return;
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
      toast.success('Profile updated.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
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
          <ReadonlyField label="Name" value={`${profile.firstName} ${profile.lastName}`} />
          <ReadonlyField label="Work email" value={profile.email} />
          <ReadonlyField
            label="Department"
            value={profile.department?.name ?? '—'}
          />
          <ReadonlyField label="Manager" value={profile.managerName ?? '—'} />
          <ReadonlyField
            label="Job profile"
            value={profile.jobProfile?.title ?? '—'}
          />
          <ReadonlyField label="Employment type" value={profile.employmentType} />
        </div>

        <div className="border-t border-navy-secondary pt-5 space-y-4">
          <div className="text-sm font-medium text-white">Editable</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FieldInput
              label="Phone"
              value={phone}
              onChange={setPhone}
              placeholder="+1 555 555 5555"
              type="tel"
              inputMode="tel"
            />
            <FieldInput
              label="Address line 1"
              value={addressLine1}
              onChange={setAddressLine1}
            />
            <FieldInput
              label="Address line 2"
              value={addressLine2}
              onChange={setAddressLine2}
            />
            <FieldInput label="City" value={city} onChange={setCity} />
            <FieldInput
              label="State"
              value={stateCode}
              onChange={(v) => setStateCode(v.toUpperCase().slice(0, 2))}
              placeholder="CA"
            />
            <FieldInput
              label="ZIP"
              value={zip}
              onChange={setZip}
              placeholder="94110"
            />
          </div>
          <div className="text-xs text-silver">
            Changing your work state opens a record on your associate history so
            HR can re-check tax setup.
          </div>
          <div className="flex justify-end">
            <Button onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
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
            : 'Couldn’t load your face-verification setting.',
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
            title: 'Turn on face verification?',
            description:
              'The kiosk will take a quick photo at each punch to confirm it’s really you. Photos are deleted after 90 days; a numeric face template is kept while you actively punch and deleted if you turn this off.',
          }
        : {
            title: 'Turn off face verification?',
            description:
              'Your stored punch photos and face template are deleted immediately. You’ll clock in with just your number from now on.',
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await setFaceConsent(next);
      setConsent({ status: r.status, at: new Date().toISOString() });
      toast.success(
        next
          ? 'Face verification is on.'
          : 'Face verification is off — stored photos and template deleted.',
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not change your face-verification setting.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        Kiosk face verification
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
              Retry
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
            <Badge variant="success">On</Badge>
          ) : consent.status === 'DECLINED' ? (
            <Badge variant="outline">Off — number only</Badge>
          ) : (
            <Badge variant="pending">Not set</Badge>
          )}
          <span className="text-xs text-silver">
            {consent.status === 'GRANTED'
              ? 'The kiosk takes a quick photo at each punch to confirm it’s you.'
              : consent.status === 'DECLINED'
                ? 'You clock in with just your number — no photo is taken or stored.'
                : 'The kiosk will ask you once at your next punch. You can also decide here.'}
          </span>
          {consent.status !== 'GRANTED' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(true)}>
              Turn on
            </Button>
          )}
          {consent.status !== 'DECLINED' && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(false)}>
              Turn off
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
  return (
    <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4">
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        Employee number
      </div>
      {employeeNumber === null ? (
        <Skeleton className="mt-1 h-9 w-56" />
      ) : employeeNumber.employeeNumber ? (
        <>
          <div className="mt-1 font-mono text-3xl tracking-[0.5em] text-white">
            {employeeNumber.employeeNumber}
          </div>
          <div className="mt-1 text-xs text-silver">
            Use this number to clock in and out at the kiosk. Issued{' '}
            {fmtDate(employeeNumber.issuedAt)}
            .
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-silver">
          Not yet issued. HR will assign you a 4-digit number after your
          onboarding is approved.
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
    if (!(await confirm({ title: 'Remove this emergency contact?', destructive: true }))) return;
    try {
      await deleteEmergency(id);
      toast.success('Contact removed.');
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" /> Add contact
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
              title="No emergency contacts"
              description="Add at least one person we can reach in case of an emergency."
              action={
                <Button onClick={openAdd}>
                  <Plus className="mr-2 h-4 w-4" /> Add contact
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Relation</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead className="hidden md:table-cell">Primary</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
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
                          {row.email ?? '—'}{row.isPrimary ? ' · Primary' : ''}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{RELATION_LABEL[row.relation] ?? row.relation}</TableCell>
                    <TableCell>{row.phone}</TableCell>
                    <TableCell className="hidden md:table-cell">{row.email ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {row.isPrimary ? <Badge variant="accent">Primary</Badge> : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
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
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.name.trim() || !draft.phone.trim()) {
      toast.error('Name and phone are required.');
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
      toast.success(draft.id ? 'Contact updated.' : 'Contact added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? 'Edit contact' : 'Add contact'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label>Relation</Label>
          <Select
            className="mt-1"
            value={draft.relation}
            onChange={(e) =>
              setDraft({ ...draft, relation: e.target.value as ContactDraft['relation'] })
            }
          >
            {(['SPOUSE', 'PARENT', 'CHILD', 'SIBLING', 'FRIEND', 'OTHER'] as const).map((r) => (
              <option key={r} value={r}>
                {RELATION_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Phone</Label>
          <Input
            className="mt-1"
            type="tel"
            inputMode="tel"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          />
        </div>
        <div>
          <Label>Email</Label>
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
          Primary contact
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
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
    if (!(await confirm({ title: 'Remove this dependent?', destructive: true }))) return;
    try {
      await deleteDependent(id);
      toast.success('Dependent removed.');
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" /> Add dependent
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
              title="No dependents"
              description="Add a spouse, child, or domestic partner to enroll them in benefits."
              action={
                <Button onClick={openAdd}>
                  <Plus className="mr-2 h-4 w-4" /> Add dependent
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Relation</TableHead>
                  <TableHead className="hidden md:table-cell">DOB</TableHead>
                  <TableHead className="hidden lg:table-cell">SSN (last 4)</TableHead>
                  <TableHead>Covered</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
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
                          {row.dob ? `DOB ${fmtDate(parseYmd(row.dob))}` : '—'}
                          {row.ssnLast4 ? ` · •••-••-${row.ssnLast4}` : ''}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{RELATION_LABEL[row.relation] ?? row.relation}</TableCell>
                    <TableCell className="hidden md:table-cell">{fmtDate(parseYmd(row.dob))}</TableCell>
                    <TableCell className="hidden lg:table-cell">{row.ssnLast4 ? `•••-••-${row.ssnLast4}` : '—'}</TableCell>
                    <TableCell>
                      {row.isCovered ? <Badge variant="accent">Yes</Badge> : 'No'}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
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
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      toast.error('First and last name are required.');
      return;
    }
    if (draft.ssnLast4 && !/^\d{4}$/.test(draft.ssnLast4)) {
      toast.error('SSN last 4 must be exactly 4 digits.');
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
      toast.success(draft.id ? 'Dependent updated.' : 'Dependent added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? 'Edit dependent' : 'Add dependent'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>First name</Label>
            <Input
              className="mt-1"
              value={draft.firstName}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
            />
          </div>
          <div>
            <Label>Last name</Label>
            <Input
              className="mt-1"
              value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })}
            />
          </div>
        </div>
        <div>
          <Label>Relation</Label>
          <Select
            className="mt-1"
            value={draft.relation}
            onChange={(e) =>
              setDraft({ ...draft, relation: e.target.value as DependentDraft['relation'] })
            }
          >
            {(['SPOUSE', 'CHILD', 'DOMESTIC_PARTNER', 'OTHER'] as const).map((r) => (
              <option key={r} value={r}>
                {RELATION_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Date of birth</Label>
          <Input
            className="mt-1"
            type="date"
            max={ymdLocal()}
            value={draft.dob}
            onChange={(e) => setDraft({ ...draft, dob: e.target.value })}
          />
        </div>
        <div>
          <Label>SSN last 4</Label>
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
          Covered on benefits
        </label>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
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
    if (!(await confirm({ title: 'Remove this beneficiary?', destructive: true }))) return;
    try {
      await deleteBeneficiary(id);
      toast.success('Beneficiary removed.');
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-silver space-x-4">
          <span>
            Primary:{' '}
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
            {primaryTotal !== 100 && primaryTotal > 0 && ' — must total 100%'}
          </span>
          <span>
            Contingent:{' '}
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
              ' — must total 100%'}
          </span>
        </div>
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" /> Add beneficiary
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
              title="No beneficiaries"
              description="Designate who receives life-insurance and 401(k) proceeds."
              action={
                <Button onClick={openAdd}>
                  <Plus className="mr-2 h-4 w-4" /> Add beneficiary
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Relation</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Percentage</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
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
                          {RELATION_LABEL[row.relation] ?? row.relation}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{RELATION_LABEL[row.relation] ?? row.relation}</TableCell>
                    <TableCell>
                      <Badge variant={row.kind === 'PRIMARY' ? 'accent' : 'default'}>
                        {BENEFICIARY_KIND_LABEL[row.kind] ?? row.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.percentage}%
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
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
      toast.error('Name required.');
      return;
    }
    if (draft.percentage < 0 || draft.percentage > 100) {
      toast.error('Percentage must be between 0 and 100.');
      return;
    }
    // Hard-block only over-allocation: requiring exactly 100% on every
    // save would deadlock incremental entry (a first 50% row could never
    // be added). Under-allocation saves but the panel banner keeps
    // flagging the tier until it totals 100%.
    if (tierTotalAfter > 100) {
      setTierError(
        `${draft.kind} allocations would total ${tierTotalAfter}% — a tier cannot exceed 100%.`,
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
      toast.success(draft.id ? 'Beneficiary updated.' : 'Beneficiary added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{draft.id ? 'Edit beneficiary' : 'Add beneficiary'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {dependents.length > 0 && (
          <div>
            <Label>Copy from dependent</Label>
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
              <option value="">— none —</option>
              {dependents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.firstName} {d.lastName} (
                  {RELATION_LABEL[d.relation] ?? d.relation})
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div>
          <Label>Relation</Label>
          <Select
            className="mt-1"
            value={draft.relation}
            onChange={(e) =>
              setDraft({ ...draft, relation: e.target.value as BeneficiaryDraft['relation'] })
            }
          >
            {(['SPOUSE', 'CHILD', 'DOMESTIC_PARTNER', 'OTHER'] as const).map((r) => (
              <option key={r} value={r}>
                {RELATION_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={draft.kind}
            onChange={(e) => {
              setTierError(null);
              setDraft({ ...draft, kind: e.target.value as BeneficiaryDraft['kind'] });
            }}
          >
            <option value="PRIMARY">Primary</option>
            <option value="CONTINGENT">Contingent</option>
          </Select>
        </div>
        <div>
          <Label>Percentage</Label>
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
            {BENEFICIARY_KIND_LABEL[draft.kind] ?? draft.kind} tier will total{' '}
            {tierTotalAfter}% after saving
            {tierTotalAfter !== 100 && ' (must reach exactly 100%)'}.
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
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
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
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<typeof LIFE_EVENT_KINDS[number]>('MARRIAGE');
  const [eventDate, setEventDate] = useState(ymdLocal());
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!eventDate) {
      toast.error('Event date is required.');
      return;
    }
    setSaving(true);
    try {
      await createLifeEvent({
        kind,
        eventDate,
        notes: notes.trim() || null,
      });
      toast.success('Life event submitted for review.');
      setOpen(false);
      setEventDate(ymdLocal());
      setNotes('');
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to submit.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Report event
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
              title="No life events"
              description="Marriage, birth, address changes — report them here so HR can update benefits and tax setup."
              action={
                <Button onClick={() => setOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" /> Report event
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Submitted</TableHead>
                  <TableHead className="hidden lg:table-cell">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">
                          {LIFE_EVENT_LABEL[row.kind] ??
                            row.kind.replace(/_/g, ' ')}
                        </div>
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          Submitted {fmtDate(row.createdAt)}
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
                        {LIFE_EVENT_STATUS_LABELS[row.status] ??
                          row.status.replace(/_/g, ' ')}
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
          <DrawerTitle>Report a life event</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div>
            <Label>Event</Label>
            <Select
              className="mt-1"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof LIFE_EVENT_KINDS[number])}
            >
              {LIFE_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LIFE_EVENT_LABEL[k]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Event date</Label>
            <Input
              className="mt-1"
              type="date"
              max={ymdLocal()}
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              className="mt-1"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <p className="text-xs text-silver">
            HR reviews these within 3 business days.
          </p>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={saving}>
            {saving ? 'Submitting…' : 'Submit for review'}
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
            title="No tax documents yet"
            description="W-2 / 1099 forms will appear here after your first tax year on payroll."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Form</TableHead>
                <TableHead className="text-right">Tax year</TableHead>
                <TableHead className="hidden md:table-cell">Issued</TableHead>
                <TableHead className="hidden md:table-cell text-right">
                  Size
                </TableHead>
                <TableHead className="w-32 text-right">Action</TableHead>
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
                        Issued {fmtDate(row.issuedAt)}
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
                          Download
                        </a>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled
                        title="Legacy document — contact HR for a copy"
                      >
                        Download
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
