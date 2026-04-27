import { useEffect, useState } from 'react';
import { Copy, Key, Plus, Tablet } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  assignKioskPin,
  createKioskDevice,
  deleteKioskDevice,
  deleteKioskPin,
  listKioskDevices,
  listKioskPins,
  listKioskPunches,
  revokeKioskDevice,
  type KioskDevice,
  type KioskPin,
  type KioskPunchSummary,
} from '@/lib/kiosk99Api';
import { useAuth } from '@/lib/auth';
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
import { toast } from 'sonner';

type Tab = 'devices' | 'pins' | 'log';

export function KioskAdmin() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:time') : false;
  const [tab, setTab] = useState<Tab>('devices');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Kiosk admin"
        subtitle="Register tablets, assign 4-digit PINs to associates, and review the punch log."
        breadcrumbs={[{ label: 'Time' }, { label: 'Kiosk' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="devices">
            <Tablet className="mr-2 h-4 w-4" /> Devices
          </TabsTrigger>
          <TabsTrigger value="pins">
            <Key className="mr-2 h-4 w-4" /> PINs
          </TabsTrigger>
          <TabsTrigger value="log">Punch log</TabsTrigger>
        </TabsList>
        <TabsContent value="devices"><DevicesTab canManage={canManage} /></TabsContent>
        <TabsContent value="pins"><PinsTab canManage={canManage} /></TabsContent>
        <TabsContent value="log"><LogTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function DevicesTab({ canManage }: { canManage: boolean }) {
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

  return (
    <div className="space-y-4">
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
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Punches</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id} className="group">
                    <TableCell className="font-medium text-white">{d.name}</TableCell>
                    <TableCell>{d.clientName}</TableCell>
                    <TableCell>
                      {d.isActive ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="destructive">Revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.lastSeenAt
                        ? new Date(d.lastSeenAt).toLocaleString()
                        : '—'}
                    </TableCell>
                    <TableCell>{d.punchCount}</TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && d.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            if (!window.confirm('Revoke this kiosk? It will stop accepting punches.'))
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
                            if (!window.confirm('Permanently delete?')) return;
                            try {
                              await deleteKioskDevice(d.id);
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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
  const [clientId, setClientId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!clientId || !name.trim()) {
      toast.error('Client ID and name required.');
      return;
    }
    setSaving(true);
    try {
      const r = await createKioskDevice({ clientId: clientId.trim(), name: name.trim() });
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
          <Label>Client ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
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
        <Button onClick={onSubmit} disabled={saving}>
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
        <div className="text-sm text-amber-400">
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

function PinsTab({ canManage }: { canManage: boolean }) {
  const [clientId, setClientId] = useState('');
  const [rows, setRows] = useState<KioskPin[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showPin, setShowPin] = useState<{ associateName: string; pin: string } | null>(
    null,
  );

  const refresh = () => {
    if (!clientId) {
      setRows([]);
      return;
    }
    setRows(null);
    listKioskPins(clientId)
      .then((r) => setRows(r.pins))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-md">
          <Label>Client ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="UUID"
          />
        </div>
        {canManage && clientId && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Assign PIN
          </Button>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {!clientId ? (
            <div className="p-6 text-sm text-silver">
              Enter a client ID to manage PINs.
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No PINs"
              description="Assign a 4-digit PIN to each associate so they can clock in via the kiosk."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id} className="group">
                    <TableCell className="font-medium text-white">
                      {p.associateName}
                    </TableCell>
                    <TableCell className="text-silver">{p.associateEmail}</TableCell>
                    <TableCell>{new Date(p.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <button
                          onClick={async () => {
                            if (!window.confirm('Revoke this PIN?')) return;
                            try {
                              await deleteKioskPin(p.id);
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                        >
                          Revoke
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
        <NewPinDrawer
          clientId={clientId}
          onClose={() => setShowNew(false)}
          onSaved={(associateName, pin) => {
            setShowNew(false);
            setShowPin({ associateName, pin });
            refresh();
          }}
        />
      )}
      {showPin && (
        <Drawer open={true} onOpenChange={(o) => !o && setShowPin(null)}>
          <DrawerHeader>
            <DrawerTitle>PIN assigned</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className="space-y-4 text-center">
            <div className="text-sm text-amber-400">
              Share this PIN with {showPin.associateName}. Shown ONCE.
            </div>
            <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-6 text-6xl font-mono tracking-[0.5em] text-white">
              {showPin.pin}
            </div>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(showPin.pin);
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
    </div>
  );
}

function NewPinDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: (associateName: string, pin: string) => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      toast.error('PIN must be exactly 4 digits, or leave empty to auto-generate.');
      return;
    }
    setSaving(true);
    try {
      const r = await assignKioskPin({
        clientId,
        associateId: associateId.trim(),
        pin: pin || undefined,
      });
      onSaved(associateId.slice(0, 8) + '…', r.pin);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Assign or rotate PIN</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>PIN (optional — leave empty to auto-generate)</Label>
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
          If the associate already has a PIN at this client, this rotates it.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Assign'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function LogTab() {
  const [rows, setRows] = useState<KioskPunchSummary[] | null>(null);

  const refresh = () => {
    setRows(null);
    listKioskPunches()
      .then((r) => setRows(r.punches))
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
            icon={Tablet}
            title="No punches yet"
            description="Once associates start clocking in via kiosk, the audit log appears here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Associate</TableHead>
                <TableHead>Action</TableHead>
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
                            : 'destructive'
                      }
                    >
                      {p.action}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {p.hasSelfie ? (
                      <a
                        href={`/api/kiosk-punches/${p.id}/selfie`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-cyan-400 underline text-xs"
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
  );
}
