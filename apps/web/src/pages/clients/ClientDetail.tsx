import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, Building2, MapPin, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatus, ClientSummary } from '@alto-people/shared';
import {
  archiveClient,
  getClient,
  setClientState,
  updateClient,
} from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { StatusBadge, statusLabel } from '@/lib/status';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { JobsSection } from './JobsSection';
import { RateDefaultsSection } from './RateDefaultsSection';
import { StatementsSection } from './StatementsSection';
import { LocationsSection } from './LocationsSection';
import { BenefitsPlansSection } from './BenefitsPlansSection';
import { QuickbooksSection } from './QuickbooksSection';

const STATUSES: ClientStatus[] = ['PROSPECT', 'ACTIVE', 'INACTIVE'];

// Index = the 0=Sunday…6=Saturday convention Client.weekStartsOn uses.
const WEEKDAY_NAMES: string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Two-letter US state codes that have either OT/break rules in Phase 23
// or predictive scheduling in Phase 25. The select doubles as a shortcut
// for the states the engine actually does something with.
const POLICY_STATES = [
  'CA', 'NY', 'IL', 'MA', 'NJ', 'PA', 'WA', 'CO', 'AZ', 'GA',
  'NC', 'VA', 'FL', 'TX', 'OR',
] as const;

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can('manage:clients');
  const confirm = useConfirm();

  const [client, setClient] = useState<ClientSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  // "?section=<key>" scrolls to that section once the client has loaded —
  // the QuickBooks OAuth return uses ?section=quickbooks to land back on
  // the card that started the flow. The param stays in the URL (it's a
  // shareable deep link); the ref stops re-scrolling on every refresh.
  const [searchParams] = useSearchParams();
  const section = searchParams.get('section');
  const scrolledSectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!client || !section || scrolledSectionRef.current === section) return;
    const el = document.getElementById(`section-${section}`);
    if (!el) return;
    scrolledSectionRef.current = section;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [client, section]);

  const onArchive = async () => {
    if (!client) return;
    if (
      !(await confirm({
        title: `Archive "${client.name}"?`,
        description:
          "They'll be hidden from the clients list. Open applications, payroll, and associates aren't deleted.",
        confirmLabel: 'Archive',
        destructive: true,
      }))
    ) {
      return;
    }
    setArchiving(true);
    try {
      await archiveClient(client.id);
      toast.success(`"${client.name}" archived.`);
      navigate('/clients');
    } catch (err) {
      toast.error('Could not archive.', {
        description: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
      setArchiving(false);
    }
  };

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const c = await getClient(id);
      setClient(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="mx-auto">
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                refresh();
              }}
            >
              Retry
            </Button>
          </div>
        </ErrorBanner>
      </div>
    );
  }
  if (!client) {
    return (
      <div className="mx-auto space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="mx-auto space-y-6">
      <PageHeader
        title={client.name}
        breadcrumbs={[{ label: 'Clients', to: '/clients' }, { label: client.name }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={client.status} />
            {client.industry && <span>· {client.industry}</span>}
            {client.contactEmail && <span>· {client.contactEmail}</span>}
          </span>
        }
        secondaryActions={
          canManage ? (
            <Button variant="ghost" onClick={onArchive} loading={archiving}>
              <Archive className="h-4 w-4" />
              Archive
            </Button>
          ) : undefined
        }
        className="mb-0"
      />

      {/* Each section wrapper carries a stable id so ?section=<key> can
          scroll straight to it (scroll-mt clears the sticky header). */}
      <div id="section-basics" className="scroll-mt-20 empty:hidden">
        <BasicsEditor
          client={client}
          canManage={canManage}
          onSaved={(updated) => setClient(updated)}
        />
      </div>

      <div id="section-state" className="scroll-mt-20 empty:hidden">
        <StateEditor
          client={client}
          canManage={canManage}
          onSaved={(updated) => setClient(updated)}
        />
      </div>

      <div id="section-locations" className="scroll-mt-20 empty:hidden">
        <LocationsSection clientId={client.id} />
      </div>

      <div id="section-jobs" className="scroll-mt-20 empty:hidden">
        <JobsSection clientId={client.id} />
      </div>

      <div id="section-rates" className="scroll-mt-20 empty:hidden">
        <RateDefaultsSection clientId={client.id} />
      </div>

      {/* Renders only for process:payroll holders. */}
      <div id="section-statements" className="scroll-mt-20 empty:hidden">
        <StatementsSection clientId={client.id} />
      </div>

      <div id="section-benefits" className="scroll-mt-20 empty:hidden">
        <BenefitsPlansSection clientId={client.id} />
      </div>

      <div id="section-quickbooks" className="scroll-mt-20 empty:hidden">
        <QuickbooksSection clientId={client.id} />
      </div>
    </div>
  );
}

/* ----------------------------- Basics editor ----------------------------- */

function BasicsEditor({
  client,
  canManage,
  onSaved,
}: {
  client: ClientSummary;
  canManage: boolean;
  onSaved: (c: ClientSummary) => void;
}) {
  const [name, setName] = useState(client.name);
  const [industry, setIndustry] = useState(client.industry ?? '');
  const [status, setStatus] = useState<ClientStatus>(client.status);
  const [contactEmail, setContactEmail] = useState(client.contactEmail ?? '');
  const [weekStartsOn, setWeekStartsOn] = useState(client.weekStartsOn ?? 0);
  const [fieldglassSiteName, setFieldglassSiteName] = useState(
    client.fieldglassSiteName ?? '',
  );
  const [fieldglassBillRate, setFieldglassBillRate] = useState(
    client.fieldglassBillRate != null ? String(client.fieldglassBillRate) : '',
  );
  const [saving, setSaving] = useState(false);

  // Empty string → null; otherwise the parsed number (NaN if the field is junk).
  const billRateParsed =
    fieldglassBillRate.trim() === '' ? null : Number(fieldglassBillRate);

  // Re-sync local state when the parent reloads the client (e.g. after a
  // sibling section's save flips status from PROSPECT to ACTIVE).
  useEffect(() => {
    setName(client.name);
    setIndustry(client.industry ?? '');
    setStatus(client.status);
    setContactEmail(client.contactEmail ?? '');
    setWeekStartsOn(client.weekStartsOn ?? 0);
    setFieldglassSiteName(client.fieldglassSiteName ?? '');
    setFieldglassBillRate(
      client.fieldglassBillRate != null ? String(client.fieldglassBillRate) : '',
    );
  }, [
    client.name,
    client.industry,
    client.status,
    client.contactEmail,
    client.weekStartsOn,
    client.fieldglassSiteName,
    client.fieldglassBillRate,
  ]);

  const dirty =
    name.trim() !== client.name ||
    (industry.trim() || null) !== (client.industry || null) ||
    status !== client.status ||
    (contactEmail.trim() || null) !== (client.contactEmail || null) ||
    weekStartsOn !== (client.weekStartsOn ?? 0) ||
    (fieldglassSiteName.trim() || null) !== (client.fieldglassSiteName || null) ||
    billRateParsed !== (client.fieldglassBillRate ?? null);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error('Name required.');
      return;
    }
    if (billRateParsed !== null && !(billRateParsed >= 0)) {
      toast.error('Fieldglass bill rate must be a number ≥ 0.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateClient(client.id, {
        name: trimmed,
        industry: industry.trim() || null,
        status,
        contactEmail: contactEmail.trim() || null,
        weekStartsOn,
        fieldglassSiteName: fieldglassSiteName.trim() || null,
        fieldglassBillRate: billRateParsed,
      });
      onSaved(updated);
      toast.success('Client saved.');
    } catch (err) {
      toast.error('Could not save.', {
        description: err instanceof ApiError ? err.message : 'Something went wrong.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-gold" />
          Basics
        </CardTitle>
        <CardDescription>
          Name, industry, account status, and a primary contact email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Industry">
            {(p) => (
              <Input
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                maxLength={80}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select
                disabled={!canManage}
                value={status}
                onChange={(e) => setStatus(e.target.value as ClientStatus)}
                {...p}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Contact email"
            hint="Leave blank if there's no primary point of contact."
          >
            {(p) => (
              <Input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                maxLength={254}
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field
            label="Week starts on"
            hint="This client's scheduling week. Associates get their week-ahead digest the evening before."
          >
            {(p) => (
              <Select
                disabled={!canManage}
                value={String(weekStartsOn)}
                onChange={(e) => setWeekStartsOn(Number(e.target.value))}
                {...p}
              >
                {WEEKDAY_NAMES.map((label, i) => (
                  <option key={label} value={String(i)}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Fieldglass site name"
            hint='Verbatim SAP Fieldglass "Site" label (e.g. "1 - Onsite - FL - Destin"). Shown on the Timesheets export so the Site column matches Fieldglass. Blank falls back to the worksite/client name.'
          >
            {(p) => (
              <Input
                value={fieldglassSiteName}
                onChange={(e) => setFieldglassSiteName(e.target.value)}
                maxLength={255}
                placeholder="1 - Onsite - FL - Destin"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
          <Field
            label="Fieldglass bill rate ($/hr)"
            hint='Client-billed rate on the Fieldglass timesheet accounting block (Amount = rate × hours). Not the associate pay rate. Leave blank if you bill a different way.'
          >
            {(p) => (
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={fieldglassBillRate}
                onChange={(e) => setFieldglassBillRate(e.target.value)}
                placeholder="21.21"
                disabled={!canManage}
                {...p}
              />
            )}
          </Field>
        </div>
        {canManage && (
          <div className="mt-4">
            <Button onClick={submit} disabled={!dirty} loading={saving}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ----------------------------- State editor ------------------------------ */

function StateEditor({
  client,
  canManage,
  onSaved,
}: {
  client: ClientSummary;
  canManage: boolean;
  onSaved: (c: ClientSummary) => void;
}) {
  const [value, setValue] = useState(client.state ?? '');
  const [saving, setSaving] = useState(false);

  // Keep local state in sync if the parent refreshes the client.
  useEffect(() => {
    setValue(client.state ?? '');
  }, [client.state]);

  const dirty = (value || null) !== (client.state || null);

  const submit = async () => {
    setSaving(true);
    try {
      const updated = await setClientState(client.id, {
        state: value ? value.toUpperCase() : null,
      });
      onSaved(updated);
      toast.success('Work-site state saved.');
    } catch (err) {
      toast.error('Could not save.', {
        description: err instanceof Error ? err.message : 'Something went wrong.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-gold" />
          Work-site state
        </CardTitle>
        <CardDescription>
          Drives OT thresholds, meal-break minimums, sick-leave accrual, and
          fair-workweek (predictive-scheduling) enforcement. Leave blank for
          the federal default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3 items-end">
          <Field
            label="State (2-letter code)"
            className="flex-1 min-w-[10rem]"
            hint={`States with policy templates: ${POLICY_STATES.join(', ')}.`}
          >
            {(p) => (
              <Select
                disabled={!canManage}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                {...p}
              >
                <option value="">— Federal default —</option>
                {POLICY_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {canManage && (
            <Button onClick={submit} disabled={!dirty} loading={saving}>
              <Save className="h-4 w-4" />
              Save
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Phase 131 — the per-Client GeofenceEditor was removed. Geofence
// lives on Location now; edit it from the LocationsSection's
// per-row dialog (PATCH /clients/:id/locations/:lid).
