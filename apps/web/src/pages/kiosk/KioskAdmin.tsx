import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
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
  setKioskPinFaceConsent,
  type KioskDevice,
  type KioskFaceReferenceSummary,
  type KioskPin,
  type KioskPinDiagnosis,
  type KioskPinHealth,
  type KioskPunchSummary,
  type KioskRejectGroup,
} from '@/lib/kiosk99Api';
import { listDirectory } from '@/lib/directoryApi';
import { listClientLocations } from '@/lib/clientsApi';
import { useClients } from '@/lib/useClients';
import { useStoreScope } from '@/lib/storeScope';
import { usePersistentState } from '@/lib/usePersistentState';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { boundedClientOf, hasCapability } from '@/lib/roles';
import {
  AssociatePicker,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from 'sonner';

type Tab = 'devices' | 'pins' | 'review' | 'log' | 'faces';

type ClientLocation = Awaited<ReturnType<typeof listClientLocations>>['locations'][number];
// Stable empties so derived lists keep their identity across renders
// (they sit in memo/effect deps).
const NO_LOCATIONS: ClientLocation[] = [];
const NO_PINS: KioskPin[] = [];

export function KioskAdmin() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:time') : false;
  // Active tab lives in ?tab= so views are linkable ("check the punch log")
  // and a refresh doesn't dump HR back on Devices. Replace-writes keep tab
  // hops from stacking up in Back history.
  const [tabParams, setTabParams] = useSearchParams();
  const tabParam = tabParams.get('tab');
  const tab: Tab =
    tabParam === 'pins' ||
    tabParam === 'review' ||
    tabParam === 'log' ||
    tabParam === 'faces'
      ? tabParam
      : 'devices';
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(tabParams);
    if (next === 'devices') params.delete('tab');
    else params.set('tab', next);
    setTabParams(params, { replace: true });
  };

  // Lightweight counts for the tab badges so HR sees pending review work
  // and broken kiosks at a glance without opening each tab. Refetched on
  // tab switch AND whenever a tab reports it changed something
  // (badgeBump) — approving 10 punches updates "Review (10)" right away
  // instead of waiting for the next tab switch.
  const [badgeBump, setBadgeBump] = useState(0);
  const bumpBadges = () => setBadgeBump((b) => b + 1);
  // The device list is the same query the Devices and Log tabs read, so a
  // revoke there refreshes this count without a bump.
  const pendingQuery = useQuery({
    queryKey: ['kiosk', 'punches', 'pending'],
    queryFn: () => listKioskPunches({ reviewStatus: 'PENDING' }),
  });
  const devicesQuery = useQuery({
    queryKey: ['kiosk', 'devices'],
    queryFn: () => listKioskDevices(),
  });
  const { refetch: refetchPending } = pendingQuery;
  const { refetch: refetchDevices } = devicesQuery;
  useEffect(() => {
    void refetchPending();
    void refetchDevices();
  }, [tab, badgeBump, refetchPending, refetchDevices]);
  const pendingReview = pendingQuery.data ? pendingQuery.data.punches.length : null;
  const offlineDevices = devicesQuery.data
    ? devicesQuery.data.devices.filter(isDeviceOffline).length
    : null;

  const countLabel = (n: number) => (n > 99 ? '99+' : String(n));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Kiosk admin"
        subtitle="Register tablets, issue 4-digit employee numbers, and review the punch log."
        breadcrumbs={[{ label: 'Time' }, { label: 'Kiosk' }]}
      />
      {canManage && <PinHealthBanner onTab={() => setTab('pins')} bump={badgeBump} />}
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
        <TabsContent value="devices"><DevicesTab canManage={canManage} onChanged={bumpBadges} /></TabsContent>
        <TabsContent value="pins"><PinsTab canManage={canManage} onChanged={bumpBadges} /></TabsContent>
        <TabsContent value="review"><ReviewTab canManage={canManage} onChanged={bumpBadges} /></TabsContent>
        <TabsContent value="log"><LogTab /></TabsContent>
        <TabsContent value="faces"><FacesTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

// Early-warning banner: flags codes that won't clock in (PIN secret drifted)
// or can't be displayed (encryption key drifted), before associates hit it at
// the kiosk. Silent when everything's healthy.
function PinHealthBanner({ onTab, bump }: { onTab: () => void; bump: number }) {
  // `bump` is part of the key: after any tab reports a change the check
  // re-runs, so fixing the affected codes (Rotate all) actually clears the
  // banner instead of it staying red until a full page reload.
  const healthQuery = useQuery({
    queryKey: ['kiosk', 'pins', 'health', bump],
    queryFn: () => kioskPinsHealth(),
  });
  const health: KioskPinHealth | null = healthQuery.data ?? null;

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
            <Button
              variant="link"
              onClick={onTab}
              className="text-xs text-white underline underline-offset-2 hover:text-gold"
            >
              Employee numbers → Rotate all
            </Button>{' '}
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
//
// Never-seen devices are NOT offline — a spare tablet awaiting
// deployment isn't an outage. This matches the server's fleet-notice
// emails exactly, so the on-screen count and the inbox never disagree.
// Never-seen rows still show a "Never used" badge in the table.
const OFFLINE_THRESHOLD_HOURS = 24;

function isDeviceOffline(d: KioskDevice): boolean {
  if (!d.isActive || !d.lastSeenAt) return false;
  const ageMs = Date.now() - new Date(d.lastSeenAt).getTime();
  return ageMs > OFFLINE_THRESHOLD_HOURS * 60 * 60 * 1000;
}

// Active devices whose token dies within 14 days — the kiosk stops
// accepting punches the moment it lapses (the hourly server job also
// emails admins at the 14- and 3-day marks).
function isTokenExpiringSoon(d: KioskDevice): boolean {
  if (!d.isActive || !d.tokenExpiresAt) return false;
  const msLeft = new Date(d.tokenExpiresAt).getTime() - Date.now();
  return msLeft > 0 && msLeft <= 14 * 24 * 60 * 60 * 1000;
}

// Table sort band: problem devices first — offline (punches silently
// lost) ahead of token-expiring ahead of healthy.
function deviceHealthRank(d: KioskDevice): number {
  return isDeviceOffline(d) ? 0 : isTokenExpiringSoon(d) ? 1 : 2;
}

function DevicesTab({
  canManage,
  onChanged,
}: {
  canManage: boolean;
  onChanged?: () => void;
}) {
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [showToken, setShowToken] = useState<string | null>(null);

  const devicesQuery = useQuery({
    queryKey: ['kiosk', 'devices'],
    queryFn: () => listKioskDevices(),
  });
  const rows: KioskDevice[] | null = devicesQuery.data?.devices ?? null;
  const loadError = devicesQuery.isError;
  const refresh = () => {
    void devicesQuery.refetch();
    // Revoking/deleting/registering changes the offline tab badge too.
    onChanged?.();
  };

  const offline = rows ? rows.filter(isDeviceOffline) : [];
  const expiringSoon = rows ? rows.filter(isTokenExpiringSoon) : [];
  // The health tiles double as filters over the table; 'all' = no filter.
  const [healthFilter, setHealthFilter] = useState<'all' | 'offline' | 'expiring'>(
    'all',
  );
  // Problem devices surface first regardless of filter. sort() is stable,
  // so within each health band the server's ordering is untouched.
  const visibleRows = useMemo(() => {
    if (!rows) return null;
    const list =
      healthFilter === 'offline'
        ? rows.filter(isDeviceOffline)
        : healthFilter === 'expiring'
          ? rows.filter(isTokenExpiringSoon)
          : rows;
    return [...list].sort((a, b) => deviceHealthRank(a) - deviceHealthRank(b));
  }, [rows, healthFilter]);
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
          <button
            type="button"
            onClick={() => setHealthFilter('all')}
            aria-pressed={healthFilter === 'all'}
            title="Show all devices"
            className="flex-1 min-w-[180px] rounded-lg border px-4 py-3 text-left transition-colors bg-navy-secondary/40 border-navy-secondary"
          >
            <div className="text-xs uppercase tracking-widest text-silver">Kiosks</div>
            <div className="text-2xl font-medium text-white">
              {rows.filter((d) => d.isActive).length}
            </div>
            <div className="text-xs text-silver">{rows.length} total</div>
          </button>
          <button
            type="button"
            onClick={() =>
              setHealthFilter((f) => (f === 'offline' ? 'all' : 'offline'))
            }
            aria-pressed={healthFilter === 'offline'}
            title={
              healthFilter === 'offline'
                ? 'Show all devices'
                : 'Filter the table to offline devices'
            }
            className={`flex-1 min-w-[180px] rounded-lg px-4 py-3 border text-left transition-colors ${
              healthFilter === 'offline'
                ? 'bg-gold/10 border-gold/60'
                : offline.length > 0
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
          </button>
          <button
            type="button"
            onClick={() =>
              setHealthFilter((f) => (f === 'expiring' ? 'all' : 'expiring'))
            }
            aria-pressed={healthFilter === 'expiring'}
            title={
              healthFilter === 'expiring'
                ? 'Show all devices'
                : 'Filter the table to devices with expiring tokens'
            }
            className={`flex-1 min-w-[180px] rounded-lg px-4 py-3 border text-left transition-colors ${
              healthFilter === 'expiring'
                ? 'bg-gold/10 border-gold/60'
                : expiringSoon.length > 0
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
          </button>
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
          {loadError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Couldn't load kiosk devices.</span>
                  <Button size="sm" variant="ghost" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Tablet}
              title="No kiosks"
              description="Register a tablet to enable PIN-based clock in/out."
            />
          ) : (visibleRows ?? []).length === 0 ? (
            // A refresh can resolve the problem set while its filter is
            // still active — offer the way back instead of a dead end.
            <div className="flex flex-wrap items-center justify-between gap-2 p-6 text-sm text-silver">
              <span>No devices match this filter.</span>
              <Button size="sm" variant="ghost" onClick={() => setHealthFilter('all')}>
                Show all
              </Button>
            </div>
          ) : (
            <DataGrid<NonNullable<typeof visibleRows>[number]>
              id="kiosk-devices"
              caption="Kiosk devices"
              rows={visibleRows ?? []}
              rowKey={(d) => d.id}
              search={{ placeholder: 'Device, client, location…' }}
              urlState={false}
              exportCsv={{ filename: 'kiosk-devices' }}
              columns={[
                { key: 'name', header: 'Name', accessor: (d) => d.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'client', header: 'Client', accessor: (d) => d.clientName, sortable: true, cardMeta: true },
                { key: 'location', header: 'Location', accessor: (d) => d.locationName, sortable: true, className: 'text-silver', cell: (d) => d.locationName ?? '—' },
                { key: 'status', header: 'Status', accessor: (d) => (d.isActive ? 'Active' : 'Revoked'), sortable: true, searchable: false, cell: (d) => (d.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="destructive">Revoked</Badge>) },
                {
                  key: 'lastSeen',
                  header: 'Last seen',
                  accessor: (d) => d.lastSeenAt,
                  csv: (d) => (d.lastSeenAt ? `${fmtDateTime(d.lastSeenAt)}${isDeviceOffline(d) ? ' (offline)' : ''}` : d.isActive ? 'Never used' : ''),
                  sortable: true,
                  searchable: false,
                  cardMeta: true,
                  cell: (d) =>
                    d.lastSeenAt ? (
                      <span className={isDeviceOffline(d) ? 'text-warning' : undefined}>
                        {fmtDateTime(d.lastSeenAt)}
                        {isDeviceOffline(d) && (
                          <Badge variant="pending" className="ml-2">
                            Offline
                          </Badge>
                        )}
                      </span>
                    ) : d.isActive ? (
                      <Badge variant="outline">Never used</Badge>
                    ) : (
                      '—'
                    ),
                },
                { key: 'token', header: 'Token', accessor: (d) => d.tokenExpiresAt, sortable: true, searchable: false, cell: (d) => renderTokenStatus(d.tokenExpiresAt) },
                { key: 'punches', header: 'Punches', accessor: (d) => d.punchCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        className: 'space-x-2',
                        cell: (d: NonNullable<typeof visibleRows>[number]) => (
                          <>
                            {d.isActive && (
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
                            {d.isActive && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  if (!(await confirm({ title: 'Revoke this kiosk?', description: 'It will stop accepting punches.', destructive: true })))
                                    return;
                                  try {
                                    await revokeKioskDevice(d.id);
                                    toast.success('Kiosk revoked.');
                                    refresh();
                                  } catch (err) {
                                    toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                  }
                                }}
                              >
                                Revoke
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-silver hover:text-alert"
                              onClick={async () => {
                                if (!(await confirm({ title: 'Permanently delete?', destructive: true }))) return;
                                try {
                                  await deleteKioskDevice(d.id);
                                  toast.success('Kiosk deleted.');
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                }
                              }}
                            >
                              Delete
                            </Button>
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
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
  const { user } = useAuth();
  // Client-bound roles (SHIFT_SUPERVISOR) can't list clients — /clients
  // 403s for them. Pin the required client choice to theirs instead.
  const boundedClient = boundedClientOf(user);
  // Shared react-query client list (5-min cache). Bounded viewers are
  // seeded from the user and never fetch (the endpoint would 403).
  const { clients: clientList, isLoading: clientsLoading } = useClients({
    enabled: !boundedClient,
  });
  const clients: Array<{ id: string; name: string }> | null = boundedClient
    ? [boundedClient]
    : clientsLoading
      ? null
      : clientList.map((c) => ({ id: c.id, name: c.name }));
  // Seed from the global Topbar store scope — registering a kiosk while
  // scoped to a store shouldn't re-ask which store. Transient drawer, so
  // no follow/write-back; a pick here stays local.
  const storeScope = useStoreScope();
  const [clientId, setClientId] = useState(
    boundedClient?.id ??
      (storeScope.enabled && storeScope.clientId ? storeScope.clientId : ''),
  );
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  // Default to the first client once the list is in (a scope-seeded id
  // that's stale — client since removed — falls back the same way).
  useEffect(() => {
    if (boundedClient || clientsLoading) return;
    if (
      !clientList.some((c) => c.id === clientId) &&
      clientList.length > 0
    )
      setClientId(clientList[0]!.id);
    // boundedClient is stable for the session (derived from the signed-in user).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsLoading, clientList]);

  // Phase 131 — the client's locations. The first one is picked as soon
  // as the list is in, so HR can hit Register without an extra click in
  // the common single-site case; a client switch clears the pick.
  const locationsQuery = useQuery({
    queryKey: ['clients', clientId, 'locations'],
    queryFn: () => listClientLocations(clientId),
    enabled: Boolean(clientId),
  });
  const locations: ClientLocation[] | null = !clientId
    ? null
    : locationsQuery.isError
      ? NO_LOCATIONS
      : (locationsQuery.data?.locations ?? null);
  useEffect(() => {
    setLocationId('');
  }, [clientId]);
  useEffect(() => {
    if (locations && locations.length > 0) setLocationId((cur) => cur || locations[0]!.id);
  }, [locations]);

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
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      confirmDiscard={() => name.trim().length > 0}
    >
      <DrawerHeader>
        <DrawerTitle>Register kiosk</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Client</Label>
          {boundedClient ? (
            // Client-bound role — the client is fixed, not a choice.
            <div className="mt-1 flex h-10 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 text-sm text-white">
              {boundedClient.name}
            </div>
          ) : clients === null ? (
            <Skeleton className="mt-1 h-10 w-full" />
          ) : clients.length === 0 ? (
            <div className="mt-1 text-xs text-silver">
              No clients yet — create one in Clients first.
            </div>
          ) : (
            <Select
              className="mt-1"
              aria-label="Client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
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
            <Select
              className="mt-1"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.state ? ` · ${l.state}` : ''}
                </option>
              ))}
            </Select>
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
    // confirmDiscard: the token is shown ONCE — a stray Esc or backdrop
    // click here used to lose it permanently (recovery = rotate and
    // re-pair the tablet). The explicit "I've paired it" button still
    // closes without the guard.
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard>
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
      {/* -my keeps the icon-sm hit target from stretching the table row. */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setRevealed((r) => !r)}
        className="-my-1.5 can-hover:opacity-60 group-hover:opacity-100"
        aria-label={revealed ? 'Hide employee number' : 'Show employee number'}
        title={revealed ? 'Hide' : 'Show'}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
        className="-my-1.5 can-hover:opacity-60 group-hover:opacity-100"
        aria-label="Copy employee number"
        title="Copy"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

// Face-verification consent cell. Read-only badge plus the two admin
// actions the kiosk consent screen promises ("change this later through
// your manager"): RESET re-asks at the next punch — the only path back
// in for someone who declined and changed their mind — and DECLINE
// records an opt-out + scrubs biometrics. No admin GRANT on purpose.
function FaceConsentCell({
  pin,
  canManage,
  onChanged,
}: {
  pin: KioskPin;
  canManage: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const status = pin.faceConsentStatus;

  const act = async (action: 'RESET' | 'DECLINE') => {
    const ok = await confirm(
      action === 'RESET'
        ? {
            title: `Re-ask ${pin.associateName} for face consent?`,
            description:
              'Clears their current answer — the kiosk shows the consent question again at their next punch. Use this when someone who declined changes their mind.',
          }
        : {
            title: `Mark ${pin.associateName} as declined?`,
            description:
              'Records that they opted out of face verification (e.g. they told you directly). Their stored selfies and face template are deleted immediately; they clock in PIN-only.',
            destructive: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await setKioskPinFaceConsent(pin.id, action);
      toast.success(action === 'RESET' ? 'Will re-ask at next punch.' : 'Marked declined — biometrics scrubbed.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {status === 'GRANTED' ? (
        <Badge variant="success">Granted</Badge>
      ) : status === 'DECLINED' ? (
        <Badge variant="outline">Declined</Badge>
      ) : (
        <Badge variant="pending">Not asked</Badge>
      )}
      {canManage && (
        // Visible on touch (no hover exists to reveal it — this was
        // tap-unreachable on tablets); hover-revealed on pointer devices.
        <span className="inline-flex gap-2 opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 group-focus-within:opacity-100 transition">
          {status !== null && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => act('RESET')}
              title="Clear the answer — the kiosk asks again at their next punch"
            >
              Re-ask
            </Button>
          )}
          {status !== 'DECLINED' && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => act('DECLINE')}
              className="hover:text-alert"
              title="Record an opt-out and delete stored biometrics"
            >
              Decline
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

function PinsTab({
  canManage,
  onChanged,
}: {
  canManage: boolean;
  onChanged?: () => void;
}) {
  const confirm = useConfirm();
  const { user } = useAuth();
  // Client-bound roles (SHIFT_SUPERVISOR) can't list clients — /clients
  // 403s for them. Seed the picker with their one client (no "All clients")
  // and start on it so the tab isn't an empty dead end.
  const boundedClient = boundedClientOf(user);
  // Shared react-query client list (5-min cache). Bounded viewers are
  // seeded from the user and never fetch (the endpoint would 403).
  const { clients: clientList, isLoading: clientsLoading } = useClients({
    enabled: !boundedClient,
  });
  const clients: Array<{ id: string; name: string }> | null = boundedClient
    ? [boundedClient]
    : clientsLoading
      ? null
      : clientList.map((c) => ({ id: c.id, name: c.name }));
  // The global Topbar store scope is this tab's default client; when the
  // scope is "all stores" the last page-local pick (persisted below —
  // ALL_CLIENTS is a valid pick) wins instead, so a multi-store operator
  // never re-picks on every visit.
  const storeScope = useStoreScope();
  const [persistedClientId, setPersistedClientId] = usePersistentState<string>(
    'alto:list.kiosk.pins.client.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const [clientId, setClientIdState] = useState(
    () =>
      boundedClient?.id ??
      (storeScope.enabled && storeScope.clientId
        ? storeScope.clientId
        : persistedClientId),
  );
  // Follow LATER Topbar scope changes without fighting the initializer:
  // skip the effect's first run, then mirror every change ('' = all stores
  // maps to the All clients view).
  const scopeClientId =
    storeScope.enabled && !boundedClient ? storeScope.clientId : null;
  const scopeSyncedRef = useRef(false);
  useEffect(() => {
    if (scopeClientId === null) return;
    if (!scopeSyncedRef.current) {
      scopeSyncedRef.current = true;
      return;
    }
    setClientIdState((prev) => {
      const next = scopeClientId || ALL_CLIENTS;
      return prev === next ? prev : next;
    });
  }, [scopeClientId]);
  // Page-level picks write back to the global scope (Scheduling / Time
  // follow along) and persist as this tab's scope-is-all fallback.
  const setClientId = (id: string) => {
    setClientIdState(id);
    setPersistedClientId(id);
    storeScope.setClientId(id === ALL_CLIENTS ? '' : id);
  };
  const [showNew, setShowNew] = useState(false);
  const [showDiagnose, setShowDiagnose] = useState(false);
  const [showPin, setShowPin] = useState<{
    associateName: string;
    employeeNumber: string;
  } | null>(null);
  // Search box (with-codes view) + "With codes / Missing" roster toggle.
  // The filter memo keys on the DEFERRED value so keystrokes commit
  // instantly and the row re-filter lags a frame behind on big rosters
  // (same pattern as PeopleDirectory).
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q);
  const [view, setView] = useState<'with' | 'missing'>('with');
  // Worksite filter — for a client with multiple stores/locations, narrow the
  // list to one location.
  const [locationFilter, setLocationFilter] = useState('');
  // When issuing from a "missing" row, preselect that associate in the drawer.
  const [issueFor, setIssueFor] = useState<string | null>(null);

  // Deep link from the People drawer: ?tab=pins&issue=<associateId>
  // (&client=<clientId>) opens the issue drawer preselected on that
  // associate. Params are consumed with a replace-write so refresh/Back
  // don't re-open the drawer — the house deep-link convention.
  const [deepParams, setDeepParams] = useSearchParams();
  useEffect(() => {
    const issue = deepParams.get('issue');
    if (!issue) return;
    const deepClient = deepParams.get('client');
    if (deepClient && !boundedClient) setClientId(deepClient);
    setIssueFor(issue);
    setShowNew(true);
    const next = new URLSearchParams(deepParams);
    next.delete('issue');
    next.delete('client');
    setDeepParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepParams]);

  // Default to the first client so HR doesn't land on an empty state; a
  // stale persisted/scoped id (client since removed) falls back the same
  // way. Local set only — a fallback isn't a pick, so it doesn't write to
  // the global scope or the persisted value.
  useEffect(() => {
    if (boundedClient || clientsLoading) return;
    const valid =
      clientId === ALL_CLIENTS || clientList.some((c) => c.id === clientId);
    if (!valid && clientList.length > 0) setClientIdState(clientList[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsLoading, clientList]);

  const pinsQuery = useQuery({
    queryKey: ['kiosk', 'pins', clientId],
    queryFn: () => listKioskPins(clientId === ALL_CLIENTS ? undefined : clientId),
    enabled: Boolean(clientId),
  });
  const rows: KioskPin[] | null = !clientId ? NO_PINS : (pinsQuery.data?.pins ?? null);
  const loadError = pinsQuery.isError;
  const refresh = () => void pinsQuery.refetch();

  // PIN-eligible associates (ACTIVE = approved application) at the selected
  // client, used to compute who is MISSING a code. Per-client only — the
  // directory is cursor-paginated, so we don't diff across all clients.
  // Cached for 60s so tab-hopping / drawer churn doesn't re-pull the
  // roster; limit 500 (the server max) keeps it to one request instead of
  // the default page size, and we keep only the fields the diff needs.
  const eligibleQuery = useQuery({
    queryKey: ['directory', clientId, 'ACTIVE'],
    queryFn: () => listDirectory({ clientId, status: 'ACTIVE', limit: 500 }),
    enabled: Boolean(clientId && clientId !== ALL_CLIENTS),
    staleTime: 60_000,
  });
  const eligible = useMemo<
    Array<{
      id: string;
      name: string;
      email: string;
      currentLocationId: string | null;
    }> | null
  >(() => {
    if (!clientId || clientId === ALL_CLIENTS) return null;
    if (eligibleQuery.isError) return [];
    if (!eligibleQuery.data) return null; // loading — matches the old null state
    return eligibleQuery.data.associates.map((a) => ({
      id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      email: a.email,
      currentLocationId: a.currentLocationId,
    }));
  }, [clientId, eligibleQuery.data, eligibleQuery.isError]);

  // Locations for the selected client, for the worksite filter. The
  // filter resets whenever the client changes.
  const worksitesQuery = useQuery({
    queryKey: ['clients', clientId, 'locations'],
    queryFn: () => listClientLocations(clientId),
    enabled: Boolean(clientId && clientId !== ALL_CLIENTS),
  });
  const locationOptions = useMemo(
    () =>
      clientId && clientId !== ALL_CLIENTS
        ? (worksitesQuery.data?.locations ?? []).map((l) => ({ id: l.id, name: l.name }))
        : [],
    [clientId, worksitesQuery.data],
  );
  useEffect(() => {
    setLocationFilter('');
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
    const term = deferredQ.trim().toLowerCase();
    if (!term) return list;
    return list.filter(
      (p) =>
        p.associateName.toLowerCase().includes(term) ||
        p.associateEmail.toLowerCase().includes(term) ||
        (p.employeeNumber ?? '').includes(term) ||
        p.clientName.toLowerCase().includes(term),
    );
  }, [rows, deferredQ, locationFilter]);
  // Rows we can actually email — a recoverable (non-legacy) number AND a
  // still-employed associate. Separated/deactivated folks keep their PIN
  // row for history, but mailing clock-in credentials to ex-employees is
  // never what "Email all" means.
  const emailableRows = useMemo(
    () => filteredRows.filter((p) => p.employeeNumber && p.active),
    [filteredRows],
  );
  // Rows whose number is broken: can't be displayed (legacy /
  // un-decryptable) OR displays fine but won't clock in (PIN secret
  // drifted — the health banner's wontClockIn count). Either way the only
  // fix is re-issuing; both drive the "Rotate all" bulk action. Inactive
  // associates are left alone — nothing to fix for someone who can't
  // clock in anyway.
  const brokenRows = useMemo(
    () => filteredRows.filter((p) => p.active && (!p.employeeNumber || p.wontClockIn)),
    [filteredRows],
  );
  const [rotatingAll, setRotatingAll] = useState(false);
  const [assigningAll, setAssigningAll] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-md">
          <Label>Client</Label>
          {boundedClient ? (
            // Client-bound role — pinned to their client; no "All clients".
            <div
              className="mt-1 flex h-10 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 text-sm text-white"
              title="Your account is scoped to this client"
            >
              {boundedClient.name}
            </div>
          ) : clients === null ? (
            <Skeleton className="mt-1 h-10 w-full" />
          ) : clients.length === 0 ? (
            <div className="mt-1 text-xs text-silver">
              No clients yet — create one in Clients first.
            </div>
          ) : (
            <Select
              className="mt-1"
              aria-label="Filter by client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value={ALL_CLIENTS}>All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        {clientId && clientId !== ALL_CLIENTS && locationOptions.length > 0 && (
          <div className="max-w-xs flex-1">
            <Label>Location</Label>
            <Select
              className="mt-1"
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
            >
              <option value="">All locations</option>
              {locationOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
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
        {canManage && effectiveView === 'with' && brokenRows.length > 0 && (
          <Button
            variant="ghost"
            disabled={rotatingAll}
            onClick={async () => {
              const n = brokenRows.length;
              if (
                !(await confirm({
                  title: `Re-issue ${n} broken number${n === 1 ? '' : 's'}?`,
                  description:
                    `These codes are broken — either they can't be displayed (encryption key drifted) or they display fine but won't clock in (PIN secret drifted). Re-issuing is the only fix. ` +
                    `Each associate gets a NEW number and their current one stops working immediately. ` +
                    `You'll be offered to email everyone their new number right after.`,
                  destructive: true,
                }))
              )
                return;
              setRotatingAll(true);
              let ok = 0;
              const failedNames: string[] = [];
              // Collect the fresh pin row ids so the chained email step
              // below targets exactly the numbers we just issued.
              const newIds: string[] = [];
              for (const p of brokenRows) {
                try {
                  const r = await assignKioskPin({
                    clientId: p.clientId,
                    associateId: p.associateId,
                  });
                  newIds.push(r.id);
                  ok++;
                } catch {
                  failedNames.push(p.associateName);
                }
              }
              setRotatingAll(false);
              if (ok > 0) {
                toast.success(
                  `Re-issued ${ok} number${ok === 1 ? '' : 's'} — now visible in the list.`,
                );
              }
              if (failedNames.length > 0) {
                toast.error(
                  `${failedNames.length} failed (check onboarding status): ${failedNames
                    .slice(0, 5)
                    .join(', ')}${failedNames.length > 5 ? '…' : ''}`,
                );
              }
              refresh();
              onChanged?.();
              // Chain the delivery step — a rotated number nobody knows
              // about is tomorrow's "wrong PIN" support call.
              if (
                newIds.length > 0 &&
                (await confirm({
                  title: `Email the ${newIds.length} new number${newIds.length === 1 ? '' : 's'} now?`,
                  description:
                    'Each associate receives their own new 4-digit number at the email on file.',
                }))
              ) {
                try {
                  const r = await emailKioskPinsBulk(newIds);
                  toast.success(
                    `Queued ${r.queued} email${r.queued === 1 ? '' : 's'}${
                      r.skipped ? ` · ${r.skipped} skipped (no address)` : ''
                    }.`,
                  );
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Emails failed — use Email all.',
                  );
                }
              }
            }}
          >
            <RotateCw className="mr-2 h-4 w-4" />
            {rotatingAll ? 'Re-issuing…' : `Rotate all — (${brokenRows.length})`}
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
                    `You'll be offered to email everyone their number right after.`,
                }))
              )
                return;
              setAssigningAll(true);
              let ok = 0;
              const failedNames: string[] = [];
              // Fresh pin row ids for the chained email step — a number
              // nobody was told about is tomorrow's "wrong PIN" call.
              const newIds: string[] = [];
              for (const a of missing) {
                try {
                  const r = await assignKioskPin({ clientId, associateId: a.id });
                  newIds.push(r.id);
                  ok++;
                } catch {
                  failedNames.push(a.name);
                }
              }
              setAssigningAll(false);
              if (ok > 0) {
                toast.success(
                  `Issued ${ok} number${ok === 1 ? '' : 's'} — now in the With codes list.`,
                );
              }
              if (failedNames.length > 0) {
                toast.error(
                  `${failedNames.length} failed (check onboarding status): ${failedNames
                    .slice(0, 5)
                    .join(', ')}${failedNames.length > 5 ? '…' : ''}`,
                );
              }
              setView('with');
              refresh();
              onChanged?.();
              // Same delivery chain as Rotate all — issuing into the void
              // was the gap: the numbers existed but nobody had them.
              if (
                newIds.length > 0 &&
                (await confirm({
                  title: `Email the ${newIds.length} new number${newIds.length === 1 ? '' : 's'} now?`,
                  description:
                    'Each associate receives their own 4-digit number at the email on file.',
                }))
              ) {
                try {
                  const r = await emailKioskPinsBulk(newIds);
                  toast.success(
                    `Queued ${r.queued} email${r.queued === 1 ? '' : 's'}${
                      r.skipped ? ` · ${r.skipped} skipped (no address)` : ''
                    }.`,
                  );
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Emails failed — use Email all.',
                  );
                }
              }
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setView('with')}
                className={`rounded-none text-sm ${
                  effectiveView === 'with'
                    ? 'bg-gold/15 text-white hover:bg-gold/15'
                    : 'bg-navy-secondary/40'
                }`}
              >
                With codes{rows ? ` (${rows.length})` : ''}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setView('missing')}
                className={`rounded-none border-l border-navy-secondary text-sm ${
                  effectiveView === 'missing'
                    ? 'bg-gold/15 text-white hover:bg-gold/15'
                    : 'bg-navy-secondary/40'
                }`}
              >
                Missing{eligible ? ` (${missing.length})` : ''}
              </Button>
            </div>
          )}
          {effectiveView === 'with' && (
            <div className="relative min-w-[200px] max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-silver" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, or number"
                aria-label="Search associates by name, email, or number"
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
          ) : loadError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Couldn't load employee numbers.</span>
                  <Button size="sm" variant="ghost" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
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
              <DataGrid<(typeof missing)[number]>
                id="kiosk-missing-numbers"
                caption="Associates missing employee numbers"
                rows={missing}
                rowKey={(a) => a.id}
                search={{ placeholder: 'Name, email…' }}
                urlState={false}
                exportCsv={{ filename: 'missing-employee-numbers' }}
                columns={[
                  { key: 'associate', header: 'Associate', accessor: (a) => a.name, sortable: true, primary: true, className: 'font-medium text-white' },
                  { key: 'email', header: 'Email', accessor: (a) => a.email, sortable: true, cardMeta: true, className: 'text-silver' },
                  ...(canManage
                    ? [
                        {
                          key: 'action',
                          header: 'Action',
                          accessor: () => null,
                          searchable: false,
                          csv: () => '',
                          align: 'right' as const,
                          stopRowClick: true,
                          cell: (a: (typeof missing)[number]) => (
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
                          ),
                        },
                      ]
                    : []),
                ]}
              />
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
            // Render cap — the fetch can return 500 rows × 8 columns;
            // search narrows to the rest and the count line below says
            // what's hidden.
            <DataGrid<(typeof filteredRows)[number]>
              id="kiosk-employee-numbers"
              caption="Kiosk employee numbers"
              rows={filteredRows.slice(0, 150)}
              rowKey={(pn) => pn.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columns={[
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (pn) => pn.associateName,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (pn) => (
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">
                        <AssociateLink associateId={pn.associateId}>{pn.associateName}</AssociateLink>
                      </span>
                      {!pn.active && (
                        <Badge variant="outline" title="Separated or deactivated — their number stays on file for history but can't open a new shift, and Email all skips them.">
                          Inactive
                        </Badge>
                      )}
                    </div>
                  ),
                },
                ...(clientId === ALL_CLIENTS
                  ? [{ key: 'client', header: 'Client', accessor: (pn: (typeof filteredRows)[number]) => pn.clientName, sortable: true, cardMeta: true, className: 'text-silver' }]
                  : []),
                { key: 'location', header: 'Location', accessor: (pn) => pn.locationName, sortable: true, cardMeta: true, className: 'text-silver', cell: (pn) => pn.locationName ?? '—' },
                { key: 'email', header: 'Email', accessor: (pn) => pn.associateEmail, sortable: true, className: 'text-silver' },
                {
                  key: 'number',
                  header: 'Employee #',
                  accessor: (pn) => pn.employeeNumber,
                  searchable: false,
                  stopRowClick: true,
                  cell: (pn) => (
                    <div className="flex items-center gap-2">
                      <EmployeeNumberCell value={pn.employeeNumber} />
                      {pn.wontClockIn && (
                        <Badge variant="destructive" title="The stored hash no longer matches the current PIN secret — this number fails at every kiosk. Rotate to fix.">
                          won&rsquo;t clock in
                        </Badge>
                      )}
                    </div>
                  ),
                },
                { key: 'face', header: 'Face consent', accessor: () => null, searchable: false, csv: () => '', stopRowClick: true, cell: (pn) => <FaceConsentCell pin={pn} canManage={canManage} onChanged={refresh} /> },
                { key: 'issued', header: 'Issued', accessor: (pn) => pn.createdAt, sortable: true, searchable: false, cell: (pn) => fmtDate(pn.createdAt) },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        cell: (pn: (typeof filteredRows)[number]) => (
                          <div className="flex items-center justify-end gap-3">
                            {pn.employeeNumber && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={async () => {
                                  if (
                                    !(await confirm({
                                      title: `Email ${pn.associateName} their clock-in number?`,
                                      description: `It will be sent to ${pn.associateEmail}.`,
                                    }))
                                  )
                                    return;
                                  try {
                                    await emailKioskPin(pn.id);
                                    toast.success(`Emailed ${pn.associateEmail}.`);
                                  } catch (err) {
                                    toast.error(err instanceof ApiError ? err.message : 'Failed to email.');
                                  }
                                }}
                                className="gap-1"
                              >
                                <Mail className="h-3.5 w-3.5" /> Email
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={async () => {
                                if (
                                  !(await confirm({
                                    title: `Rotate ${pn.associateName}'s clock-in number?`,
                                    description: pn.associateEmail
                                      ? `Issues a NEW 4-digit number — their current one stops working immediately — and emails it to ${pn.associateEmail}. Use this for a code showing “—” (unreadable) or a forgotten number.`
                                      : `Issues a NEW 4-digit number — their current one stops working immediately. No email on file, so share the number shown after.`,
                                    destructive: true,
                                  }))
                                )
                                  return;
                                try {
                                  const r = await assignKioskPin({ clientId: pn.clientId, associateId: pn.associateId });
                                  // Show the fresh number so HR has it even if
                                  // the email can't be delivered.
                                  setShowPin({ associateName: pn.associateName, employeeNumber: r.employeeNumber });
                                  if (pn.associateEmail) {
                                    void emailKioskPin(r.id)
                                      .then(() => toast.success(`Emailed ${pn.associateEmail}.`))
                                      .catch(() => toast.error('Rotated, but the email didn’t send.'));
                                  }
                                  refresh();
                                  onChanged?.();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Rotate failed.');
                                }
                              }}
                              className="gap-1"
                            >
                              <RotateCw className="h-3.5 w-3.5" /> Rotate
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-silver hover:text-alert"
                              onClick={async () => {
                                if (!(await confirm({ title: 'Revoke this employee number?', destructive: true }))) return;
                                try {
                                  await deleteKioskPin(pn.id);
                                  toast.success('Code revoked.');
                                  refresh();
                                  onChanged?.();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                }
                              }}
                            >
                              Revoke
                            </Button>
                          </div>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {filteredRows.length > 150 && (
            <div className="border-t border-navy-secondary px-4 py-2.5 text-xs text-silver">
              Showing the first 150 of {filteredRows.length} — use the search
              box to find anyone else.
            </div>
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
            onChanged?.();
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

function DiagnoseDrawer({
  onClose,
  initialAssociate,
}: {
  onClose: () => void;
  /** Prefill name-mode with this query and run it immediately — the punch
   *  log's per-row "Diagnose" jump for attributed rejects. */
  initialAssociate?: string;
}) {
  const [mode, setMode] = useState<'number' | 'name'>(
    initialAssociate ? 'name' : 'number',
  );
  const [number, setNumber] = useState('');
  const [name, setName] = useState(initialAssociate ?? '');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KioskPinDiagnosis | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Auto-run the prefilled lookup once so "Diagnose" on a rejected punch
  // is one click, not click → retype → click.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!initialAssociate || autoRanRef.current) return;
    autoRanRef.current = true;
    setLoading(true);
    diagnoseKioskPin({ associate: initialAssociate })
      .then(setResult)
      .catch((e) =>
        setErr(e instanceof ApiError ? e.message : 'Diagnosis failed.'),
      )
      .finally(() => setLoading(false));
  }, [initialAssociate]);

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
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      confirmDiscard={() =>
        result === null && (number.length > 0 || name.trim().length > 0)
      }
    >
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
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setMode('number');
              setErr(null);
              setResult(null);
            }}
            className={`flex-1 text-sm ${
              mode === 'number'
                ? 'bg-gold/15 border-gold/60 text-white hover:bg-gold/15 hover:border-gold/60'
                : 'text-silver hover:text-white'
            }`}
          >
            By employee number
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setMode('name');
              setErr(null);
              setResult(null);
            }}
            className={`flex-1 text-sm ${
              mode === 'name'
                ? 'bg-gold/15 border-gold/60 text-white hover:bg-gold/15 hover:border-gold/60'
                : 'text-silver hover:text-white'
            }`}
          >
            By associate name
          </Button>
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
                      ? `clocked in ${fmtDateTime(result.openTimeEntry.clockInAt)}`
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
  const [associateId, setAssociateId] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);

  // Show every associate at the client. The server only allows issuing
  // to ACTIVE (= APPROVED application) associates; the picker reflects
  // that by disabling the others so HR can see who's there and why.
  const directoryQuery = useQuery({
    queryKey: ['directory', clientId, 'picker'],
    queryFn: () => listDirectory({ clientId }),
  });
  const associates = useMemo<PickerEntry[] | null>(() => {
    if (directoryQuery.isError) return [];
    if (!directoryQuery.data) return null;
    return directoryQuery.data.associates.map((a) => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      status: a.status,
    }));
  }, [directoryQuery.data, directoryQuery.isError]);
  // Preselect the associate we were opened for (issuing from a "missing a
  // code" row), if they're eligible; otherwise the first eligible one so
  // HR doesn't have to hunt for a row. Only while nothing is picked yet.
  useEffect(() => {
    if (!associates) return;
    const preset =
      initialAssociateId &&
      associates.find((a) => a.id === initialAssociateId && a.status === 'ACTIVE');
    const pick = preset ? initialAssociateId : associates.find((a) => a.status === 'ACTIVE')?.id;
    if (pick) setAssociateId((cur) => cur || pick);
  }, [associates, initialAssociateId]);

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
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      confirmDiscard={() => pin.length > 0}
    >
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
              <Select
                className="mt-1"
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
              </Select>
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

type ActionFilter =
  | 'ALL'
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'REJECTED';

// Reject reasons are stored as machine strings ('pin_wrong_client_preflight');
// the log shows what they mean. Preflight/punch variants collapse — the
// distinction matters for engineers, not for HR triage.
function humanRejectReason(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason.replace(/_preflight$/, '')) {
    case 'pin_wrong_client':
      return 'Wrong site — PIN is under another client';
    case 'pin_not_recognized':
      return 'Unrecognized PIN';
    case 'associate_inactive':
      return 'Inactive associate';
    default:
      return reason;
  }
}

// One punch-log row, memoized: "Load more" appends to an accumulating
// list, and without this every already-rendered row re-renders on each
// page (and on every unrelated state change in the tab).
// "Load more" accumulates rows in memory with no upper bound; past this
// many the DOM (not the network) is the bottleneck. CSV export walks the
// cursor server-side for anything older.
const LOG_CAP = 600;

function LogTab() {
  // Bumped by the error-state Retry button to re-run the first-page load.
  const [reloadKey, setReloadKey] = useState(0);
  // "Diagnose" jump from an attributed rejected row — opens the same
  // drawer as the Pins tab, prefilled and auto-run.
  const [diagnoseFor, setDiagnoseFor] = useState<string | null>(null);

  // All filters are server-side, so they search ALL history through cursor
  // pagination — not just one loaded page. (Earlier this filtered a single
  // 500-row page client-side, which silently missed anything older.)
  //
  // They also live in the URL (seeded below, replace-written on change) so
  // a triage state is linkable — "look at the wrong-site rejects on this
  // device" pastes as one link, and the fleet email can deep-link straight
  // into a filtered log. Same convention as AdminTimeView's ?from=&to=.
  const [urlParams, setUrlParams] = useSearchParams();
  const [associate, setAssociate] = useState<{ id: string; name: string } | null>(
    () => {
      const id = urlParams.get('associateId');
      return id ? { id, name: urlParams.get('associateName') ?? 'Associate' } : null;
    },
  );
  const [deviceId, setDeviceId] = useState(urlParams.get('device') ?? '');
  const [action, setAction] = useState<ActionFilter>(() => {
    const a = urlParams.get('action');
    return a === 'CLOCK_IN' || a === 'CLOCK_OUT' || a === 'BREAK_START' ||
      a === 'BREAK_END' || a === 'REJECTED'
      ? a
      : 'ALL';
  });
  const [range, setRange] = useState<'all' | 'today' | '7d' | '30d'>(() => {
    const r = urlParams.get('range');
    return r === 'today' || r === '7d' || r === '30d' ? r : 'all';
  });
  const [anomaliesOnly, setAnomaliesOnly] = useState(
    urlParams.get('anomalies') === '1',
  );
  const [rejectGroup, setRejectGroup] = useState<'' | KioskRejectGroup>(() => {
    const g = urlParams.get('reason');
    return g === 'wrong_client' || g === 'not_recognized' || g === 'inactive'
      ? g
      : '';
  });

  // State → URL. Replace-writes (no history stacking), preserving ?tab=.
  useEffect(() => {
    const next = new URLSearchParams(urlParams);
    const setOrDel = (k: string, v: string) => {
      if (v) next.set(k, v);
      else next.delete(k);
    };
    setOrDel('associateId', associate?.id ?? '');
    setOrDel('associateName', associate?.name ?? '');
    setOrDel('device', deviceId);
    setOrDel('action', action === 'ALL' ? '' : action);
    setOrDel('range', range === 'all' ? '' : range);
    setOrDel('anomalies', anomaliesOnly ? '1' : '');
    setOrDel('reason', rejectGroup);
    if (next.toString() !== urlParams.toString()) {
      setUrlParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [associate, deviceId, action, range, anomaliesOnly, rejectGroup]);

  const PAGE = 100;
  const queryParams = (cursor?: string) => ({
    associateId: associate?.id,
    deviceId: deviceId || undefined,
    action: action === 'ALL' ? undefined : action,
    rejectGroup: rejectGroup || undefined,
    anomaliesOnly: anomaliesOnly || undefined,
    from: rangeFrom(range),
    cursor,
    limit: PAGE,
  });

  // Every filter is part of the key, so a filter change is a fresh first
  // page and a "Load more" still in flight for the old filters lands in
  // the old entry, never spliced onto the new list.
  const log = useInfiniteQuery({
    queryKey: [
      'kiosk',
      'punches',
      'log',
      { associateId: associate?.id, deviceId, action, range, anomaliesOnly, rejectGroup },
      reloadKey,
    ],
    queryFn: ({ pageParam }) => listKioskPunches(queryParams(pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo<KioskPunchSummary[] | null>(() => {
    if (!log.data) return null;
    const all = log.data.pages.flatMap((p) => p.punches);
    // On-screen cap — anything past it is CSV-export territory.
    return all.length > LOG_CAP ? all.slice(0, LOG_CAP) : all;
  }, [log.data]);
  const loadError = log.isError && !log.data;
  const hasMore = Boolean(log.hasNextPage);
  const loadingMore = log.isFetchingNextPage;

  // Device dropdown options — the same query the Devices tab reads.
  const devicesQuery = useQuery({
    queryKey: ['kiosk', 'devices'],
    queryFn: () => listKioskDevices(),
  });
  const devices = useMemo(
    () => (devicesQuery.data?.devices ?? []).map((d) => ({ id: d.id, name: d.name })),
    [devicesQuery.data],
  );

  const atCap = rows !== null && rows.length >= LOG_CAP;

  const loadMore = () => {
    if (!hasMore || loadingMore || atCap) return;
    void log.fetchNextPage().then((r) => {
      if (r.isError) toast.error('Could not load more punches — try again.');
    });
  };

  // CSV export of the CURRENT filters — walks the cursor server-side so it
  // covers all matching history, not just the rows loaded on screen. The
  // payroll-dispute artifact: filter to an associate + date range, export,
  // attach. Capped at 10k rows so a runaway all-history export can't hang
  // the tab; the toast says when the cap was hit.
  const [exporting, setExporting] = useState(false);
  const EXPORT_CAP = 10_000;
  // The export walks pages at the server's max (500), not the on-screen
  // page size (100) — a capped export is 20 round-trips instead of 100.
  const EXPORT_PAGE = 500;
  const EXPORT_TOAST_ID = 'kiosk-punch-export';
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const all: KioskPunchSummary[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await listKioskPunches({
          ...queryParams(cursor),
          limit: EXPORT_PAGE,
        });
        pages += 1;
        all.push(...r.punches);
        cursor = r.nextCursor ?? undefined;
        toast.loading(
          `Exporting… ${pages} page${pages === 1 ? '' : 's'} fetched (${all.length} punches)`,
          { id: EXPORT_TOAST_ID },
        );
      } while (cursor && all.length < EXPORT_CAP);

      const esc = (v: unknown) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        'When (ISO)',
        'Device',
        'Associate',
        'Action',
        'Distance (m)',
        'Face distance',
        'Face mismatch',
        'Anomaly',
        'Anomaly detail',
        'Review status',
        'Review notes',
        'Reject reason',
        'Punch ID',
      ];
      const lines = [header.join(',')];
      for (const p of all) {
        lines.push(
          [
            p.createdAt,
            p.deviceName,
            p.associateName ?? '',
            p.action,
            p.distanceMeters ?? '',
            p.faceDistance ?? '',
            p.faceMismatch ?? '',
            p.anomalyKind ?? '',
            p.anomalyDetail ?? '',
            p.reviewStatus ?? '',
            p.reviewNotes ?? '',
            p.rejectReason ?? '',
            p.id,
          ]
            .map(esc)
            .join(','),
        );
      }
      // BOM so Excel detects UTF-8 (associate names with accents).
      const blob = new Blob(['﻿' + lines.join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kiosk-punches-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // Same id as the progress toast so it replaces it in place.
      toast.success(
        `Exported ${all.length} punch${all.length === 1 ? '' : 'es'}${
          cursor
            ? ` (capped at ${EXPORT_CAP} — narrow the date range for the rest)`
            : ''
        }.`,
        { id: EXPORT_TOAST_ID },
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Export failed.', {
        id: EXPORT_TOAST_ID,
      });
    } finally {
      setExporting(false);
    }
  };

  const hasFilters =
    !!associate ||
    !!deviceId ||
    action !== 'ALL' ||
    range !== 'all' ||
    anomaliesOnly ||
    rejectGroup !== '';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px]">
          <AssociatePicker
            value={associate}
            onChange={setAssociate}
            placeholder="Filter by associate"
          />
        </div>
        <Select
          size="sm"
          className="h-9 w-auto"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        >
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select
          size="sm"
          className="h-9 w-auto"
          value={action}
          onChange={(e) => setAction(e.target.value as ActionFilter)}
        >
          <option value="ALL">All actions</option>
          <option value="CLOCK_IN">Clock in</option>
          <option value="CLOCK_OUT">Clock out</option>
          <option value="BREAK_START">Break start</option>
          <option value="BREAK_END">Break end</option>
          <option value="REJECTED">Rejected</option>
        </Select>
        <Select
          size="sm"
          className="h-9 w-auto"
          value={rejectGroup}
          onChange={(e) => setRejectGroup(e.target.value as '' | KioskRejectGroup)}
          aria-label="Filter by reject reason"
        >
          <option value="">Any reject reason</option>
          <option value="wrong_client">Wrong site (PIN under another client)</option>
          <option value="not_recognized">Unrecognized PIN</option>
          <option value="inactive">Inactive associate</option>
        </Select>
        <Select
          size="sm"
          className="h-9 w-auto"
          value={range}
          onChange={(e) => setRange(e.target.value as typeof range)}
        >
          <option value="all">Any time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAssociate(null);
              setDeviceId('');
              setAction('ALL');
              setRange('all');
              setAnomaliesOnly(false);
              setRejectGroup('');
            }}
            // h-9 keeps it flush with the h-9 filter selects beside it.
            className="h-9 px-2 text-sm"
          >
            Clear
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void exportCsv()}
          disabled={exporting || rows === null || rows.length === 0}
          className="h-9 gap-1 text-sm text-silver hover:text-white"
          title="Download everything matching the current filters as CSV"
        >
          <Download className="h-3.5 w-3.5" />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
        <div className="ml-auto text-xs text-silver">
          {rows ? `${rows.length} loaded${hasMore ? '+' : ''}` : ''}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Couldn't load the punch log.</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setReloadKey((k) => k + 1)}
                  >
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            </div>
          ) : rows === null ? (
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
            <DataGrid<(typeof rows)[number]>
              id="kiosk-punch-log"
              caption="Kiosk punch log"
              rows={rows}
              rowKey={(pu) => pu.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'kiosk-punches' }}
              columns={[
                { key: 'when', header: 'When', accessor: (pu) => pu.createdAt, sortable: true, searchable: false, primary: true, cell: (pu) => fmtDateTime(pu.createdAt) },
                { key: 'device', header: 'Device', accessor: (pu) => pu.deviceName, sortable: true, cardMeta: true, className: 'font-mono text-xs' },
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (pu) => pu.associateName,
                  sortable: true,
                  cardMeta: true,
                  cell: (pu) => (pu.associateId && pu.associateName ? <AssociateLink associateId={pu.associateId}>{pu.associateName}</AssociateLink> : (pu.associateName ?? '—')),
                },
                {
                  key: 'action',
                  header: 'Action',
                  accessor: (pu) => pu.action,
                  sortable: true,
                  cardMeta: true,
                  cell: (pu) => (
                    <Badge variant={pu.action === 'CLOCK_IN' ? 'success' : pu.action === 'CLOCK_OUT' ? 'accent' : pu.action === 'BREAK_START' || pu.action === 'BREAK_END' ? 'pending' : 'destructive'}>
                      {pu.action}
                    </Badge>
                  ),
                },
                { key: 'distance', header: 'Distance', accessor: (pu) => pu.distanceMeters, csv: (pu) => (pu.distanceMeters != null ? `${pu.distanceMeters}m` : ''), sortable: true, searchable: false, className: 'text-xs', cell: (pu) => (pu.distanceMeters != null ? `${pu.distanceMeters}m` : '—') },
                {
                  key: 'face',
                  header: 'Face',
                  accessor: (pu) => (pu.faceDistance == null ? null : pu.faceMismatch ? `Mismatch (${pu.faceDistance.toFixed(2)})` : `Match (${pu.faceDistance.toFixed(2)})`),
                  sortable: true,
                  searchable: false,
                  className: 'text-xs',
                  cell: (pu) =>
                    pu.faceDistance == null ? '—' : pu.faceMismatch ? <Badge variant="destructive">Mismatch ({pu.faceDistance.toFixed(2)})</Badge> : <Badge variant="success">Match ({pu.faceDistance.toFixed(2)})</Badge>,
                },
                {
                  key: 'selfie',
                  header: 'Selfie',
                  accessor: (pu) => (pu.hasSelfie ? 'yes' : null),
                  searchable: false,
                  stopRowClick: true,
                  cell: (pu) =>
                    pu.hasSelfie ? (
                      <a href={`/api/kiosk-punches/${pu.id}/selfie`} target="_blank" rel="noreferrer" className="text-gold hover:text-gold-bright underline underline-offset-2 text-xs">
                        view
                      </a>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'reason',
                  header: 'Reason',
                  accessor: (pu) => (pu.action === 'REJECTED' ? (humanRejectReason(pu.rejectReason) ?? null) : pu.rejectReason),
                  className: 'text-xs text-silver',
                  stopRowClick: true,
                  cell: (pu) =>
                    pu.action === 'REJECTED' ? (
                      <div className="flex items-center gap-2">
                        <span className={pu.rejectReason ? 'text-warning' : ''}>{humanRejectReason(pu.rejectReason) ?? '—'}</span>
                        {pu.associateName && (
                          <Button variant="ghost" size="xs" className="gap-1 text-silver hover:text-white" onClick={() => setDiagnoseFor(pu.associateName!)} title="Look up this associate's PIN and where it's filed">
                            <Stethoscope className="h-3 w-3" /> Diagnose
                          </Button>
                        )}
                      </div>
                    ) : (
                      (pu.rejectReason ?? '')
                    ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {diagnoseFor && (
        <DiagnoseDrawer
          initialAssociate={diagnoseFor}
          onClose={() => setDiagnoseFor(null)}
        />
      )}
      {hasMore && rows && rows.length > 0 && (
        atCap ? (
          <div className="text-center text-xs text-silver">
            Showing the first {LOG_CAP} punches — refine filters or use CSV
            export for older punches.
          </div>
        ) : (
          <div className="flex justify-center">
            <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )
      )}
    </div>
  );
}

function FacesTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const facesQuery = useQuery({
    queryKey: ['kiosk', 'faces'],
    queryFn: () => listKioskFaceReferences(),
  });
  const rows: KioskFaceReferenceSummary[] | null = facesQuery.data?.references ?? null;
  const loadError = facesQuery.isError;
  const refresh = () => void facesQuery.refetch();

  return (
    <Card>
      <CardContent className="p-0">
        {loadError ? (
          <div className="p-6">
            <ErrorBanner>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Couldn't load face references.</span>
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          </div>
        ) : rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScanFace}
            title="No face references"
            description="The first kiosk punch with face matching enabled enrolls each associate automatically."
          />
        ) : (
          <DataGrid<NonNullable<typeof rows>[number]>
            id="kiosk-face-templates"
            caption="Enrolled face templates"
            rows={rows}
            rowKey={(r) => r.id}
            search={{ placeholder: 'Name, email…' }}
            urlState={false}
            exportCsv={{ filename: 'face-templates' }}
            columns={[
              { key: 'associate', header: 'Associate', accessor: (r) => r.associateName, sortable: true, primary: true, className: 'font-medium text-white' },
              { key: 'email', header: 'Email', accessor: (r) => r.associateEmail, sortable: true, cardMeta: true, className: 'text-silver' },
              { key: 'enrolled', header: 'Enrolled', accessor: (r) => r.enrolledAt, sortable: true, searchable: false, cardMeta: true, className: 'text-xs', cell: (r) => fmtDateTime(r.enrolledAt) },
              { key: 'updated', header: 'Updated', accessor: (r) => r.updatedAt, sortable: true, searchable: false, className: 'text-xs text-silver', cell: (r) => fmtDate(r.updatedAt) },
              ...(canManage
                ? [
                    {
                      key: 'actions',
                      header: 'Actions',
                      accessor: () => null,
                      searchable: false,
                      csv: () => '',
                      align: 'right' as const,
                      stopRowClick: true,
                      cell: (r: NonNullable<typeof rows>[number]) => (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-silver hover:text-alert"
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
                        >
                          Reset
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
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

function ReviewTab({
  canManage,
  onChanged,
}: {
  canManage: boolean;
  onChanged?: () => void;
}) {
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const reviewQuery = useQuery({
    queryKey: ['kiosk', 'punches', 'pending', 'oldest'],
    // Oldest first — HR works the back of the queue down, not the
    // freshest punch first.
    queryFn: () => listKioskPunches({ reviewStatus: 'PENDING', sort: 'oldest' }),
  });
  const rows: KioskPunchSummary[] | null = reviewQuery.data?.punches ?? null;
  const loadError = reviewQuery.isError;
  // The server pages at 500; without this flag a bigger backlog silently
  // masquerades as "all of it".
  const truncated = Boolean(reviewQuery.data?.nextCursor);
  const refresh = () => {
    setSelected(new Set());
    void reviewQuery.refetch();
    onChanged?.();
  };

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
        {loadError ? (
          <div className="p-6">
            <ErrorBanner>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Couldn't load the review queue.</span>
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          </div>
        ) : rows === null ? (
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
                    ? `${rows.length} flagged${truncated ? ' (oldest 500 — more behind)' : ''}`
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
            <DataGrid<(typeof rows)[number]>
              id="kiosk-flagged-punches"
              caption="Punches flagged for review"
              rows={rows}
              rowKey={(pu) => pu.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'flagged-punches' }}
              selectable={canManage ? { selectAllLabel: 'Select all flagged punches', selection: { selected, onChange: setSelected } } : undefined}
              columns={[
                { key: 'when', header: 'When', accessor: (pu) => pu.createdAt, sortable: true, searchable: false, cardMeta: true, className: 'text-xs', cell: (pu) => fmtDateTime(pu.createdAt) },
                { key: 'aging', header: 'Aging', accessor: (pu) => pu.createdAt, sortable: true, searchable: false, cell: (pu) => renderPendingBadge(pu.createdAt) },
                {
                  key: 'associate',
                  header: 'Associate',
                  accessor: (pu) => pu.associateName,
                  sortable: true,
                  primary: true,
                  className: 'font-medium text-white',
                  cell: (pu) => (pu.associateId && pu.associateName ? <AssociateLink associateId={pu.associateId}>{pu.associateName}</AssociateLink> : (pu.associateName ?? '—')),
                },
                { key: 'device', header: 'Device', accessor: (pu) => pu.deviceName, sortable: true, className: 'text-xs' },
                { key: 'action', header: 'Action', accessor: (pu) => pu.action, sortable: true, cardMeta: true, cell: (pu) => <Badge variant={pu.action === 'CLOCK_IN' ? 'success' : 'accent'}>{pu.action}</Badge> },
                {
                  key: 'reason',
                  header: 'Reason',
                  accessor: (pu) =>
                    pu.anomalyKind === 'IMPOSSIBLE_TRAVEL' ? 'Impossible travel' : pu.anomalyKind === 'FACE_MISMATCH' ? 'Face mismatch' : pu.anomalyKind === 'GEOFENCE' ? 'Outside geofence' : pu.anomalyKind === 'FACE_ENROLLMENT' ? 'New face enrolled' : (pu.rejectReason ?? 'Anomaly'),
                  sortable: true,
                  cardMeta: true,
                  className: 'text-xs text-warning',
                  cell: (pu) => (
                    <>
                      <div className="font-medium">
                        {pu.anomalyKind === 'IMPOSSIBLE_TRAVEL' ? 'Impossible travel' : pu.anomalyKind === 'FACE_MISMATCH' ? 'Face mismatch' : pu.anomalyKind === 'GEOFENCE' ? 'Outside geofence' : pu.anomalyKind === 'FACE_ENROLLMENT' ? 'New face enrolled' : (pu.rejectReason ?? 'Anomaly')}
                      </div>
                      {pu.anomalyDetail && <div className="text-silver">{pu.anomalyDetail}</div>}
                    </>
                  ),
                },
                {
                  key: 'selfie',
                  header: 'Selfie',
                  accessor: (pu) => (pu.hasSelfie ? 'yes' : null),
                  searchable: false,
                  stopRowClick: true,
                  cell: (pu) =>
                    pu.hasSelfie ? (
                      <a href={`/api/kiosk-punches/${pu.id}/selfie`} target="_blank" rel="noreferrer">
                        <img src={`/api/kiosk-punches/${pu.id}/selfie`} alt="selfie" className="w-12 h-12 rounded object-cover border border-navy-secondary" />
                      </a>
                    ) : (
                      '—'
                    ),
                },
                ...(canManage
                  ? [
                      {
                        key: 'decision',
                        header: 'Decision',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        className: 'space-x-2',
                        cell: (pu: (typeof rows)[number]) => (
                          <>
                            <Button size="sm" variant="ghost" disabled={busy === pu.id || bulkBusy} onClick={() => void decide(pu.id, 'APPROVED')}>
                              Approve
                            </Button>
                            <Button size="sm" variant="destructive" disabled={busy === pu.id || bulkBusy} onClick={() => void decide(pu.id, 'REJECTED')}>
                              Reject
                            </Button>
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
