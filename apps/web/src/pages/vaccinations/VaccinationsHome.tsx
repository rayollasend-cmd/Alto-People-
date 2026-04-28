import { useEffect, useState } from 'react';
import { Plus, Syringe, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createVaccination,
  deleteVaccination,
  getCoverage,
  KIND_LABELS,
  listExpiringSoon,
  listVaccinations,
  type CoverageReport,
  type ExpiringRecord,
  type VaccinationKind,
  type VaccinationRecord,
} from '@/lib/vaccination121Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
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

export function VaccinationsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [tab, setTab] = useState<'all' | 'expiring'>('all');
  const [records, setRecords] = useState<VaccinationRecord[] | null>(null);
  const [expiring, setExpiring] = useState<ExpiringRecord[] | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [filterKind, setFilterKind] = useState<VaccinationKind | 'ALL'>('ALL');

  const refresh = () => {
    setRecords(null);
    listVaccinations({
      kind: filterKind === 'ALL' ? undefined : filterKind,
    })
      .then((r) => setRecords(r.records))
      .catch(() => setRecords([]));
    setExpiring(null);
    listExpiringSoon(60)
      .then((r) => setExpiring(r.records))
      .catch(() => setExpiring([]));
    getCoverage()
      .then(setCoverage)
      .catch(() => setCoverage(null));
  };
  useEffect(() => {
    refresh();
  }, [filterKind]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vaccinations & medical"
        subtitle="Proof of vaccination and TB tests. Required by many client SLAs."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Vaccinations' }]}
      />

      {coverage && (
        <Card>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-silver mb-3">
              Coverage across {coverage.totalAssociates} associates
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {(Object.keys(KIND_LABELS) as VaccinationKind[]).map((k) => (
                <div key={k}>
                  <div className="text-xs text-silver">{KIND_LABELS[k]}</div>
                  <div className="text-xl font-semibold text-white">
                    {coverage.coverage[k].pct}%
                  </div>
                  <div className="text-xs text-silver">
                    {coverage.coverage[k].count} associates
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'all' ? 'primary' : 'ghost'}
            onClick={() => setTab('all')}
          >
            All records
          </Button>
          <Button
            size="sm"
            variant={tab === 'expiring' ? 'primary' : 'ghost'}
            onClick={() => setTab('expiring')}
          >
            Expiring soon
            {expiring && expiring.length > 0 && (
              <Badge variant="destructive" className="ml-2">
                {expiring.length}
              </Badge>
            )}
          </Button>
        </div>
        {canManage && tab === 'all' && (
          <div className="flex gap-2">
            <select
              className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
              value={filterKind}
              onChange={(e) =>
                setFilterKind(e.target.value as VaccinationKind | 'ALL')
              }
            >
              <option value="ALL">All kinds</option>
              {(Object.keys(KIND_LABELS) as VaccinationKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Record
            </Button>
          </div>
        )}
      </div>

      {tab === 'all' ? (
        <Card>
          <CardContent className="p-0">
            {records === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : records.length === 0 ? (
              <EmptyState
                icon={Syringe}
                title="No records"
                description="Add the first vaccination or TB test record."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Dose</TableHead>
                    <TableHead>Administered</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r) => (
                    <TableRow key={r.id} className="group">
                      <TableCell>
                        <div className="font-medium text-white">
                          {r.associateName}
                        </div>
                        <div className="text-xs text-silver">
                          {r.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.kind === 'OTHER' && r.customLabel
                          ? r.customLabel
                          : KIND_LABELS[r.kind]}
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {r.doseNumber}
                        {r.totalDoses ? ` / ${r.totalDoses}` : ''}
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {r.administeredOn}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.expiresOn ? (
                          <span
                            className={
                              new Date(r.expiresOn) < new Date()
                                ? 'text-destructive'
                                : 'text-silver'
                            }
                          >
                            {r.expiresOn}
                          </span>
                        ) : (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage && (
                          <button
                            onClick={async () => {
                              if (!(await confirm({ title: 'Delete this record?', destructive: true }))) return;
                              try {
                                await deleteVaccination(r.id);
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Failed.',
                                );
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
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
      ) : (
        <Card>
          <CardContent className="p-0">
            {expiring === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : expiring.length === 0 ? (
              <EmptyState
                icon={Syringe}
                title="Nothing expiring soon"
                description="Everyone's records are current for the next 60 days."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Days</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expiring.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium text-white">
                        {r.associateName}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.kind === 'OTHER' && r.customLabel
                          ? r.customLabel
                          : KIND_LABELS[r.kind]}
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {r.expiresOn}
                      </TableCell>
                      <TableCell>
                        {r.overdue ? (
                          <Badge variant="destructive">
                            {Math.abs(r.daysUntil)}d overdue
                          </Badge>
                        ) : r.daysUntil <= 14 ? (
                          <Badge variant="accent">{r.daysUntil}d</Badge>
                        ) : (
                          <Badge variant="pending">{r.daysUntil}d</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && (
        <NewRecordDrawer
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

function NewRecordDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [kind, setKind] = useState<VaccinationKind>('COVID19');
  const [customLabel, setCustomLabel] = useState('');
  const [doseNumber, setDoseNumber] = useState('1');
  const [totalDoses, setTotalDoses] = useState('');
  const [administeredOn, setAdministeredOn] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [administeredBy, setAdministeredBy] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    if (kind === 'OTHER' && !customLabel.trim()) {
      toast.error('Custom label required for OTHER.');
      return;
    }
    setSaving(true);
    try {
      await createVaccination({
        associateId: associateId.trim(),
        kind,
        customLabel: kind === 'OTHER' ? customLabel.trim() : null,
        doseNumber: parseInt(doseNumber, 10) || 1,
        totalDoses: totalDoses ? parseInt(totalDoses, 10) : null,
        administeredOn,
        administeredBy: administeredBy.trim() || null,
        manufacturer: manufacturer.trim() || null,
        lotNumber: lotNumber.trim() || null,
        documentUrl: documentUrl.trim() || null,
        expiresOn: expiresOn || null,
        notes: notes.trim() || null,
      });
      toast.success('Recorded.');
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
        <DrawerTitle>New vaccination record</DrawerTitle>
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
            onChange={(e) => setKind(e.target.value as VaccinationKind)}
          >
            {(Object.keys(KIND_LABELS) as VaccinationKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {kind === 'OTHER' && (
          <div>
            <Label>Custom label</Label>
            <Input
              className="mt-1"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="e.g. Yellow fever"
            />
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>Dose</Label>
            <Input
              type="number"
              min="1"
              max="20"
              className="mt-1"
              value={doseNumber}
              onChange={(e) => setDoseNumber(e.target.value)}
            />
          </div>
          <div>
            <Label>Of</Label>
            <Input
              type="number"
              min="1"
              max="20"
              className="mt-1"
              value={totalDoses}
              onChange={(e) => setTotalDoses(e.target.value)}
              placeholder="—"
            />
          </div>
          <div>
            <Label>Administered</Label>
            <Input
              type="date"
              className="mt-1"
              value={administeredOn}
              onChange={(e) => setAdministeredOn(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Manufacturer</Label>
            <Input
              className="mt-1"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              placeholder="Pfizer, Moderna…"
            />
          </div>
          <div>
            <Label>Lot #</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Administered by</Label>
            <Input
              className="mt-1"
              value={administeredBy}
              onChange={(e) => setAdministeredBy(e.target.value)}
              placeholder="Provider/clinic"
            />
          </div>
          <div>
            <Label>Expires</Label>
            <Input
              type="date"
              className="mt-1"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Proof URL</Label>
          <Input
            type="url"
            className="mt-1"
            value={documentUrl}
            onChange={(e) => setDocumentUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div>
          <Label>Notes</Label>
          <textarea
            className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
