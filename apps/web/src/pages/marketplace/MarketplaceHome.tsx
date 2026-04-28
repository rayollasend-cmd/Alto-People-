import { useEffect, useState } from 'react';
import { Award, Briefcase } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  claimShift,
  createQualification,
  deleteQualification,
  listOpenShifts,
  listPendingClaims,
  listQualifications,
  updateClaim,
  type OpenShiftListItem,
  type PendingClaim,
  type Qualification,
} from '@/lib/qualApi';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
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

type Tab = 'open' | 'claims' | 'catalog';

export function MarketplaceHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:scheduling') : false;
  const [tab, setTab] = useState<Tab>(canManage ? 'claims' : 'open');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Open shifts"
        subtitle="Marketplace of OPEN shifts you're qualified to pick up. Managers approve claims."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Open shifts' }]}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="open">Available</TabsTrigger>
          {canManage && <TabsTrigger value="claims">Pending claims</TabsTrigger>}
          {canManage && <TabsTrigger value="catalog">Qualifications</TabsTrigger>}
        </TabsList>

        <TabsContent value="open"><AvailableTab /></TabsContent>
        {canManage && (
          <TabsContent value="claims"><ClaimsTab /></TabsContent>
        )}
        {canManage && (
          <TabsContent value="catalog"><CatalogTab /></TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ============ Available shifts ============

function AvailableTab() {
  const [rows, setRows] = useState<OpenShiftListItem[] | null>(null);
  const refresh = () => {
    setRows(null);
    listOpenShifts()
      .then((r) => setRows(r.shifts))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onClaim = async (shiftId: string) => {
    try {
      await claimShift(shiftId);
      toast.success('Claim submitted; awaiting manager approval.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  if (rows === null) {
    return <Card><CardContent className="p-6"><SkeletonRows count={3} /></CardContent></Card>;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No open shifts"
        description="When new shifts get published, ones you're qualified for show up here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((s) => (
        <Card key={s.id}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-white font-medium">{s.position}</div>
                <div className="text-sm text-silver mt-0.5">{s.clientName}</div>
                <div className="text-sm text-silver mt-0.5">
                  {new Date(s.startsAt).toLocaleString()} –{' '}
                  {new Date(s.endsAt).toLocaleTimeString()}
                </div>
                {s.location && (
                  <div className="text-sm text-silver mt-0.5">{s.location}</div>
                )}
                {s.payRate && (
                  <div className="text-sm text-emerald-400 mt-0.5">
                    ${s.payRate}/hr
                  </div>
                )}
                {s.requirements.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {s.requirements.map((r) => (
                      <Badge key={r.id} variant="outline">
                        {r.code}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div>
                {s.myPendingClaim ? (
                  <Badge variant="pending">Claim pending</Badge>
                ) : (
                  <Button onClick={() => onClaim(s.id)}>Claim</Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============ Claims (manager) ============

function ClaimsTab() {
  const [rows, setRows] = useState<PendingClaim[] | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingClaim | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = () => {
    setRows(null);
    listPendingClaims()
      .then((r) => setRows(r.claims))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const approve = async (c: PendingClaim) => {
    setBusyId(c.id);
    try {
      await updateClaim(c.shiftId, c.id, 'APPROVED', null);
      toast.success('Claim approved.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        {rows === null ? (
          <div className="p-6"><SkeletonRows count={3} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No pending claims"
            description="Claims show up here when associates pick up open shifts."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead>Position</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead className="text-right w-44">Decide</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium text-white">
                    {c.associateName}
                  </TableCell>
                  <TableCell>{c.position}</TableCell>
                  <TableCell>{c.clientName}</TableCell>
                  <TableCell>
                    {new Date(c.startsAt).toLocaleString()} –{' '}
                    {new Date(c.endsAt).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => approve(c)}
                        disabled={busyId === c.id}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRejectTarget(c)}
                        disabled={busyId === c.id}
                      >
                        Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject claim"
        description={
          rejectTarget
            ? `Reject ${rejectTarget.associateName}'s claim on ${rejectTarget.position}?`
            : undefined
        }
        confirmLabel="Reject"
        destructive
        requireReason="optional"
        reasonLabel="Reason (visible to associate)"
        reasonPlaceholder="Optional"
        busy={busyId === rejectTarget?.id}
        onConfirm={async (reason) => {
          if (!rejectTarget) return;
          setBusyId(rejectTarget.id);
          try {
            await updateClaim(
              rejectTarget.shiftId,
              rejectTarget.id,
              'REJECTED',
              reason || null,
            );
            toast.success('Claim rejected.');
            setRejectTarget(null);
            refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Failed.');
          } finally {
            setBusyId(null);
          }
        }}
      />
    </Card>
  );
}

// ============ Catalog ============

function CatalogTab() {
  const [rows, setRows] = useState<Qualification[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [isCert, setIsCert] = useState(false);
  const [description, setDescription] = useState('');

  const refresh = () => {
    setRows(null);
    listQualifications()
      .then((r) => setRows(r.qualifications))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onSave = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error('Code and name required.');
      return;
    }
    try {
      await createQualification({
        code: code.trim(),
        name: name.trim(),
        description: description.trim() || null,
        isCert,
      });
      toast.success('Qualification added.');
      setShowNew(false);
      setCode('');
      setName('');
      setIsCert(false);
      setDescription('');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this qualification?')) return;
    try {
      await deleteQualification(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>New qualification</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Award}
              title="No qualifications"
              description="Define the badges, certs, and skills the marketplace can match shifts against."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Cert</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className="w-24 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-mono text-xs">{q.code}</TableCell>
                    <TableCell className="text-white">{q.name}</TableCell>
                    <TableCell>{q.isCert ? <Badge variant="accent">Cert</Badge> : '—'}</TableCell>
                    <TableCell>{q.clientId ? 'Client-scoped' : 'Global'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => onDelete(q.id)}>
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Drawer open={showNew} onOpenChange={setShowNew}>
        <DrawerHeader>
          <DrawerTitle>New qualification</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="space-y-4">
          <div>
            <Label>Code</Label>
            <Input
              className="mt-1 font-mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="FORKLIFT"
            />
          </div>
          <div>
            <Label>Name</Label>
            <Input
              className="mt-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Forklift certification"
            />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input
              className="mt-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-white">
            <input
              type="checkbox"
              checked={isCert}
              onChange={(e) => setIsCert(e.target.checked)}
            />
            This is an expiring certification (drives compliance alerts)
          </label>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={() => setShowNew(false)}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save</Button>
        </DrawerFooter>
      </Drawer>
    </div>
  );
}
