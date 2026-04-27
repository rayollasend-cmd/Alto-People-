import { useEffect, useState } from 'react';
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
  getProfile,
  listBeneficiaries,
  listDependents,
  listEmergency,
  listLifeEvents,
  listTaxDocs,
  updateBeneficiary,
  updateDependent,
  updateEmergency,
  updateSelfProfile,
  type Beneficiary,
  type Dependent,
  type EmergencyContact,
  type LifeEvent,
  type SelfProfile,
  type TaxDoc,
} from '@/lib/selfApi';
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
  Input,
  PageHeader,
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab =
  | 'profile'
  | 'emergency'
  | 'dependents'
  | 'beneficiaries'
  | 'life-events'
  | 'tax-docs';

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

const TAX_DOC_LABEL: Record<TaxDoc['kind'], string> = {
  W2: 'Form W-2',
  W3: 'Form W-3',
  N_1099_NEC: 'Form 1099-NEC',
  N_1095_C: 'Form 1095-C',
};

export function MeHome() {
  const [tab, setTab] = useState<Tab>('profile');
  const [profile, setProfile] = useState<SelfProfile | null>(null);
  const [contacts, setContacts] = useState<EmergencyContact[] | null>(null);
  const [dependents, setDependents] = useState<Dependent[] | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[] | null>(null);
  const [events, setEvents] = useState<LifeEvent[] | null>(null);
  const [taxDocs, setTaxDocs] = useState<TaxDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [p, c, d, b, e, t] = await Promise.all([
        getProfile(),
        listEmergency(),
        listDependents(),
        listBeneficiaries(),
        listLifeEvents(),
        listTaxDocs(),
      ]);
      setProfile(p);
      setContacts(c.contacts);
      setDependents(d.dependents);
      setBeneficiaries(b.beneficiaries);
      setEvents(e.events);
      setTaxDocs(t.documents);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : 'Failed to load self-service data.';
      setError(msg);
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
        <Card>
          <CardContent className="p-4 text-sm text-alert">{error}</CardContent>
        </Card>
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
          <ProfilePanel profile={profile} onSaved={refresh} />
        </TabsContent>

        <TabsContent value="emergency">
          <EmergencyPanel rows={contacts} onChange={refresh} />
        </TabsContent>

        <TabsContent value="dependents">
          <DependentsPanel rows={dependents} onChange={refresh} />
        </TabsContent>

        <TabsContent value="beneficiaries">
          <BeneficiariesPanel rows={beneficiaries} onChange={refresh} />
        </TabsContent>

        <TabsContent value="life-events">
          <LifeEventsPanel rows={events} onChange={refresh} />
        </TabsContent>

        <TabsContent value="tax-docs">
          <TaxDocsPanel rows={taxDocs} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ Profile ============

function ProfilePanel({
  profile,
  onSaved,
}: {
  profile: SelfProfile | null;
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
        <CardContent className="p-6">
          <SkeletonRows count={4} />
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
      toast.error(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadonlyField label="Name" value={`${profile.firstName} ${profile.lastName}`} />
          <ReadonlyField label="Work email" value={profile.email} />
          <ReadonlyField
            label="Department"
            value={profile.department?.name ?? '—'}
          />
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        className="mt-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

// ============ Emergency contacts ============

function EmergencyPanel({
  rows,
  onChange,
}: {
  rows: EmergencyContact[] | null;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState<ContactDraft | null>(null);

  const onDelete = async (id: string) => {
    if (!window.confirm('Remove this emergency contact?')) return;
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
        <Button
          onClick={() =>
            setDraft({
              name: '',
              relation: 'SPOUSE',
              phone: '',
              email: '',
              isPrimary: rows?.length === 0,
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" /> Add contact
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No emergency contacts"
              description="Add at least one person we can reach in case of an emergency."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Relation</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Primary</TableHead>
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
                    <TableCell className="font-medium text-white">{row.name}</TableCell>
                    <TableCell>{RELATION_LABEL[row.relation] ?? row.relation}</TableCell>
                    <TableCell>{row.phone}</TableCell>
                    <TableCell>{row.email ?? '—'}</TableCell>
                    <TableCell>
                      {row.isPrimary ? <Badge variant="accent">Primary</Badge> : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(row.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-silver hover:text-alert transition"
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
      toast.error(err instanceof ApiError ? err.message : 'Failed to save.');
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
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
          </select>
        </div>
        <div>
          <Label>Phone</Label>
          <Input
            className="mt-1"
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
  onChange,
}: {
  rows: Dependent[] | null;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState<DependentDraft | null>(null);

  const onDelete = async (id: string) => {
    if (!window.confirm('Remove this dependent?')) return;
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
        <Button
          onClick={() =>
            setDraft({
              firstName: '',
              lastName: '',
              relation: 'CHILD',
              dob: '',
              ssnLast4: '',
              isCovered: true,
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" /> Add dependent
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No dependents"
              description="Add a spouse, child, or domestic partner to enroll them in benefits."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Relation</TableHead>
                  <TableHead>DOB</TableHead>
                  <TableHead>SSN (last 4)</TableHead>
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
                      {row.firstName} {row.lastName}
                    </TableCell>
                    <TableCell>{RELATION_LABEL[row.relation] ?? row.relation}</TableCell>
                    <TableCell>{row.dob ? row.dob.slice(0, 10) : '—'}</TableCell>
                    <TableCell>{row.ssnLast4 ? `•••-••-${row.ssnLast4}` : '—'}</TableCell>
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
                        className="opacity-0 group-hover:opacity-100 text-silver hover:text-alert transition"
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
    if (draft.dob && !/^\d{4}-\d{2}-\d{2}$/.test(draft.dob)) {
      toast.error('Date of birth must be YYYY-MM-DD.');
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
      toast.error(err instanceof ApiError ? err.message : 'Failed to save.');
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
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
          </select>
        </div>
        <div>
          <Label>Date of birth (YYYY-MM-DD)</Label>
          <Input
            className="mt-1"
            value={draft.dob}
            onChange={(e) => setDraft({ ...draft, dob: e.target.value })}
            placeholder="1990-01-31"
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
  onChange,
}: {
  rows: Beneficiary[] | null;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState<BeneficiaryDraft | null>(null);

  const primaryTotal = (rows ?? [])
    .filter((b) => b.kind === 'PRIMARY')
    .reduce((sum, b) => sum + b.percentage, 0);

  const onDelete = async (id: string) => {
    if (!window.confirm('Remove this beneficiary?')) return;
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
      <div className="flex items-center justify-between">
        <div className="text-sm text-silver">
          Primary allocation:{' '}
          <span
            className={
              primaryTotal === 100
                ? 'text-emerald-400'
                : primaryTotal > 0
                  ? 'text-alert'
                  : 'text-silver'
            }
          >
            {primaryTotal}%
          </span>{' '}
          {primaryTotal !== 100 && primaryTotal > 0 && '— must total 100%'}
        </div>
        <Button
          onClick={() =>
            setDraft({
              name: '',
              relation: 'SPOUSE',
              kind: 'PRIMARY',
              percentage: Math.max(0, 100 - primaryTotal),
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" /> Add beneficiary
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No beneficiaries"
              description="Designate who receives life-insurance and 401(k) proceeds."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Relation</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Percentage</TableHead>
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
                      })
                    }
                  >
                    <TableCell className="font-medium text-white">{row.name}</TableCell>
                    <TableCell>{RELATION_LABEL[row.relation] ?? row.relation}</TableCell>
                    <TableCell>
                      <Badge variant={row.kind === 'PRIMARY' ? 'accent' : 'default'}>
                        {row.kind}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.percentage}%</TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(row.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-silver hover:text-alert transition"
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
  onClose,
  onSaved,
}: {
  draft: BeneficiaryDraft;
  setDraft: (d: BeneficiaryDraft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!draft.name.trim()) {
      toast.error('Name is required.');
      return;
    }
    if (draft.percentage < 0 || draft.percentage > 100) {
      toast.error('Percentage must be between 0 and 100.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        relation: draft.relation,
        kind: draft.kind,
        percentage: draft.percentage,
      };
      if (draft.id) await updateBeneficiary(draft.id, body);
      else await createBeneficiary({ ...body, dependentId: null });
      toast.success(draft.id ? 'Beneficiary updated.' : 'Beneficiary added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to save.');
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
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
          </select>
        </div>
        <div>
          <Label>Kind</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as BeneficiaryDraft['kind'] })
            }
          >
            <option value="PRIMARY">Primary</option>
            <option value="CONTINGENT">Contingent</option>
          </select>
        </div>
        <div>
          <Label>Percentage</Label>
          <Input
            className="mt-1"
            type="number"
            min={0}
            max={100}
            value={draft.percentage}
            onChange={(e) => setDraft({ ...draft, percentage: Number(e.target.value) || 0 })}
          />
        </div>
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
  onChange,
}: {
  rows: LifeEvent[] | null;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<typeof LIFE_EVENT_KINDS[number]>('MARRIAGE');
  const [eventDate, setEventDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      toast.error('Event date must be YYYY-MM-DD.');
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
      setEventDate('');
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
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No life events"
              description="Marriage, birth, address changes — report them here so HR can update benefits and tax setup."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-white">
                      {row.kind.replace(/_/g, ' ')}
                    </TableCell>
                    <TableCell>{row.eventDate.slice(0, 10)}</TableCell>
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
                        {row.status.replace(/_/g, ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell>{new Date(row.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="max-w-xs truncate">{row.notes ?? '—'}</TableCell>
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
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof LIFE_EVENT_KINDS[number])}
            >
              {LIFE_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Event date (YYYY-MM-DD)</Label>
            <Input
              className="mt-1"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              placeholder="2026-04-27"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <textarea
              className="mt-1 flex min-h-[80px] w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 py-2 text-sm text-white"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
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

function TaxDocsPanel({ rows }: { rows: TaxDoc[] | null }) {
  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
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
                <TableHead>Tax year</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Size</TableHead>
                <TableHead className="w-32 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-white">
                    {TAX_DOC_LABEL[row.kind] ?? row.kind}
                  </TableCell>
                  <TableCell>{row.taxYear}</TableCell>
                  <TableCell>{new Date(row.issuedAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {row.fileSize ? `${Math.round(row.fileSize / 1024)} KB` : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" disabled>
                      Download
                    </Button>
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
