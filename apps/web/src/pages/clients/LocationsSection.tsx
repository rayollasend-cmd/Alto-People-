import { useCallback, useEffect, useState } from 'react';
import { Crosshair, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  type LocationSummary,
  SUPPORTED_TIMEZONES,
  TIMEZONE_LABELS,
} from '@alto-people/shared';
import {
  archiveLocation,
  createLocation,
  listClientLocations,
  updateLocation,
} from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { tryGetGeolocation } from '@/lib/timeApi';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

interface Props {
  clientId: string;
}

/**
 * Phase 131 — physical sites under this client. Each Location holds
 * its own geofence and (eventually) state code for OT/meal-break
 * rules. Associates are placed at a Location via the Transfer button
 * on their profile.
 *
 * Visibility: anyone in /clients can see; mutation requires
 * manage:clients (same gate as the rest of client editing).
 */
export function LocationsSection({ clientId }: Props) {
  const { can } = useAuth();
  const canManage = can('manage:clients');

  const [items, setItems] = useState<LocationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [editing, setEditing] = useState<LocationSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LocationSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listClientLocations(clientId, { includeInactive });
      setItems(res.locations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load locations.');
    }
  }, [clientId, includeInactive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onArchive = async (loc: LocationSummary) => {
    setBusy(true);
    try {
      await archiveLocation(clientId, loc.id);
      toast.success(`Archived ${loc.name}`);
      setConfirmDelete(null);
      refresh();
    } catch (err) {
      toast.error('Could not archive', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-gold" />
              Locations
            </CardTitle>
            <CardDescription>
              Physical sites under this client (e.g. individual stores).
              Each location has its own geofence and is the placement
              target for the Transfer flow on associate profiles.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="text-xs text-silver inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-navy-secondary"
              />
              Show archived
            </label>
            {canManage && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New location
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && <ErrorBanner className="m-4">{error}</ErrorBanner>}
        {!items && (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        )}
        {items && items.length === 0 && (
          <p className="text-sm text-silver p-6 text-center">
            No locations configured for this client.
            {canManage && ' Click "New location" to add the first.'}
          </p>
        )}
        {items && items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>City / state</TableHead>
                <TableHead className="hidden md:table-cell">Time zone</TableHead>
                <TableHead className="hidden lg:table-cell">Geofence</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-white">
                    <div className="min-w-0">
                      <div className="truncate">{l.name}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        {TIMEZONE_LABELS[
                          l.timezone as (typeof SUPPORTED_TIMEZONES)[number]
                        ] ?? l.timezone}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-silver">
                    {[l.city, l.state].filter(Boolean).join(', ') || '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-silver">
                    {TIMEZONE_LABELS[
                      l.timezone as (typeof SUPPORTED_TIMEZONES)[number]
                    ] ?? l.timezone}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver tabular-nums">
                    {l.latitude !== null &&
                    l.longitude !== null &&
                    l.geofenceRadiusMeters !== null
                      ? `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)} · ${l.geofenceRadiusMeters}m`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {l.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="outline">Archived</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(l)}
                          aria-label="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {l.isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDelete(l)}
                            aria-label="Archive"
                          >
                            <Trash2 className="h-4 w-4 text-alert" />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <LocationDialog
        open={creating || editing !== null}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        clientId={clientId}
        existing={editing}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          refresh();
        }}
      />

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(v) => !v && setConfirmDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this location?</DialogTitle>
            <DialogDescription>
              {confirmDelete && (
                <>
                  Archiving{' '}
                  <strong className="text-white">{confirmDelete.name}</strong>{' '}
                  hides it from the transfer picker and kiosk setup, but
                  preserves history on existing shifts, time entries and
                  assignments.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => confirmDelete && onArchive(confirmDelete)}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clientId: string;
  existing: LocationSummary | null;
  onSaved: () => void;
}

function LocationDialog({ open, onOpenChange, clientId, existing, onSaved }: DialogProps) {
  const [name, setName] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radius, setRadius] = useState('');
  const [timezone, setTimezone] = useState<string>('America/New_York');
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setAddressLine1(existing?.addressLine1 ?? '');
    setAddressLine2(existing?.addressLine2 ?? '');
    setCity(existing?.city ?? '');
    setState(existing?.state ?? '');
    setZip(existing?.zip ?? '');
    setLatitude(existing?.latitude?.toString() ?? '');
    setLongitude(existing?.longitude?.toString() ?? '');
    setRadius(existing?.geofenceRadiusMeters?.toString() ?? '');
    setTimezone(existing?.timezone ?? 'America/New_York');
    setIsActive(existing?.isActive ?? true);
  }, [open, existing]);

  const useMyLocation = async () => {
    const coords = await tryGetGeolocation();
    if (!coords) {
      toast.error('Could not read browser location.');
      return;
    }
    setLatitude(coords.lat.toFixed(7));
    setLongitude(coords.lng.toFixed(7));
    if (!radius.trim()) setRadius('150');
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error('Name required.');
      return;
    }
    const latN = latitude.trim() ? Number(latitude) : null;
    const lngN = longitude.trim() ? Number(longitude) : null;
    const radN = radius.trim() ? Number(radius) : null;
    const anyGeo = latN !== null || lngN !== null || radN !== null;
    const allGeo = latN !== null && lngN !== null && radN !== null;
    if (anyGeo && !allGeo) {
      toast.error('Geofence needs latitude, longitude AND radius — or none of them.');
      return;
    }
    const stateUpper = state.trim().toUpperCase();
    if (stateUpper && !/^[A-Z]{2}$/.test(stateUpper)) {
      toast.error('State must be a two-letter code.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: trimmed,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: stateUpper || null,
        zip: zip.trim() || null,
        latitude: allGeo ? latN : null,
        longitude: allGeo ? lngN : null,
        geofenceRadiusMeters: allGeo ? radN : null,
        timezone: timezone as (typeof SUPPORTED_TIMEZONES)[number],
      };
      if (existing) {
        await updateLocation(clientId, existing.id, { ...payload, isActive });
        toast.success(`Updated ${trimmed}`);
      } else {
        await createLocation(clientId, payload);
        toast.success(`Created ${trimmed}`);
      }
      onSaved();
    } catch (err) {
      toast.error('Could not save', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit location' : 'New location'}</DialogTitle>
          <DialogDescription>
            Geofence is optional. When set, kiosk punches and time-tracking
            clock-ins outside the radius are flagged for review — they
            still go through.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder="Destin"
                {...p}
              />
            )}
          </Field>

          <Field label="Address line 1">
            {(p) => (
              <Input
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                {...p}
              />
            )}
          </Field>
          <Field label="Address line 2">
            {(p) => (
              <Input
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                {...p}
              />
            )}
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="City">
              {(p) => (
                <Input value={city} onChange={(e) => setCity(e.target.value)} {...p} />
              )}
            </Field>
            <Field label="State">
              {(p) => (
                <Input
                  value={state}
                  maxLength={2}
                  onChange={(e) => setState(e.target.value)}
                  placeholder="FL"
                  {...p}
                />
              )}
            </Field>
            <Field label="ZIP">
              {(p) => (
                <Input value={zip} onChange={(e) => setZip(e.target.value)} {...p} />
              )}
            </Field>
          </div>

          <Field
            label="Time zone"
            required
            hint="Shifts at this site are scheduled and shown in this zone. Florida's western Panhandle (Panama City Beach, Destin, Santa Rosa Beach) is Central — not Eastern."
          >
            {(p) => (
              <Select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                {...p}
              >
                {SUPPORTED_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {TIMEZONE_LABELS[tz]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Latitude">
              {(p) => (
                <Input
                  type="number"
                  step="0.0000001"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Longitude">
              {(p) => (
                <Input
                  type="number"
                  step="0.0000001"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Radius (m)">
              {(p) => (
                <Input
                  type="number"
                  min="1"
                  max="50000"
                  value={radius}
                  onChange={(e) => setRadius(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={useMyLocation}
          >
            <Crosshair className="h-4 w-4" />
            Use my current location
          </Button>

          {existing && (
            <label className="inline-flex items-center gap-2 text-sm text-silver cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="rounded border-navy-secondary"
              />
              Active
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
