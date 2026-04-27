import { useEffect, useState } from 'react';
import { Gavel, Plus, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  acknowledgeDisciplinaryAction,
  issueDisciplinaryAction,
  KIND_LABELS,
  listDisciplinaryActions,
  rescindDisciplinaryAction,
  type DisciplinaryActionRow,
  type DisciplineKind,
  type DisciplineStatus,
} from '@/lib/discipline118Api';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const KIND_VARIANT: Record<
  DisciplineKind,
  'pending' | 'accent' | 'destructive'
> = {
  VERBAL_WARNING: 'pending',
  WRITTEN_WARNING: 'pending',
  FINAL_WARNING: 'accent',
  SUSPENSION: 'destructive',
  TERMINATION: 'destructive',
};

const STATUS_VARIANT: Record<
  DisciplineStatus,
  'success' | 'pending' | 'outline'
> = {
  ACTIVE: 'pending',
  ACKNOWLEDGED: 'success',
  RESCINDED: 'outline',
};

export function DisciplineHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const [rows, setRows] = useState<DisciplinaryActionRow[] | null>(null);
  const [filter, setFilter] = useState<DisciplineStatus | 'ALL'>('ACTIVE');
  const [showNew, setShowNew] = useState(false);
  const [openRow, setOpenRow] = useState<DisciplinaryActionRow | null>(null);

  const refresh = () => {
    setRows(null);
    listDisciplinaryActions({
      status: filter === 'ALL' ? undefined : filter,
    })
      .then((r) => setRows(r.actions))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, [filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Disciplinary actions"
        subtitle="Formal warning ladder. Verbal → written → final → suspension → termination."
        breadcrumbs={[{ label: 'Performance' }, { label: 'Discipline' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['ACTIVE', 'ACKNOWLEDGED', 'RESCINDED', 'ALL'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={filter === s ? 'primary' : 'ghost'}
              onClick={() => setFilter(s)}
            >
              {s}
            </Button>
          ))}
        </div>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> Issue action
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Gavel}
              title="No disciplinary actions"
              description={
                filter === 'ACTIVE'
                  ? 'No active actions. Stay vigilant.'
                  : 'Nothing matches this filter.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Incident</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
                    onClick={() => setOpenRow(a)}
                  >
                    <TableCell>
                      <div className="font-medium text-white">
                        {a.associateName}
                      </div>
                      <div className="text-xs text-silver">{a.associateEmail}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={KIND_VARIANT[a.kind]}>
                        {KIND_LABELS[a.kind]}
                        {a.kind === 'SUSPENSION' && a.suspensionDays
                          ? ` (${a.suspensionDays}d)`
                          : ''}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-silver">
                      {a.incidentDate}
                    </TableCell>
                    <TableCell className="text-sm text-silver">
                      {a.effectiveDate}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[a.status]}>
                        {a.status}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenRow(a)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showNew && (
        <NewActionDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {openRow && (
        <DetailDrawer
          row={openRow}
          canManage={canManage}
          isSubject={user?.associateId === openRow.associateId}
          onClose={() => setOpenRow(null)}
          onChanged={() => {
            setOpenRow(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewActionDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [kind, setKind] = useState<DisciplineKind>('VERBAL_WARNING');
  const today = new Date().toISOString().slice(0, 10);
  const [incidentDate, setIncidentDate] = useState(today);
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [suspensionDays, setSuspensionDays] = useState('1');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim() || !description.trim()) {
      toast.error('Associate ID and description required.');
      return;
    }
    setSaving(true);
    try {
      await issueDisciplinaryAction({
        associateId: associateId.trim(),
        kind,
        incidentDate,
        effectiveDate,
        suspensionDays:
          kind === 'SUSPENSION' ? parseInt(suspensionDays, 10) || null : null,
        description: description.trim(),
        expectedAction: expected.trim() || null,
      });
      toast.success('Action issued.');
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
        <DrawerTitle>Issue disciplinary action</DrawerTitle>
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
          <Label>Kind</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as DisciplineKind)}
          >
            {(Object.keys(KIND_LABELS) as DisciplineKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {kind === 'SUSPENSION' && (
          <div>
            <Label>Suspension days</Label>
            <Input
              type="number"
              min="1"
              max="365"
              className="mt-1"
              value={suspensionDays}
              onChange={(e) => setSuspensionDays(e.target.value)}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Incident date</Label>
            <Input
              type="date"
              className="mt-1"
              value={incidentDate}
              onChange={(e) => setIncidentDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Effective date</Label>
            <Input
              type="date"
              className="mt-1"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>What happened</Label>
          <textarea
            className="mt-1 w-full h-32 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Factual description of the incident…"
          />
        </div>
        <div>
          <Label>Expected change</Label>
          <textarea
            className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            placeholder="Behavior we expect going forward…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Issue'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function DetailDrawer({
  row,
  canManage,
  isSubject,
  onClose,
  onChanged,
}: {
  row: DisciplinaryActionRow;
  canManage: boolean;
  isSubject: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [signature, setSignature] = useState('');
  const [rescindReason, setRescindReason] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{KIND_LABELS[row.kind]} — {row.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={KIND_VARIANT[row.kind]}>{KIND_LABELS[row.kind]}</Badge>
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
          {row.kind === 'SUSPENSION' && row.suspensionDays && (
            <span className="text-sm text-silver">
              {row.suspensionDays} days
            </span>
          )}
        </div>
        <div className="text-xs text-silver">
          Incident: {row.incidentDate} · Effective: {row.effectiveDate}
          {row.issuedByEmail && ` · Issued by ${row.issuedByEmail}`}
        </div>
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wider text-silver">
            What happened
          </div>
          <div className="text-sm text-white whitespace-pre-wrap">
            {row.description}
          </div>
        </div>
        {row.expectedAction && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-silver">
              Expected change
            </div>
            <div className="text-sm text-white whitespace-pre-wrap">
              {row.expectedAction}
            </div>
          </div>
        )}
        {row.acknowledgedAt && (
          <div className="space-y-1 pt-2 border-t border-navy-secondary">
            <div className="text-xs uppercase tracking-wider text-silver">
              Acknowledged
            </div>
            <div className="text-sm text-white">
              {new Date(row.acknowledgedAt).toLocaleString()} —{' '}
              <span className="italic">{row.acknowledgedSig}</span>
            </div>
          </div>
        )}
        {row.rescindedAt && (
          <div className="space-y-1 pt-2 border-t border-navy-secondary">
            <div className="text-xs uppercase tracking-wider text-silver">
              Rescinded
            </div>
            <div className="text-sm text-white">
              {new Date(row.rescindedAt).toLocaleString()}
              {row.rescindedByEmail && ` by ${row.rescindedByEmail}`}
            </div>
            <div className="text-sm text-silver italic">{row.rescindedReason}</div>
          </div>
        )}

        {row.status === 'ACTIVE' && isSubject && (
          <div className="space-y-2 pt-3 border-t border-navy-secondary">
            <Label>Acknowledge with signature</Label>
            <Input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="Type your full name"
            />
            <Button
              size="sm"
              disabled={busy || !signature.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await acknowledgeDisciplinaryAction(row.id, signature.trim());
                  toast.success('Acknowledged.');
                  onChanged();
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              I acknowledge
            </Button>
          </div>
        )}

        {row.status !== 'RESCINDED' && canManage && (
          <div className="space-y-2 pt-3 border-t border-navy-secondary">
            <Label>Rescind reason</Label>
            <textarea
              className="w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
              value={rescindReason}
              onChange={(e) => setRescindReason(e.target.value)}
              placeholder="Why this is being rescinded…"
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || !rescindReason.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await rescindDisciplinaryAction(row.id, rescindReason.trim());
                  toast.success('Rescinded.');
                  onChanged();
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ShieldOff className="mr-2 h-4 w-4" /> Rescind
            </Button>
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
