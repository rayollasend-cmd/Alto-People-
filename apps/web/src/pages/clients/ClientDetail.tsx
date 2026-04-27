import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, Building2, Crosshair, MapPin, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatus, ClientSummary } from '@alto-people/shared';
import {
  archiveClient,
  getClient,
  getClientGeofence,
  setClientGeofence,
  setClientState,
  updateClient,
  type ClientGeofence,
} from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { tryGetGeolocation } from '@/lib/timeApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { JobsSection } from './JobsSection';
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
  const [geofence, setGeofence] = useState<ClientGeofence | null>(null);
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
      const [c, g] = await Promise.all([
        getClient(id),
        getClientGeofence(id).catch(() => ({
          latitude: null,
          longitude: null,
          geofenceRadiusMeters: null,
        })),
      ]);
      setClient(c);
      setGeofence(g);
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
  if (!client || !geofence) {
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

      <GeofenceEditor
        clientId={client.id}
        initial={geofence}
        canManage={canManage}
        onSaved={(updated) => setGeofence(updated)}
      />

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
      toast.error('Name is required.');
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
          <div>
            <Label htmlFor="cl-name" required>
              Name
            </Label>
            <Input
              id="cl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="cl-industry">Industry</Label>
            <Input
              id="cl-industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              maxLength={80}
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="cl-status">Status</Label>
            <select
              id="cl-status"
              disabled={!canManage}
              value={status}
              onChange={(e) => setStatus(e.target.value as ClientStatus)}
              className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="cl-email">Contact email</Label>
            <Input
              id="cl-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={254}
              disabled={!canManage}
            />
            <FormHint>Leave blank if there's no primary point of contact.</FormHint>
          </div>
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
          <div className="flex-1 min-w-[10rem]">
            <Label htmlFor="cl-state">State (2-letter code)</Label>
            <select
              id="cl-state"
              disabled={!canManage}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
            >
              <option value="">— Federal default —</option>
              {POLICY_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <FormHint>
              States with policy templates: {POLICY_STATES.join(', ')}.
            </FormHint>
          </div>
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

/* ----------------------------- Geofence editor --------------------------- */

interface GeofenceEditorProps {
  clientId: string;
  initial: ClientGeofence;
  canManage: boolean;
  onSaved: (g: ClientGeofence) => void;
}

function GeofenceEditor({ clientId, initial, canManage, onSaved }: GeofenceEditorProps) {
  const [lat, setLat] = useState(initial.latitude !== null ? String(initial.latitude) : '');
  const [lng, setLng] = useState(initial.longitude !== null ? String(initial.longitude) : '');
  const [radius, setRadius] = useState(
    initial.geofenceRadiusMeters !== null ? String(initial.geofenceRadiusMeters) : ''
  );
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);

  // Reset the form if the parent reloads the geofence (e.g. after a save).
  useEffect(() => {
    setLat(initial.latitude !== null ? String(initial.latitude) : '');
    setLng(initial.longitude !== null ? String(initial.longitude) : '');
    setRadius(initial.geofenceRadiusMeters !== null ? String(initial.geofenceRadiusMeters) : '');
  }, [initial.latitude, initial.longitude, initial.geofenceRadiusMeters]);

  const enabled = lat || lng || radius;
  const allFilled = lat && lng && radius;

  const useMyLocation = async () => {
    setLocating(true);
    const pos = await tryGetGeolocation(8_000);
    setLocating(false);
    if (!pos) {
      toast.error('Location unavailable', {
        description: 'Browser denied or no GPS signal — type the coordinates manually.',
      });
      return;
    }
    setLat(pos.lat.toFixed(7));
    setLng(pos.lng.toFixed(7));
    if (!radius) setRadius('150'); // sensible default for a single building.
  };

  const submit = async (clear: boolean) => {
    setSaving(true);
    try {
      if (clear) {
        const updated = await setClientGeofence(clientId, {
          latitude: null,
          longitude: null,
          geofenceRadiusMeters: null,
        });
        onSaved(updated);
        toast.success('Geofence cleared — clock-in is no longer geo-restricted');
        return;
      }
      const latN = Number(lat);
      const lngN = Number(lng);
      const radN = Math.round(Number(radius));
      if (!Number.isFinite(latN) || !Number.isFinite(lngN) || !Number.isFinite(radN)) {
        toast.error('Latitude, longitude, and radius must all be numeric');
        return;
      }
      const updated = await setClientGeofence(clientId, {
        latitude: latN,
        longitude: lngN,
        geofenceRadiusMeters: radN,
      });
      onSaved(updated);
      toast.success('Geofence saved');
    } catch (err) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Could not save';
      toast.error('Could not save', { description: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Crosshair className="h-4 w-4 text-gold" />
          Geofence
        </CardTitle>
        <CardDescription>
          When set, the server rejects clock-ins outside the radius. Latitude,
          longitude, and radius must be set or cleared together.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="cl-lat">Latitude</Label>
            <Input
              id="cl-lat"
              type="number"
              step="any"
              inputMode="decimal"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="40.7128"
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="cl-lng">Longitude</Label>
            <Input
              id="cl-lng"
              type="number"
              step="any"
              inputMode="decimal"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="-74.0060"
              disabled={!canManage}
            />
          </div>
          <div>
            <Label htmlFor="cl-rad">Radius (meters)</Label>
            <Input
              id="cl-rad"
              type="number"
              min="10"
              max="50000"
              step="10"
              inputMode="numeric"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              placeholder="150"
              disabled={!canManage}
            />
            <FormHint>10 – 50,000m. ~150m covers a single building.</FormHint>
          </div>
        </div>

        {canManage && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={useMyLocation}
              loading={locating}
            >
              <Crosshair className="h-4 w-4" />
              Use my current location
            </Button>
            <Button onClick={() => submit(false)} loading={saving} disabled={!allFilled}>
              <Save className="h-4 w-4" />
              Save geofence
            </Button>
            {enabled && (
              <Button
                variant="ghost"
                onClick={() => submit(true)}
                loading={saving}
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
