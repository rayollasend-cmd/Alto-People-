import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import {
  createOshaIncident,
  createWcClassCode,
  get300A,
  getEeoReport,
  listOshaIncidents,
  listWcClassCodes,
  type OshaIncident,
  type OshaSeverity,
  type WcClassCode,
} from '@/lib/oshaWcEeoApi';
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
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'osha' | 'wc' | 'eeo';

export function OshaWcEeoHome() {
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [clientId, setClientId] = useState('');
  const [tab, setTab] = useState<Tab>('osha');

  useEffect(() => {
    listClients()
      .then((r) => {
        setClients(r.clients);
        if (!clientId && r.clients.length > 0) setClientId(r.clients[0].id);
      })
      .catch(() => {});
  }, [clientId]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="OSHA · WC · EEO-1"
        subtitle="OSHA injury log, Workers' Comp class codes, and EEO-1 race/gender/category reporting."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'OSHA · WC · EEO' }]}
      />
      <Card>
        <CardContent className="p-4 flex items-center gap-3">
          <span className="text-[11px] uppercase tracking-wider text-silver">Client</span>
          <select
            className="flex h-9 rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.length === 0 && <option value="">—</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="osha">OSHA log</TabsTrigger>
          <TabsTrigger value="wc">WC class codes</TabsTrigger>
          <TabsTrigger value="eeo">EEO-1 report</TabsTrigger>
        </TabsList>
        <TabsContent value="osha">
          {clientId && <OshaTab clientId={clientId} />}
        </TabsContent>
        <TabsContent value="wc"><WcTab /></TabsContent>
        <TabsContent value="eeo">
          {clientId && <EeoTab clientId={clientId} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ OSHA ============

const SEVERITY_COLOR: Record<OshaSeverity, 'default' | 'pending' | 'destructive'> = {
  FIRST_AID: 'default',
  MEDICAL_TREATMENT: 'pending',
  RESTRICTED_DUTY: 'pending',
  DAYS_AWAY: 'destructive',
  FATAL: 'destructive',
};

function OshaTab({ clientId }: { clientId: string }) {
  const [rows, setRows] = useState<OshaIncident[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof get300A>> | null>(null);

  const refresh = () => {
    setRows(null);
    listOshaIncidents(clientId)
      .then((r) => setRows(r.incidents))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
    get300A(clientId, year).then(setSummary).catch(() => setSummary(null));
  }, [clientId, year]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-silver">Form 300A summary</div>
              <div className="mt-2 grid grid-cols-3 md:grid-cols-7 gap-3 text-sm">
                <Stat label="Total cases" value={summary?.totalCases ?? '—'} />
                <Stat label="Fatalities" value={summary?.fatalities ?? '—'} />
                <Stat label="Days-away cases" value={summary?.daysAwayCases ?? '—'} />
                <Stat label="Restricted-duty cases" value={summary?.restrictedCases ?? '—'} />
                <Stat label="Other recordable" value={summary?.otherRecordable ?? '—'} />
                <Stat label="Days away total" value={summary?.totalDaysAway ?? '—'} />
                <Stat label="Days restricted total" value={summary?.totalDaysRestricted ?? '—'} />
              </div>
            </div>
            <div>
              <Label>Year</Label>
              <Input
                className="mt-1 w-24"
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || year)}
              />
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> Report incident
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No OSHA incidents"
              description="Workplace injuries get logged here for the OSHA 300 / 300A annual filings."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Associate</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Body part</TableHead>
                  <TableHead>Days away</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{new Date(i.occurredAt).toLocaleDateString()}</TableCell>
                    <TableCell>{i.associateName ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={SEVERITY_COLOR[i.severity]}>{i.severity}</Badge>
                    </TableCell>
                    <TableCell>{i.bodyPart ?? '—'}</TableCell>
                    <TableCell>{i.daysAway}</TableCell>
                    <TableCell>
                      <Badge variant={i.status === 'RESOLVED' ? 'success' : 'pending'}>
                        {i.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewIncidentDrawer
          clientId={clientId}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-silver">{label}</div>
      <div className="mt-0.5 text-white font-medium">{value}</div>
    </div>
  );
}

function NewIncidentDrawer({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [bodyPart, setBodyPart] = useState('');
  const [severity, setSeverity] = useState<OshaSeverity>('FIRST_AID');
  const [daysAway, setDaysAway] = useState('0');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!description.trim()) {
      toast.error('Description required.');
      return;
    }
    if (!occurredAt) {
      toast.error('Occurred-at datetime required.');
      return;
    }
    setSaving(true);
    try {
      await createOshaIncident({
        clientId,
        associateId: associateId.trim() || null,
        occurredAt: new Date(occurredAt).toISOString(),
        location: location.trim() || null,
        description: description.trim(),
        bodyPart: bodyPart.trim() || null,
        severity,
        daysAway: Number(daysAway) || 0,
      });
      toast.success('Incident logged.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>Report OSHA incident</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID (optional)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>Occurred at</Label>
          <Input
            className="mt-1"
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
        </div>
        <div>
          <Label>Location</Label>
          <Input className="mt-1" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Label>Body part affected</Label>
          <Input className="mt-1" value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} />
        </div>
        <div>
          <Label>Severity</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as OshaSeverity)}
          >
            {(['FIRST_AID', 'MEDICAL_TREATMENT', 'RESTRICTED_DUTY', 'DAYS_AWAY', 'FATAL'] as const).map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </div>
        <div>
          <Label>Days away from work</Label>
          <Input
            className="mt-1"
            type="number"
            min="0"
            value={daysAway}
            onChange={(e) => setDaysAway(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Log incident'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ============ Workers' Comp ============

function WcTab() {
  const [rows, setRows] = useState<WcClassCode[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listWcClassCodes()
      .then((r) => setRows(r.codes))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New code
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No WC class codes"
              description="Add NCCI / state-specific class codes and rates per $100 of payroll."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Rate / $100</TableHead>
                  <TableHead>Effective</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.stateCode ?? 'FED'}</TableCell>
                    <TableCell className="font-mono">{c.code}</TableCell>
                    <TableCell>{c.description}</TableCell>
                    <TableCell>${c.ratePer100}</TableCell>
                    <TableCell>
                      {c.effectiveFrom}
                      {c.effectiveTo ? ` – ${c.effectiveTo}` : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && <NewWcDrawer onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refresh(); }} />}
    </div>
  );
}

function NewWcDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [stateCode, setStateCode] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [ratePer100, setRate] = useState('');
  const [effectiveFrom, setFrom] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!code.trim() || !description.trim() || !effectiveFrom) {
      toast.error('Code, description, and effective-from required.');
      return;
    }
    setSaving(true);
    try {
      await createWcClassCode({
        stateCode: stateCode.trim().toUpperCase() || null,
        code: code.trim(),
        description: description.trim(),
        ratePer100: Number(ratePer100) || 0,
        effectiveFrom,
      });
      toast.success('Code added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New WC class code</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>State (2 letters; blank = federal)</Label>
          <Input
            className="mt-1"
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value.slice(0, 2).toUpperCase())}
            placeholder="CA"
          />
        </div>
        <div>
          <Label>Code</Label>
          <Input
            className="mt-1 font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="8810"
          />
        </div>
        <div>
          <Label>Description</Label>
          <Input
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Clerical office employees"
          />
        </div>
        <div>
          <Label>Rate per $100 of payroll</Label>
          <Input
            className="mt-1"
            type="number"
            step="0.0001"
            value={ratePer100}
            onChange={(e) => setRate(e.target.value)}
          />
        </div>
        <div>
          <Label>Effective from</Label>
          <Input
            className="mt-1"
            value={effectiveFrom}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="2026-01-01"
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
    </Drawer>
  );
}

// ============ EEO-1 ============

function EeoTab({ clientId }: { clientId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getEeoReport>> | null>(null);
  useEffect(() => {
    setData(null);
    getEeoReport(clientId)
      .then(setData)
      .catch(() => setData(null));
  }, [clientId]);

  if (data === null) {
    return <Card><CardContent className="p-6"><SkeletonRows count={5} /></CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="text-xs uppercase tracking-wider text-silver">
            Active associates with EEO records
          </div>
          <div className="mt-1 text-2xl text-white font-medium">{data.total}</div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {data.buckets.length === 0 ? (
            <EmptyState
              title="No EEO data yet"
              description="Capture self-declared race / gender / category per associate via /eeo/associates/:id."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Race</TableHead>
                  <TableHead>Gender</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.buckets.map((b, i) => (
                  <TableRow key={i}>
                    <TableCell>{b.category}</TableCell>
                    <TableCell>{b.race}</TableCell>
                    <TableCell>{b.gender}</TableCell>
                    <TableCell className="text-right">{b.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
