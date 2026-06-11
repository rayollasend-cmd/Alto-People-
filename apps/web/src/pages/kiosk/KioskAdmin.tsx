import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Key,
  Mail,
  Plus,
  RotateCw,
  ScanFace,
  ScrollText,
  Search,
  Stethoscope,
  Tablet,
  X,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  assignKioskPin,
  createKioskDevice,
  deleteKioskDevice,
  deleteKioskPin,
  diagnoseKioskPin,
  emailKioskPin,
  emailKioskPinsBulk,
  kioskPinsHealth,
  listKioskDevices,
  listKioskFaceReferences,
  listKioskPins,
  listKioskPunches,
  resetKioskFaceReference,
  reviewKioskPunch,
  reviewKioskPunchesBulk,
  revokeKioskDevice,
  rotateKioskDevice,
  type KioskDevice,
  type KioskFaceReferenceSummary,
  type KioskPin,
  type KioskPinDiagnosis,
  type KioskPinHealth,
  type KioskPunchSummary,
} from '@/lib/kiosk99Api';
import { listDirectory } from '@/lib/directoryApi';
import { listClients, listClientLocations } from '@/lib/clientsApi';
import type { LocationSummary } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
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
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from 'sonner';

type Tab = 'devices' | 'pins' | 'review' | 'log' | 'faces';

export function KioskAdmin() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:time') : false;
  const [tab, setTab] = useState<Tab>('devices');

  // Lightweight counts for the tab badges so HR sees pending review work
  // and broken kiosks at a glance without opening each tab. Refetched on
  // tab switch so the numbers stay roughly live after in-tab actions
  // (reviewing a punch, revoking a device, …).
  const [pendingReview, setPendingReview] = useState<number | null>(null);
  const [offlineDevices, setOfflineDevices] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void listKioskPunches({ reviewStatus: 'PENDING' })
      .then((r) => !cancelled && setPendingReview(r.punches.length))
      .catch(() => !cancelled && setPendingReview(null));
    void listKioskDevices()
      .then(
        (r) =>
          !cancelled &&
          setOfflineDevices(r.devices.filter(isDeviceOffline).length),
      )
      .catch(() => !cancelled && setOfflineDevices(null));
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const countLabel = (n: number) => (n > 99 ? '99+' : String(n));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Kiosk admin"
        subtitle="Register tablets, issue 4-digit employee numbers, and review the punch log."
        breadcrumbs={[{ label: 'Time' }, { label: 'Kiosk' }]}
      />
      {canManage && <PinHealthBanner onTab={() => setTab('pins')} />}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="devices">
            <Tablet className="mr-2 h-4 w-4" /> Devices
            {offlineDevices ? (
              <Badge variant="destructive" className="ml-2">
                {countLabel(offlineDevices)}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="pins">
            <Key className="mr-2 h-4 w-4" /> Employee numbers
          </TabsTrigger>
          <TabsTrigger value="review">
            <AlertTriangle className="mr-2 h-4 w-4" /> Review
            {pendingReview ? (
              <Badge variant="pending" className="ml-2">
                {countLabel(pendingReview)}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="log">
            <ScrollText className="mr-2 h-4 w-4" /> Punch log
          </TabsTrigger>
          <TabsTrigger value="faces">
            <ScanFace className="mr-2 h-4 w-4" /> Face refs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="devices"><DevicesTab canManage={canManage} /></TabsContent>
        <TabsContent value="pins"><PinsTab canManage={canManage} /></TabsContent>
        <TabsContent value="review"><ReviewTab canManage={canManage} /></TabsContent>
        <TabsContent value="log"><LogTab /></TabsContent>
        <TabsContent value="faces"><FacesTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

// Early-warning banner: flags codes that won't clock in (PIN secret drifted)
// or can't be displayed (encryption key drifted), before associates hit it at
// the kiosk. Silent when everything's healthy.
function PinHealthBanner({ onTab }: { onTab: () => void }) {
  const [health, setHealth] = useState<KioskPinHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    kioskPinsHealth()
      .then((h) => !cancelled && setHealth(h))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!health) return null;
  const { wontClockIn, unreadable, legacy, healthy, total } = health;
  if (wontClockIn === 0 && unreadable === 0 && legacy === 0) return null;

  // Legacy-only is informational (those codes still clock in fine —
  // they just can't be shown), so don't paint the page red for it.
  const severe = wontClockIn > 0 || unreadable > 0;

  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        severe ? 'border-alert/50 bg-alert/10' : 'border-warning/50 bg-warning/10'
      }`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className={`mt-0.5 h-4 w-4 shrink-0 ${severe ? 'text-alert' : 'text-warning'}`}
        />
        <div className="min-w-0">
          <div className={`font-medium ${severe ? 'text-alert' : 'text-warning'}`}>
            Kiosk codes need attention
          </div>
          <ul className="mt-1 space-y-0.5 text-silver">
            {wontClockIn > 0 && (
              <li>
                <span className="font-medium text-alert">{wontClockIn}</span> code
                {wontClockIn === 1 ? '' : 's'} won&rsquo;t clock in — the PIN secret
                (<span className="font-mono text-xs">KIOSK_PIN_SECRET</span>) changed.
              </li>
            )}
            {unreadable > 0 && (
              <li>
                <span className="font-medium text-warning">{unreadable}</span> code
                {unreadable === 1 ? '' : 's'} can&rsquo;t be displayed and likely
                won&rsquo;t clock in — the encryption key
                (<span className="font-mono text-xs">PAYOUT_ENCRYPTION_KEY</span>) changed.
              </li>
            )}
            {legacy > 0 && (
              <li>
                <span className="font-medium text-warning">{legacy}</span> code
                {legacy === 1 ? '' : 's'} show{legacy === 1 ? 's' : ''} a dash —
                issued before number display existed, so only a one-way hash is
                stored. They still clock in fine; rotate them to make the
                numbers visible (rotation issues NEW numbers — tell the
                associates).
              </li>
            )}
          </ul>
          <div className="mt-1.5 text-xs text-silver">
            Lock those secrets in your host so they can&rsquo;t drift again, then{' '}
            <button
              type="button"
              onClick={onTab}
              className="font-medium text-white underline underline-offset-2 hover:text-gold"
            >
              Employee numbers → Rotate all
            </button>{' '}
            to re-issue the affected codes. {healthy} of {total} are healthy.
          </div>
        </div>
      </div>
    </div>
  );
}

function renderTokenStatus(iso: string | null) {
  if (!iso) return <span className="text-silver text-xs">—</span>;
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  if (ms <= 0) return <Badge variant="destructive">Expired</Badge>;
  if (days <= 14) return <Badge variant="pending">in {days}d</Badge>;
  return <Badge variant="success">in {days}d</Badge>;
}

// A device that was last seen more than this many hours ago is treated
// as "offline" — battery dead, unplugged, network down, or stolen. HR
// should be poked when this happens; payroll for that site is silently
// broken until someone fixes the kiosk.
const OFFLINE_THRESHOLD_HOURS = 24;

function isDeviceOffline(d: KioskDevice): boolean {
  if (!d.isActive) return false;
  if (!d.lastSeenAt) return true;
  const ageMs = Date.now() - new Date(d.lastSeenAt).getTime();
  return ageMs > OFFLINE_THRESHOLD_HOURS * 60 * 60 * 1000;
}

function DevicesTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<KioskDevice[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showToken, setShowToken] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    listKioskDevices()
      .then((r) => setRows(r.devices))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const offline = rows ? rows.filter(isDeviceOffline) : [];
  // Active devices whose token dies within 14 days — the kiosk stops
  // accepting punches the moment it lapses, so name them here (the
  // hourly server job also emails admins at the 14- and 3-day marks).
  const expiringSoon = rows
    ? rows.filter((d) => {
        if (!d.isActive || !d.tokenExpiresAt) return false;
        const msLeft = new Date(d.tokenExpiresAt).getTime() - Date.now();
        return msLeft > 0 && msLeft <= 14 * 24 * 60 * 60 * 1000;
      })
    : [];
  // "Front Door (Walmart FB), Break Room (Acme)" — enough to act on
  // without scanning the table; truncate past three.
  const nameList = (ds: KioskDevice[]) => {
    const names = ds.map((d) => d.name);
    return names.length <= 3
      ? names.join(', ')
      : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
  };

  return (
    <div className="space-y-4">
      {rows && rows.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-[180px] bg-navy-secondary/40 border border-navy-secondary rounded-lg px-4 py-3">
            <div className="text-xs uppercase tracking-widest text-silver">Kiosks</div>
            <div className="text-2xl font-medium text-white">
              {rows.filter((d) => d.isActive).length}
            </div>
            <div className="text-xs text-silver">{rows.length} total</div>
          </div>
          <div
            className={`flex-1 min-w-[180px] rounded-lg px-4 py-3 border ${
              offline.length > 0
                ? 'bg-warning/10 border-warning/40'
                : 'bg-navy-secondary/40 border-navy-secondary'
            }`}
          >
            <div className="text-xs uppercase tracking-widest text-silver">
              Offline &gt; {OFFLINE_THRESHOLD_HOURS}h
            </div>
            <div
              className={`text-2xl font-medium ${
                offline.length > 0 ? 'text-warning' : 'text-white'
              }`}
            >
              {offline.length}
            </div>
            <div className="text-xs text-silver">
              {offline.length === 0
                ? 'All active kiosks reported in.'
                : nameList(offline)}
            </div>
          </div>
          <div
            className={`flex-1 min-w-[180px] rounded-lg px-4 py-3 border ${
              expiringSoon.length > 0
                ? 'bg-warning/10 border-warning/40'
                : 'bg-navy-secondary/40 border-navy-secondary'
            }`}
          >
            <div className="text-xs uppercase tracking-widest text-silver">
              Token expiring ≤ 14d
            </div>
            <div
              className={`text-2xl font-medium ${
                expiringSoon.length > 0 ? 'text-warning' : 'text-white'
              }`}
            >
              {expiringSoon.length}
            </div>
            <div className="text-xs text-silver">
              {expiringSoon.length === 0
                ? 'No tokens lapsing soon.'
                : `Rotate: ${nameList(expiringSoon)}`}
            </div>
          </div>
        </div>
      )}
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Register kiosk
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Tablet}
              title="No kiosks"
              description="Register a tablet to enable PIN-based clock in/out."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Punches</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id} className="group">
                    <TableCell className="font-medium text-white">{d.name}</TableCell>
                    <TableCell>{d.clientName}</TableCell>
                    <TableCell className="text-silver">
                      {d.locationName ?? '—'}
                    </TableCell>
                    <TableCell>
                      {d.isActive ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="destructive">Revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.lastSeenAt ? (
                        <span
                          className={
                            isDeviceOffline(d) ? 'text-warning' : undefined
                          }
                        >
                          {new Date(d.lastSeenAt).toLocaleString()}
                          {isDeviceOffline(d) && (
                            <Badge variant="pending" className="ml-2">
                              Offline
                            </Badge>
                          )}
                        </span>
                      ) : isDeviceOffline(d) ? (
                        <Badge variant="pending">Never seen</Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{renderTokenStatus(d.tokenExpiresAt)}</TableCell>
                    <TableCell>{d.punchCount}</TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && d.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            if (!(await confirm({
                              title: 'Rotate device token?',
                              description: 'The tablet will stop accepting punches until you paste the new token into it. The new token is shown ONCE.',
                              destructive: true,
                            }))) return;
                            try {
                              const r = await rotateKioskDevice(d.id);
                              setShowToken(r.deviceToken);
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
                        >
                          Rotate
                        </Button>
                      )}
                      {canManage && d.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            if (!(await confirm({ title: 'Revoke this kiosk?', description: 'It will stop accepting punches.', destructive: true })))
                              return;
                            await revokeKioskDevice(d.id);
                            refresh();
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!(await confirm({ title: 'Permanently delete?', destructive: true }))) return;
                            try {
                              await deleteKioskDevice(d.id);
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
                          className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
                        >
                          Delete
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewDeviceDrawer
          onClose={() => setShowNew(false)}
          onSaved={(token) => {
            setShowNew(false);
            setShowToken(token);
            refresh();
          }}
        />
      )}
      {showToken && <TokenRevealDrawer token={showToken} onClose={() => setShowToken(null)} />}
    </div>
  );
}

function NewDeviceDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (token: string) => void;
}) {
  const [clients, setClients] = useState<
    Array<{ id: string; name: string }> | null
  >(null);
  const [clientId, setClientId] = useState('');
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listClients()
      .then((r) => {
        if (cancelled) return;
        const list = r.clients.map((c) => ({ id: c.id, name: c.name }));
        setClients(list);
        if (list.length > 0) setClientId(list[0]!.id);
      })
      .catch(() => {
        if (!cancelled) setClients([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase 131 — load Locations when the client changes. Auto-pick the
  // first one so HR can hit Register without an extra click in the
  // common single-site case. Resets when client switches.
  useEffect(() => {
    setLocationId('');
    if (!clientId) {
      setLocations(null);
      return;
    }
    let cancelled = false;
    setLocations(null);
    listClientLocations(clientId)
      .then((r) => {
        if (cancelled) return;
        setLocations(r.locations);
        if (r.locations.length > 0) setLocationId(r.locations[0]!.id);
      })
      .catch(() => {
        if (!cancelled) setLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const onSubmit = async () => {
    if (!clientId || !name.trim()) {
      toast.error('Client and name required.');
      return;
    }
    if (!locationId) {
      toast.error('Pick a location — that drives the kiosk geofence.');
      return;
    }
    setSaving(true);
    try {
      const r = await createKioskDevice({ locationId, name: name.trim() });
      onSaved(r.deviceToken);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Register kiosk</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Client</Label>
          {clients === null ? (
            <Skeleton className="mt-1 h-10 w-full" />
          ) : clients.length === 0 ? (
            <div className="mt-1 text-xs text-silver">
              No clients yet — create one in Clients first.
            </div>
          ) : (
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <Label>Location</Label>
          {locations === null ? (
            <Skeleton className="mt-1 h-10 w-full" />
          ) : locations.length === 0 ? (
            <div className="mt-1 text-xs text-silver">
              No locations under this client — add one from the client
              detail page first.
            </div>
          ) : (
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.state ? ` · ${l.state}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <Label>Kiosk name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Front desk iPad"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving || !clientId || !locationId}>
          {saving ? 'Generating…' : 'Register'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function TokenRevealDrawer({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Pair the kiosk</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-warning">
          Open <code className="font-mono">/kiosk</code> on the tablet, then
          paste this device token into the setup screen. It is shown ONCE.
        </div>
        <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 font-mono text-xs break-all text-white">
          {token}
        </div>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(token);
            toast.success('Copied.');
          }}
        >
          <Copy className="mr-2 h-4 w-4" /> Copy
        </Button>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>I've paired it</Button>
      </DrawerFooter>
    </Drawer>
  );
}

// Sentinel for the client picker's cross-client view. Distinct from '' so
// the existing "no selection" guards (!clientId) keep working.
const ALL_CLIENTS = '__all__';

// Employee numbers are sensitive — a shared admin screen or a screen-share
// shouldn't leak every code at a glance — but admins on this manage:time
// page do need to read them, so we show the code by default and offer a
// per-row eye to HIDE one (e.g. while screen-sharing), plus a one-tap copy.
function EmployeeNumberCell({ value }: { value: string | null }) {
  const [revealed, setRevealed] = useState(true);
  const [copied, setCopied] = useState(false);
  if (!value) {
    return (
      <span
        className="text-silver/70"
        title="Issued before codes were stored — rotate to recover the number."
      >
        —
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono tracking-widest text-white tabular-nums">
        {revealed ? value : '••••'}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        className="text-silver hover:text-white transition opacity-60 group-hover:opacity-100"
        aria-label={revealed ? 'Hide employee number' : 'Show employee number'}
        title={revealed ? 'Hide' : 'Show'}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
        className="text-silver hover:text-white transition opacity-60 group-hover:opacity-100"
        aria-label="Copy employee number"
        title="Copy"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function PinsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [clients, setClients] = useState<
    Array<{ id: string; name: string }> | null
  >(null);
  const [clientId, setClientId] = useState('');
  const [rows, setRows] = useState<KioskPin[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showDiagnose, setShowDiagnose] = useState(false);
  const [showPin, setShowPin] = useState<{
    associateName: string;
    employeeNumber: string;
  } | null>(null);
  // Search box (with-codes view) + "With codes / Missing" roster toggle.
  const [q, setQ] = useState('');
  const [view, setView] = useState<'with' | 'missing'>('with');
  // PIN-eligible associates (ACTIVE = approved application) at the selected
  // client, used to compute who is MISSING a code. Per-client only — the
  // directory is cursor-paginated, so we don't diff across all clients.
  const [eligible, setEligible] = useState<
    Array<{
      id: string;
      name: string;
      email: string;
      currentLocationId: string | null;
    }> | null
  >(null);
  // Worksite filter — for a client with multiple stores/locations, narrow the
  // list to one location.
  const [locationOptions, setLocationOptions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [locationFilter, setLocationFilter] = useState('');
  // When issuing from a "missing" row, preselect that associate in the drawer.
  const [issueFor, setIssueFor] = useState<string | null>(null);

  // Load the client picker once. Default to the first client so HR
  // doesn't land on an empty state.
  useEffect(() => {
    let cancelled = false;
    listClients()
      .then((r) => {
        if (cancelled) return;
        const list = r.clients.map((c) => ({ id: c.id, name: c.name }));
        setClients(list);
        if (!clientId && list.length > 0) setClientId(list[0]!.id);
      })
      .catch(() => {
        if (!cancelled) setClients([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    if (!clientId) {
      setRows([]);
      return;
    }
    setRows(null);
    listKioskPins(clientId === ALL_CLIENTS ? undefined : clientId)
      .then((r) => setRows(r.pins))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Fetch PIN-eligible associates whenever a specific client is selected,
  // so we can show both the "X missing" summary and the Missing view.
  useEffect(() => {
    if (!clientId || clientId === ALL_CLIENTS) {
      setEligible(null);
      return;
    }
    setEligible(null);
    let cancelled = false;
    listDirectory({ clientId, status: 'ACTIVE' })
      .then((r) => {
        if (cancelled) return;
        setEligible(
          r.associates.map((a) => ({
            id: a.id,
            name: `${a.firstName} ${a.lastName}`,
            email: a.email,
            currentLocationId: a.currentLocationId,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setEligible([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // Locations for the selected client, for the worksite filter. Reset the
  // filter whenever the client changes.
  useEffect(() => {
    setLocationFilter('');
    setLocationOptions([]);
    if (!clientId || clientId === ALL_CLIENTS) return;
    let cancelled = false;
    listClientLocations(clientId)
      .then((r) => {
        if (!cancelled) {
          setLocationOptions(r.locations.map((l) => ({ id: l.id, name: l.name })));
        }
      })
      .catch(() => {
        if (!cancelled) setLocationOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  // All clients has no Missing view (no single roster to diff against), so
  // it always falls back to the with-codes list.
  const effectiveView = clientId === ALL_CLIENTS ? 'with' : view;

  const pinnedIds = useMemo(
    () => new Set((rows ?? []).map((p) => p.associateId)),
    [rows],
  );
  const missing = useMemo(
    () =>
      (eligible ?? []).filter(
        (a) =>
          !pinnedIds.has(a.id) &&
          (!locationFilter || a.currentLocationId === locationFilter),
      ),
    [eligible, pinnedIds, locationFilter],
  );
  const filteredRows = useMemo(() => {
    let list = rows ?? [];
    if (locationFilter) list = list.filter((p) => p.locationId === locationFilter);
    const term = q.trim().toLowerCase();
    if (!term) return list;
    return list.filter(
      (p) =>
        p.associateName.toLowerCase().includes(term) ||
        p.associateEmail.toLowerCase().includes(term) ||
        (p.employeeNumber ?? '').includes(term) ||
        p.clientName.toLowerCase().includes(term),
    );
  }, [rows, q, locationFilter]);
  // Rows we can actually email — a recoverable (non-legacy) number. Drives
  // the "Email all" bulk action over whatever's currently in view.
  const emailableRows = useMemo(
    () => filteredRows.filter((p) => p.employeeNumber),
    [filteredRows],
  );
  // Rows whose number can't be displayed (legacy / un-decryptable). The
  // only fix is to re-issue; drives the "Rotate all" bulk action.
  const unreadableRows = useMemo(
    () => filteredRows.filter((p) => !p.employeeNumber),
    [filteredRows],
  );
  const [rotatingAll, setRotatingAll] = useState(false);
  const [assigningAll, setAssigningAll] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-md">
          <Label>Client</Label>
          {clients === null ? (
            <Skeleton className="mt-1 h-10 w-full" />
          ) : clients.length === 0 ? (
            <div className="mt-1 text-xs text-silver">
              No clients yet — create one in Clients first.
            </div>
          ) : (
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value={ALL_CLIENTS}>All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {clientId && clientId !== ALL_CLIENTS && locationOptions.length > 0 && (
          <div className="max-w-xs flex-1">
            <Label>Location</Label>
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
            >
              <option value="">All locations</option>
              {locationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {canManage && (
          <Button variant="ghost" onClick={() => setShowDiagnose(true)}>
            <Stethoscope className="mr-2 h-4 w-4" /> Diagnose PIN
          </Button>
        )}
        {canManage && clientId && clientId !== ALL_CLIENTS && (
          <Button onClick={() => { setIssueFor(null); setShowNew(true); }}>
            <Plus className="mr-2 h-4 w-4" /> Issue employee number
          </Button>
        )}
        {canManage && effectiveView === 'with' && emailableRows.length > 0 && (
          <Button
            variant="ghost"
            onClick={async () => {
              if (
                !(await confirm({
                  title: `Email clock-in numbers to ${emailableRows.length} associate${emailableRows.length === 1 ? '' : 's'}?`,
                  description:
                    'Each associate receives their own 4-digit number at the email on file.',
                }))
              )
                return;
              try {
                const r = await emailKioskPinsBulk(emailableRows.map((p) => p.id));
                toast.success(
                  `Queued ${r.queued} email${r.queued === 1 ? '' : 's'}${
                    r.skipped ? ` · ${r.skipped} skipped` : ''
                  }.`,
                );
              } catch (err) {
                toast.error(
                  err instanceof ApiError ? err.message : 'Failed to email.',
                );
              }
            }}
          >
            <Mail className="mr-2 h-4 w-4" /> Email all ({emailableRows.length})
          </Button>
        )}
        {canManage && effectiveView === 'with' && unreadableRows.length > 0 && (
          <Button
            variant="ghost"
            disabled={rotatingAll}
            onClick={async () => {
              const n = unreadableRows.length;
              if (
                !(await confirm({
                  title: `Re-issue ${n} unreadable number${n === 1 ? '' : 's'}?`,
                  description:
                    `These codes can't be displayed (encrypted under a key prod no longer has), so they can only be fixed by re-issuing. ` +
                    `Each associate gets a NEW number and their current one stops working immediately. ` +
                    `The new numbers will appear in this list — share them with each associate (email delivery isn't guaranteed yet).`,
                  destructive: true,
                }))
              )
                return;
              setRotatingAll(true);
              let ok = 0;
              let fail = 0;
              for (const p of unreadableRows) {
                try {
                  await assignKioskPin({
                    clientId: p.clientId,
                    associateId: p.associateId,
                  });
                  ok++;
                } catch {
                  fail++;
                }
              }
              setRotatingAll(false);
              toast.success(
                `Re-issued ${ok} number${ok === 1 ? '' : 's'} — now visible in the list.${
                  fail ? ` ${fail} failed (check onboarding status).` : ''
                }`,
              );
              refresh();
            }}
          >
            <RotateCw className="mr-2 h-4 w-4" />
            {rotatingAll ? 'Re-issuing…' : `Rotate all — (${unreadableRows.length})`}
          </Button>
        )}
        {canManage && effectiveView === 'missing' && missing.length > 0 && (
          <Button
            disabled={assigningAll}
            onClick={async () => {
              const n = missing.length;
              const loc = locationFilter
                ? locationOptions.find((l) => l.id === locationFilter)?.name
                : null;
              if (
                !(await confirm({
                  title: `Issue numbers to ${n} associate${n === 1 ? '' : 's'}?`,
                  description:
                    `Generates a fresh 4-digit clock-in number for every eligible associate ` +
                    `${loc ? `at ${loc} ` : ''}who doesn't have one yet. ` +
                    `The new numbers appear in the "With codes" list — share them with each associate.`,
                }))
              )
                return;
              setAssigningAll(true);
              let ok = 0;
              let fail = 0;
              for (const a of missing) {
                try {
                  await assignKioskPin({ clientId, associateId: a.id });
                  ok++;
                } catch {
                  fail++;
                }
              }
              setAssigningAll(false);
              toast.success(
                `Issued ${ok} number${ok === 1 ? '' : 's'} — now in the With codes list.${
                  fail ? ` ${fail} failed (check onboarding status).` : ''
                }`,
              );
              setView('with');
              refresh();
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            {assigningAll ? 'Issuing…' : `Assign all (${missing.length})`}
          </Button>
        )}
      </div>

      {clientId && (
        <div className="flex flex-wrap items-center gap-3">
          {clientId !== ALL_CLIENTS && (
            <div className="inline-flex overflow-hidden rounded-md border border-navy-secondary text-sm">
              <button
                type="button"
                onClick={() => setView('with')}
                className={`px-3 py-1.5 transition-colors ${
                  effectiveView === 'with'
                    ? 'bg-gold/15 text-white'
                    : 'bg-navy-secondary/40 text-silver hover:text-white'
                }`}
              >
                With codes{rows ? ` (${rows.length})` : ''}
              </button>
              <button
                type="button"
                onClick={() => setView('missing')}
                className={`border-l border-navy-secondary px-3 py-1.5 transition-colors ${
                  effectiveView === 'missing'
                    ? 'bg-gold/15 text-white'
                    : 'bg-navy-secondary/40 text-silver hover:text-white'
                }`}
              >
                Missing{eligible ? ` (${missing.length})` : ''}
              </button>
            </div>
          )}
          {effectiveView === 'with' && (
            <div className="relative min-w-[200px] max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, or number"
                className="pl-9"
              />
            </div>
          )}
          <div className="ml-auto text-xs text-silver">
            {effectiveView === 'missing'
              ? `${missing.length} eligible associate${missing.length === 1 ? '' : 's'} without a code`
              : rows
                ? `Showing ${filteredRows.length} of ${rows.length}${
                    clientId !== ALL_CLIENTS && eligible && missing.length > 0
                      ? ` · ${missing.length} missing a code`
                      : ''
                  }`
                : ''}
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {!clientId ? (
            <div className="p-6 text-sm text-silver">
              Pick a client to manage employee numbers.
            </div>
          ) : effectiveView === 'missing' ? (
            eligible === null ? (
              <div className="p-6"><SkeletonRows count={3} /></div>
            ) : missing.length === 0 ? (
              <EmptyState
                icon={Check}
                title="Everyone's covered"
                description="Every PIN-eligible associate at this client already has an employee number."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {missing.map((a) => (
                    <TableRow key={a.id} className="group">
                      <TableCell className="font-medium text-white">
                        {a.name}
                      </TableCell>
                      <TableCell className="text-silver">{a.email}</TableCell>
                      <TableCell className="text-right">
                        {canManage && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setIssueFor(a.id);
                              setShowNew(true);
                            }}
                          >
                            <Plus className="mr-1 h-3.5 w-3.5" /> Issue number
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No employee numbers"
              description="Issue a 4-digit number to each associate after they finish onboarding so they can clock in via the kiosk."
            />
          ) : filteredRows.length === 0 ? (
            <div className="p-6 text-sm text-silver">
              No associates match “{q}”.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  {clientId === ALL_CLIENTS && <TableHead>Client</TableHead>}
                  <TableHead>Location</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Employee #</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((p) => (
                  <TableRow key={p.id} className="group">
                    <TableCell className="font-medium text-white">
                      {p.associateName}
                    </TableCell>
                    {clientId === ALL_CLIENTS && (
                      <TableCell className="text-silver">{p.clientName}</TableCell>
                    )}
                    <TableCell className="text-silver">
                      {p.locationName ?? '—'}
                    </TableCell>
                    <TableCell className="text-silver">{p.associateEmail}</TableCell>
                    <TableCell>
                      <EmployeeNumberCell value={p.employeeNumber} />
                    </TableCell>
                    <TableCell>{new Date(p.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        {canManage && p.employeeNumber && (
                          <button
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: `Email ${p.associateName} their clock-in number?`,
                                  description: `It will be sent to ${p.associateEmail}.`,
                                }))
                              )
                                return;
                              try {
                                await emailKioskPin(p.id);
                                toast.success(`Emailed ${p.associateEmail}.`);
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError ? err.message : 'Failed to email.',
                                );
                              }
                            }}
                            className="inline-flex items-center gap-1 text-xs text-silver opacity-60 transition hover:text-white group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <Mail className="h-3.5 w-3.5" /> Email
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: `Rotate ${p.associateName}'s clock-in number?`,
                                  description: p.associateEmail
                                    ? `Issues a NEW 4-digit number — their current one stops working immediately — and emails it to ${p.associateEmail}. Use this for a code showing “—” (unreadable) or a forgotten number.`
                                    : `Issues a NEW 4-digit number — their current one stops working immediately. No email on file, so share the number shown after.`,
                                  destructive: true,
                                }))
                              )
                                return;
                              try {
                                const r = await assignKioskPin({
                                  clientId: p.clientId,
                                  associateId: p.associateId,
                                });
                                // Show the fresh number so HR has it even if
                                // the email can't be delivered.
                                setShowPin({
                                  associateName: p.associateName,
                                  employeeNumber: r.employeeNumber,
                                });
                                if (p.associateEmail) {
                                  void emailKioskPin(r.id)
                                    .then(() =>
                                      toast.success(`Emailed ${p.associateEmail}.`),
                                    )
                                    .catch(() =>
                                      toast.error('Rotated, but the email didn’t send.'),
                                    );
                                }
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError ? err.message : 'Rotate failed.',
                                );
                              }
                            }}
                            className="inline-flex items-center gap-1 text-xs text-silver opacity-60 transition hover:text-white group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <RotateCw className="h-3.5 w-3.5" /> Rotate
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={async () => {
                              if (!(await confirm({ title: 'Revoke this employee number?', destructive: true }))) return;
                              try {
                                await deleteKioskPin(p.id);
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : 'Failed.');
                              }
                            }}
                            className="text-xs text-silver opacity-60 transition hover:text-alert group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewPinDrawer
          clientId={clientId}
          initialAssociateId={issueFor ?? undefined}
          onClose={() => {
            setShowNew(false);
            setIssueFor(null);
          }}
          onSaved={(associateName, employeeNumber) => {
            setShowNew(false);
            setIssueFor(null);
            setShowPin({ associateName, employeeNumber });
            refresh();
          }}
        />
      )}
      {showPin && (
        <Drawer open={true} onOpenChange={(o) => !o && setShowPin(null)}>
          <DrawerHeader>
            <DrawerTitle>Employee number issued</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className="space-y-4 text-center">
            <div className="text-sm text-silver">
              {showPin.associateName} can now use this number to clock in.
              They can also see it any time on their My profile page.
            </div>
            <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-6 text-6xl font-mono tracking-[0.5em] text-white">
              {showPin.employeeNumber}
            </div>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(showPin.employeeNumber);
                toast.success('Copied.');
              }}
            >
              <Copy className="mr-2 h-4 w-4" /> Copy
            </Button>
          </DrawerBody>
          <DrawerFooter>
            <Button onClick={() => setShowPin(null)}>Done</Button>
          </DrawerFooter>
        </Drawer>
      )}
      {showDiagnose && (
        <DiagnoseDrawer onClose={() => setShowDiagnose(false)} />
      )}
    </div>
  );
}

function DiagnoseDrawer({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'number' | 'name'>('number');
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KioskPinDiagnosis | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submitDisabled =
    loading ||
    (mode === 'number' ? number.length !== 4 : name.trim().length < 2);

  const onSubmit = async () => {
    if (mode === 'number' && !/^\d{4}$/.test(number)) {
      setErr('Enter a 4-digit employee number.');
      return;
    }
    if (mode === 'name' && name.trim().length < 2) {
      setErr('Enter at least 2 characters of the name or email.');
      return;
    }
    setErr(null);
    setResult(null);
    setLoading(true);
    try {
      const r = await diagnoseKioskPin(
        mode === 'number'
          ? { employeeNumber: number }
          : { associate: name.trim() },
      );
      setResult(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Diagnosis failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Diagnose a kiosk PIN</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <p className="text-sm text-silver">
          When an associate reports "Wrong PIN" at the kiosk, look them
          up here. Search by their 4-digit number, or by name / email
          if the number isn't known.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setMode('number');
              setErr(null);
              setResult(null);
            }}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm border transition-colors ${
              mode === 'number'
                ? 'bg-gold/15 border-gold/60 text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
            }`}
          >
            By employee number
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('name');
              setErr(null);
              setResult(null);
            }}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm border transition-colors ${
              mode === 'name'
                ? 'bg-gold/15 border-gold/60 text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
            }`}
          >
            By associate name
          </button>
        </div>
        {mode === 'number' ? (
          <div>
            <Label>Employee number</Label>
            <Input
              className="mt-1 font-mono text-2xl tracking-widest text-center"
              value={number}
              onChange={(e) => {
                setNumber(e.target.value.replace(/\D/g, '').slice(0, 4));
                setErr(null);
              }}
              placeholder="1234"
              inputMode="numeric"
              maxLength={4}
            />
          </div>
        ) : (
          <div>
            <Label>Name or email</Label>
            <Input
              className="mt-1"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErr(null);
              }}
              placeholder="Kaal  /  kaal@example.com"
            />
            <div className="text-xs text-silver mt-1">
              Case-insensitive substring match on first / last / email.
            </div>
          </div>
        )}
        {err && <div className="text-sm text-alert">{err}</div>}
        {result && (
          <div className="space-y-3 text-sm">
            <div
              className={`rounded-md border p-3 ${
                result.matchedPin === null
                  ? 'border-alert/40 bg-alert/10 text-alert'
                  : result.clientsMatch
                    ? 'border-success/40 bg-success/10 text-white'
                    : 'border-warning/40 bg-warning/10 text-warning'
              }`}
            >
              <div className="font-medium mb-1">Diagnosis</div>
              <div>{result.diagnosis}</div>
            </div>
            {result.candidates && result.candidates.length > 0 && !result.matchedPin && (
              <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 space-y-1">
                <div className="text-silver text-xs uppercase tracking-widest mb-1">
                  Possible matches
                </div>
                {result.candidates.map((c) => (
                  <div key={c.associateId} className="text-white">
                    {c.associateName}{' '}
                    <span className="text-silver">— {c.associateEmail}</span>
                  </div>
                ))}
              </div>
            )}
            {result.matchedPin && (
              <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 space-y-1">
                {result.matchedPin.currentEmployeeNumber && (
                  <div className="mb-3 pb-3 border-b border-navy-secondary text-center">
                    <div className="text-xs uppercase tracking-widest text-silver">
                      Actual employee number on file
                    </div>
                    <div className="text-3xl font-mono tracking-[0.4em] text-white mt-1">
                      {result.matchedPin.currentEmployeeNumber}
                    </div>
                  </div>
                )}
                <div>
                  <span className="text-silver">PIN holder:</span>{' '}
                  <span className="text-white font-medium">
                    {result.matchedPin.associateName}
                  </span>{' '}
                  <span className="text-silver">
                    ({result.matchedPin.associateEmail})
                  </span>
                </div>
                <div>
                  <span className="text-silver">PIN issued under:</span>{' '}
                  <span className="text-white">
                    {result.matchedPin.pinClientName ?? result.matchedPin.pinClientId}
                  </span>
                </div>
                <div>
                  <span className="text-silver">Currently assigned to:</span>{' '}
                  <span className="text-white">
                    {result.currentAssignment
                      ? `${result.currentAssignment.clientName} · ${result.currentAssignment.locationName ?? '—'}`
                      : 'No open assignment'}
                  </span>
                </div>
                <div>
                  <span className="text-silver">Open shift:</span>{' '}
                  <span className="text-white">
                    {result.openTimeEntry
                      ? `clocked in ${new Date(result.openTimeEntry.clockInAt).toLocaleString()}`
                      : 'None'}
                  </span>
                </div>
                <div>
                  <span className="text-silver">Active kiosks at PIN's client:</span>{' '}
                  <span className="text-white">
                    {result.devicesAtPinClient?.length ?? 0}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onSubmit} disabled={submitDisabled}>
          {loading ? 'Checking…' : 'Diagnose'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function NewPinDrawer({
  clientId,
  initialAssociateId,
  onClose,
  onSaved,
}: {
  clientId: string;
  initialAssociateId?: string;
  onClose: () => void;
  onSaved: (associateName: string, employeeNumber: string) => void;
}) {
  type PickerEntry = {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    status: 'ACTIVE' | 'PENDING' | 'INACTIVE';
  };
  const [associates, setAssociates] = useState<PickerEntry[] | null>(null);
  const [associateId, setAssociateId] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);

  // Show every associate at the client. The server only allows issuing
  // to ACTIVE (= APPROVED application) associates; the picker reflects
  // that by disabling the others so HR can see who's there and why.
  useEffect(() => {
    let cancelled = false;
    listDirectory({ clientId })
      .then((r) => {
        if (cancelled) return;
        const list = r.associates.map((a) => ({
          id: a.id,
          firstName: a.firstName,
          lastName: a.lastName,
          email: a.email,
          status: a.status,
        }));
        setAssociates(list);
        // Preselect the associate we were opened for (issuing from a
        // "missing a code" row), if they're eligible; otherwise default to
        // the first eligible one so HR doesn't have to hunt for a row.
        const preset =
          initialAssociateId &&
          list.find((a) => a.id === initialAssociateId && a.status === 'ACTIVE');
        if (preset) {
          setAssociateId(initialAssociateId);
        } else {
          const firstEligible = list.find((a) => a.status === 'ACTIVE');
          if (firstEligible) setAssociateId(firstEligible.id);
        }
      })
      .catch(() => {
        if (!cancelled) setAssociates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, initialAssociateId]);

  const selected = associates?.find((a) => a.id === associateId);
  const eligibleCount =
    associates?.filter((a) => a.status === 'ACTIVE').length ?? 0;

  const onSubmit = async () => {
    if (!associateId) {
      toast.error('Pick an associate.');
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      toast.error('Number must be exactly 4 digits, or leave empty to auto-generate.');
      return;
    }
    setSaving(true);
    try {
      const r = await assignKioskPin({
        clientId,
        associateId,
        pin: pin || undefined,
      });
      const name = selected
        ? `${selected.firstName} ${selected.lastName}`
        : 'Associate';
      onSaved(name, r.employeeNumber);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Issue or rotate employee number</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate</Label>
          {associates === null ? (
            <Skeleton className="mt-1 h-10 w-full" />
          ) : associates.length === 0 ? (
            <div className="mt-1 text-xs text-silver">
              No associates have been added to this client yet. Start an
              onboarding application from the Onboarding page first.
            </div>
          ) : (
            <>
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
                value={associateId}
                onChange={(e) => setAssociateId(e.target.value)}
              >
                <option value="">Select an associate…</option>
                {associates.map((a) => {
                  const label =
                    a.status === 'ACTIVE'
                      ? `${a.firstName} ${a.lastName} — ${a.email}`
                      : `${a.firstName} ${a.lastName} — ${a.email} (onboarding ${a.status.toLowerCase()})`;
                  return (
                    <option
                      key={a.id}
                      value={a.id}
                      disabled={a.status !== 'ACTIVE'}
                    >
                      {label}
                    </option>
                  );
                })}
              </select>
              {eligibleCount === 0 && (
                <div className="mt-1 text-xs text-warning">
                  No associates here have an approved application yet —
                  approve one from the Onboarding page to issue a number.
                </div>
              )}
            </>
          )}
        </div>
        <div>
          <Label>Employee number (optional — leave empty to auto-generate)</Label>
          <Input
            className="mt-1 font-mono text-2xl tracking-widest text-center"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="1234"
            inputMode="numeric"
            maxLength={4}
          />
        </div>
        <div className="text-xs text-silver">
          If the associate already has a number, this rotates it. Numbers
          are unique across the entire company.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving || associates === null}>
          {saving ? 'Saving…' : 'Issue'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ISO lower-bound for the punch-log date filter.
function rangeFrom(range: 'all' | 'today' | '7d' | '30d'): string | undefined {
  if (range === 'all') return undefined;
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const days = range === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Typeahead that resolves a name/email to an associate id so the punch log
// can filter by associate SERVER-SIDE — i.e. across all history, not just
// the loaded page. Debounced lookup against the directory; selecting shows
// a removable chip.
function AssociatePicker({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (v: { id: string; name: string } | null) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<
    Array<{ id: string; name: string; email: string }>
  >([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      listDirectory({ q: term })
        .then((r) => {
          if (cancelled) return;
          setResults(
            r.associates.slice(0, 8).map((a) => ({
              id: a.id,
              name: `${a.firstName} ${a.lastName}`,
              email: a.email,
            })),
          );
        })
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q]);

  if (value) {
    return (
      <span className="inline-flex h-9 items-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-3 text-sm text-white">
        {value.name}
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Clear associate filter"
          className="text-silver hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    );
  }
  return (
    <div className="relative min-w-[200px]">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        placeholder="Filter by associate"
        className="h-9 pl-9"
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-navy-secondary bg-midnight shadow-xl">
          {results.map((a) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange({ id: a.id, name: a.name });
                setQ('');
                setOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-white hover:bg-navy-secondary/60"
            >
              {a.name} <span className="text-silver">— {a.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type ActionFilter =
  | 'ALL'
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'REJECTED';

function LogTab() {
  const [rows, setRows] = useState<KioskPunchSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([]);

  // All filters are server-side, so they search ALL history through cursor
  // pagination — not just one loaded page. (Earlier this filtered a single
  // 500-row page client-side, which silently missed anything older.)
  const [associate, setAssociate] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [deviceId, setDeviceId] = useState('');
  const [action, setAction] = useState<ActionFilter>('ALL');
  const [range, setRange] = useState<'all' | 'today' | '7d' | '30d'>('all');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);

  const PAGE = 100;
  const queryParams = (cursor?: string) => ({
    associateId: associate?.id,
    deviceId: deviceId || undefined,
    action: action === 'ALL' ? undefined : action,
    anomaliesOnly: anomaliesOnly || undefined,
    from: rangeFrom(range),
    cursor,
    limit: PAGE,
  });

  // Generation counter: bumped on every filter-driven reload so an
  // in-flight "Load more" from a previous filter can't splice its stale
  // page onto the new result set.
  const loadIdRef = useRef(0);

  // (Re)load the first page whenever a filter changes.
  useEffect(() => {
    const myId = ++loadIdRef.current;
    setRows(null);
    setNextCursor(null);
    listKioskPunches(queryParams())
      .then((r) => {
        if (loadIdRef.current !== myId) return;
        setRows(r.punches);
        setNextCursor(r.nextCursor);
      })
      .catch(() => {
        if (loadIdRef.current !== myId) return;
        setRows([]);
        setNextCursor(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [associate?.id, deviceId, action, range, anomaliesOnly]);

  // Device dropdown options.
  useEffect(() => {
    listKioskDevices()
      .then((r) =>
        setDevices(r.devices.map((d) => ({ id: d.id, name: d.name }))),
      )
      .catch(() => setDevices([]));
  }, []);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    const myId = loadIdRef.current;
    setLoadingMore(true);
    listKioskPunches(queryParams(nextCursor))
      .then((r) => {
        // Filters changed while this page was in flight — drop it.
        if (loadIdRef.current !== myId) return;
        setRows((prev) => [...(prev ?? []), ...r.punches]);
        setNextCursor(r.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const hasFilters =
    !!associate ||
    !!deviceId ||
    action !== 'ALL' ||
    range !== 'all' ||
    anomaliesOnly;

  const selectClass =
    'h-9 rounded-md border border-navy-secondary bg-navy-secondary/40 px-2 text-sm text-white';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <AssociatePicker value={associate} onChange={setAssociate} />
        <select
          className={selectClass}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={action}
          onChange={(e) => setAction(e.target.value as ActionFilter)}
        >
          <option value="ALL">All actions</option>
          <option value="CLOCK_IN">Clock in</option>
          <option value="CLOCK_OUT">Clock out</option>
          <option value="BREAK_START">Break start</option>
          <option value="BREAK_END">Break end</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <select
          className={selectClass}
          value={range}
          onChange={(e) => setRange(e.target.value as typeof range)}
        >
          <option value="all">Any time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <button
          type="button"
          onClick={() => setAnomaliesOnly((v) => !v)}
          className={`h-9 rounded-md border px-3 text-sm transition-colors ${
            anomaliesOnly
              ? 'border-warning/60 bg-warning/15 text-warning'
              : 'border-navy-secondary bg-navy-secondary/40 text-silver hover:text-white'
          }`}
        >
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> Anomalies only
        </button>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setAssociate(null);
              setDeviceId('');
              setAction('ALL');
              setRange('all');
              setAnomaliesOnly(false);
            }}
            className="h-9 px-2 text-sm text-silver hover:text-white"
          >
            Clear
          </button>
        )}
        <div className="ml-auto text-xs text-silver">
          {rows ? `${rows.length} loaded${nextCursor ? '+' : ''}` : ''}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            hasFilters ? (
              <div className="p-6 text-sm text-silver">
                No punches match these filters.
              </div>
            ) : (
              <EmptyState
                icon={Tablet}
                title="No punches yet"
                description="Once associates start clocking in via kiosk, the audit log appears here."
              />
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Distance</TableHead>
                  <TableHead>Face</TableHead>
                  <TableHead>Selfie</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{new Date(p.createdAt).toLocaleString()}</TableCell>
                    <TableCell className="font-mono text-xs">{p.deviceName}</TableCell>
                    <TableCell>{p.associateName ?? '—'}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.action === 'CLOCK_IN'
                            ? 'success'
                            : p.action === 'CLOCK_OUT'
                              ? 'accent'
                              : p.action === 'BREAK_START' || p.action === 'BREAK_END'
                                ? 'pending'
                                : 'destructive'
                        }
                      >
                        {p.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {p.distanceMeters != null ? `${p.distanceMeters}m` : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {p.faceDistance == null ? (
                        '—'
                      ) : p.faceMismatch ? (
                        <Badge variant="destructive">
                          Mismatch ({p.faceDistance.toFixed(2)})
                        </Badge>
                      ) : (
                        <Badge variant="success">
                          Match ({p.faceDistance.toFixed(2)})
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {p.hasSelfie ? (
                        <a
                          href={`/api/kiosk-punches/${p.id}/selfie`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-gold hover:text-gold-bright underline underline-offset-2 text-xs"
                        >
                          view
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-silver">
                      {p.rejectReason ?? ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {nextCursor && rows && rows.length > 0 && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}

function FacesTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<KioskFaceReferenceSummary[] | null>(null);

  const refresh = () => {
    setRows(null);
    listKioskFaceReferences()
      .then((r) => setRows(r.references))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScanFace}
            title="No face references"
            description="The first kiosk punch with face matching enabled enrolls each associate automatically."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Enrolled</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="group">
                  <TableCell className="font-medium text-white">
                    {r.associateName}
                  </TableCell>
                  <TableCell className="text-silver">{r.associateEmail}</TableCell>
                  <TableCell className="text-xs">
                    {new Date(r.enrolledAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs text-silver">
                    {new Date(r.updatedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <button
                        onClick={async () => {
                          if (
                            !(await confirm({
                              title: 'Reset this face reference?',
                              description: 'The next kiosk punch will re-enroll.',
                              destructive: true,
                            }))
                          )
                            return;
                          try {
                            await resetKioskFaceReference(r.associateId);
                            refresh();
                            toast.success('Reference cleared.');
                          } catch (err) {
                            toast.error(err instanceof ApiError ? err.message : 'Failed.');
                          }
                        }}
                        className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
                      >
                        Reset
                      </button>
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

// HR's SLA: punches that have sat in the review queue more than 3 days
// are visually escalated. We don't auto-resolve — biometric/anomaly
// review is an HR judgment call — but a "5 days pending" red badge
// pushes them to the top of the day's todo list.
const REVIEW_SLA_WARN_DAYS = 2;
const REVIEW_SLA_BREACH_DAYS = 5;

function renderPendingBadge(createdAt: string): JSX.Element {
  const days = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000),
  );
  if (days >= REVIEW_SLA_BREACH_DAYS) {
    return <Badge variant="destructive">{days}d pending</Badge>;
  }
  if (days >= REVIEW_SLA_WARN_DAYS) {
    return <Badge variant="pending">{days}d pending</Badge>;
  }
  return (
    <Badge variant="outline">{days === 0 ? 'Today' : `${days}d pending`}</Badge>
  );
}

function ReviewTab({ canManage }: { canManage: boolean }) {
  const prompt = usePrompt();
  const [rows, setRows] = useState<KioskPunchSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = () => {
    setRows(null);
    setSelected(new Set());
    // Oldest first — HR works the back of the queue down, not the
    // freshest punch first.
    listKioskPunches({ reviewStatus: 'PENDING', sort: 'oldest' })
      .then((r) => setRows(r.punches))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const decide = async (
    id: string,
    decision: 'APPROVED' | 'REJECTED',
  ) => {
    let notes: string | undefined;
    if (decision === 'REJECTED') {
      const v = await prompt({
        title: 'Reject kiosk punch',
        description: 'Rejecting will void the associated time entry.',
        reasonLabel: 'Notes for rejection',
        confirmLabel: 'Reject & void',
        destructive: true,
      });
      if (v === null) return;
      notes = v;
    }
    setBusy(id);
    try {
      await reviewKioskPunch(id, decision, notes);
      toast.success(decision === 'APPROVED' ? 'Approved.' : 'Rejected & voided.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    if (!rows) return;
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((p) => p.id)));
    }
  };

  const decideBulk = async (decision: 'APPROVED' | 'REJECTED') => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    let notes: string | undefined;
    if (decision === 'REJECTED') {
      const v = await prompt({
        title: `Reject ${ids.length} punches?`,
        description: 'All selected punches will have their time entries voided.',
        reasonLabel: 'Notes (applied to all)',
        confirmLabel: 'Reject & void',
        destructive: true,
      });
      if (v === null) return;
      notes = v;
    }
    setBulkBusy(true);
    try {
      const r = await reviewKioskPunchesBulk(ids, decision, notes);
      const msg =
        r.skipped.length > 0
          ? `${r.reviewed} reviewed, ${r.skipped.length} skipped`
          : decision === 'APPROVED'
            ? `${r.reviewed} approved`
            : `${r.reviewed} rejected & voided`;
      toast.success(msg);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="Nothing to review"
            description="Flagged kiosk punches (face mismatches, anomalies) appear here."
          />
        ) : (
          <>
            {canManage && (
              <div className="flex items-center justify-between gap-3 p-3 border-b border-navy-secondary bg-navy-secondary/30">
                <div className="text-sm text-silver">
                  {selected.size === 0
                    ? `${rows.length} flagged`
                    : `${selected.size} selected`}
                </div>
                <div className="space-x-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={selected.size === 0 || bulkBusy}
                    onClick={() => void decideBulk('APPROVED')}
                  >
                    Approve selected
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={selected.size === 0 || bulkBusy}
                    onClick={() => void decideBulk('REJECTED')}
                  >
                    Reject selected
                  </Button>
                </div>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  {canManage && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all flagged punches"
                        checked={
                          rows.length > 0 && selected.size === rows.length
                        }
                        onChange={toggleAll}
                      />
                    </TableHead>
                  )}
                  <TableHead>When</TableHead>
                  <TableHead>Aging</TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Selfie</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    {canManage && (
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select punch ${p.id}`}
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="text-xs">
                      {new Date(p.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{renderPendingBadge(p.createdAt)}</TableCell>
                    <TableCell className="font-medium text-white">
                      {p.associateName ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">{p.deviceName}</TableCell>
                    <TableCell>
                      <Badge variant={p.action === 'CLOCK_IN' ? 'success' : 'accent'}>
                        {p.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-warning">
                      <div className="font-medium">
                        {p.anomalyKind === 'IMPOSSIBLE_TRAVEL'
                          ? 'Impossible travel'
                          : p.anomalyKind === 'FACE_MISMATCH'
                            ? 'Face mismatch'
                            : p.anomalyKind === 'GEOFENCE'
                              ? 'Outside geofence'
                              : p.anomalyKind === 'FACE_ENROLLMENT'
                                ? 'New face enrolled'
                                : (p.rejectReason ?? 'Anomaly')}
                      </div>
                      {p.anomalyDetail && (
                        <div className="text-silver">{p.anomalyDetail}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {p.hasSelfie ? (
                        <a
                          href={`/api/kiosk-punches/${p.id}/selfie`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={`/api/kiosk-punches/${p.id}/selfie`}
                            alt="selfie"
                            className="w-12 h-12 rounded object-cover border border-navy-secondary"
                          />
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === p.id || bulkBusy}
                            onClick={() => void decide(p.id, 'APPROVED')}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy === p.id || bulkBusy}
                            onClick={() => void decide(p.id, 'REJECTED')}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
