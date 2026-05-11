import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { JobsSection } from './JobsSection';
import { LocationsSection } from './LocationsSection';
import { BenefitsPlansSection } from './BenefitsPlansSection';
import { QuickbooksSection } from './QuickbooksSection';

const STATUSES: ClientStatus[] = ['PROSPECT', 'ACTIVE', 'INACTIVE'];

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

  const [client, setClient] = useState<ClientSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  const onArchive = async () => {
    if (!client) return;
    if (!confirm(`Archive "${client.name}"? They'll be hidden from the clients list. Open applications, payroll, and associates aren't deleted.`)) return;
    setArchiving(true);
    try {
      await archiveClient(client.id);
      toast.success(`"${client.name}" archived.`);
      navigate('/clients');
    } catch (err) {
      toast.error('Could not archive', {
        description: err instanceof ApiError ? err.message : String(err),
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
      <div className="max-w-3xl mx-auto">
        <p className="text-alert">{error}</p>
      </div>
    );
  }
  if (!client) {
    return (
      <div className="max-w-3xl mx-auto space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link to="/clients" className="text-sm text-silver hover:text-gold inline-block">
        ← All clients
      </Link>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl md:text-4xl text-white mb-1">
            {client.name}
          </h1>
          <div className="flex items-center gap-2 text-sm text-silver">
            <Badge>{client.status}</Badge>
            {client.industry && <span>· {client.industry}</span>}
            {client.contactEmail && <span>· {client.contactEmail}</span>}
          </div>
        </div>
        {canManage && (
          <Button variant="ghost" onClick={onArchive} loading={archiving}>
            <Archive className="h-4 w-4" />
            Archive
          </Button>
        )}
      </header>

      <BasicsEditor
        client={client}
        canManage={canManage}
        onSaved={(updated) => setClient(updated)}
      />

      <StateEditor
        client={client}
        canManage={canManage}
        onSaved={(updated) => setClient(updated)}
      />

      <LocationsSection clientId={client.id} />

      <JobsSection clientId={client.id} />

      <BenefitsPlansSection clientId={client.id} />

      <QuickbooksSection clientId={client.id} />
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
  const [saving, setSaving] = useState(false);

  // Re-sync local state when the parent reloads the client (e.g. after a
  // sibling section's save flips status from PROSPECT to ACTIVE).
  useEffect(() => {
    setName(client.name);
    setIndustry(client.industry ?? '');
    setStatus(client.status);
    setContactEmail(client.contactEmail ?? '');
  }, [client.name, client.industry, client.status, client.contactEmail]);

  const dirty =
    name.trim() !== client.name ||
    (industry.trim() || null) !== (client.industry || null) ||
    status !== client.status ||
    (contactEmail.trim() || null) !== (client.contactEmail || null);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error('Name required.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateClient(client.id, {
        name: trimmed,
        industry: industry.trim() || null,
        status,
        contactEmail: contactEmail.trim() || null,
      });
      onSaved(updated);
      toast.success('Client saved.');
    } catch (err) {
      toast.error('Could not save', {
        description: err instanceof ApiError ? err.message : String(err),
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
                    {s}
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
      toast.success('Work-site state saved');
    } catch (err) {
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : String(err),
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
