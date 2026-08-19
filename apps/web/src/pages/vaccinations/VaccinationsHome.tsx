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
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
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
  ErrorBanner,
  Input,
  MetricCard,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';

export function VaccinationsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:compliance') : false;
  const [tab, setTab] = useState<'all' | 'expiring'>('all');
  const [records, setRecords] = useState<VaccinationRecord[] | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [expiring, setExpiring] = useState<ExpiringRecord[] | null>(null);
  const [expiringError, setExpiringError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [coverageFailed, setCoverageFailed] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [filterKind, setFilterKind] = useState<VaccinationKind | 'ALL'>('ALL');
  // One in-flight action at a time — a double-click on Delete used to
  // fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  // Filtered list only — depends on the kind filter.
  const refreshRecords = () => {
    setRecords(null);
    setRecordsError(null);
    listVaccinations({
      kind: filterKind === 'ALL' ? undefined : filterKind,
    })
      .then((r) => setRecords(r.records))
      .catch((err) =>
        setRecordsError(
          err instanceof ApiError ? err.message : 'Could not load records.',
        ),
      );
  };
  // Filter-independent summaries (expiring + coverage) — fetched once on
  // mount and re-fetched explicitly after mutations, never on filter clicks.
  const refreshSummaries = () => {
    setExpiring(null);
    setExpiringError(null);
    listExpiringSoon(60)
      .then((r) => setExpiring(r.records))
      .catch((err) =>
        setExpiringError(
          err instanceof ApiError
            ? err.message
            : 'Could not load expiring records.',
        ),
      );
    getCoverage()
      .then(setCoverage)
      .catch(() => {
        setCoverage(null);
        setCoverageFailed(true);
      });
  };
  const refresh = () => {
    refreshRecords();
    refreshSummaries();
  };
  useEffect(() => {
    refreshRecords();
  }, [filterKind]);
  useEffect(() => {
    refreshSummaries();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Vaccinations & medical"
        subtitle="Proof of vaccination and TB tests. Required by many client SLAs."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Vaccinations' }]}
      />

      {/* Reserve the strip while loading; note failure instead of quietly
          vanishing (an absent row read as "no coverage data exists"). */}
      {!coverage && !coverageFailed && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-lg" />
          ))}
        </div>
      )}
      {coverageFailed && !coverage && (
        <p className="text-xs text-silver/70">
          Couldn&apos;t load coverage — the records below are unaffected.
        </p>
      )}
      {coverage && (
        <div className="space-y-2">
          <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
            Coverage across {coverage.totalAssociates} associates
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {(Object.keys(KIND_LABELS) as VaccinationKind[]).map((k) => (
              <MetricCard
                key={k}
                label={KIND_LABELS[k]}
                value={`${coverage.coverage[k].pct}%`}
                hint={`${coverage.coverage[k].count} associates`}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <SegmentedControl
          ariaLabel="Vaccination view"
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: 'all' as const, label: 'All records' },
            {
              value: 'expiring' as const,
              label: (
                <span className="inline-flex items-center gap-2">
                  Expiring soon
                  {expiring && expiring.length > 0 && (
                    <Badge variant="destructive" size="sm">
                      {expiring.length}
                    </Badge>
                  )}
                </span>
              ),
            },
          ]}
        />
        {canManage && tab === 'all' && (
          <div className="flex gap-2">
            <Select
              size="sm"
              aria-label="Filter by kind"
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
            </Select>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Record
            </Button>
          </div>
        )}
      </div>

      {tab === 'all' ? (
        <Card>
          <CardContent className="p-0">
            {recordsError ? (
              <div className="p-6">
                <ErrorBanner
                  action={
                    <Button size="sm" variant="secondary" onClick={refreshRecords}>
                      Retry
                    </Button>
                  }
                >
                  {recordsError}
                </ErrorBanner>
              </div>
            ) : records === null ? (
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
                    <TableHead className="hidden lg:table-cell">Dose</TableHead>
                    <TableHead className="hidden md:table-cell">Administered</TableHead>
                    <TableHead className="hidden md:table-cell">Expires</TableHead>
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
                        <div className="text-xs2 text-silver/70 md:hidden">
                          {fmtDate(parseYmd(r.administeredOn))}
                          {r.expiresOn
                            ? ` · exp ${fmtDate(parseYmd(r.expiresOn))}`
                            : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.kind === 'OTHER' && r.customLabel
                          ? r.customLabel
                          : KIND_LABELS[r.kind]}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-silver tabular-nums">
                        {r.doseNumber}
                        {r.totalDoses ? ` / ${r.totalDoses}` : ''}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-silver tabular-nums">
                        {fmtDate(parseYmd(r.administeredOn))}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm tabular-nums">
                        {r.expiresOn ? (
                          <span
                            className={
                              (parseYmd(r.expiresOn)?.getTime() ?? Infinity) <
                              Date.now()
                                ? 'text-alert'
                                : 'text-silver'
                            }
                          >
                            {fmtDate(parseYmd(r.expiresOn))}
                          </span>
                        ) : (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage && (
                          <button
                            aria-label="Delete vaccination record"
                            disabled={actionKey !== null}
                            onClick={async () => {
                              if (!(await confirm({ title: 'Delete this record?', destructive: true }))) return;
                              await act(`del-${r.id}`, async () => {
                                try {
                                  await deleteVaccination(r.id);
                                  toast.success('Record deleted.');
                                  refresh();
                                } catch (err) {
                                  toast.error(
                                    err instanceof ApiError
                                      ? err.message
                                      : 'Failed.',
                                  );
                                }
                              });
                            }}
                            className="can-hover:opacity-60 group-hover:opacity-100 text-silver hover:text-alert disabled:opacity-40"
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
            {expiringError ? (
              <div className="p-6">
                <ErrorBanner
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={refreshSummaries}
                    >
                      Retry
                    </Button>
                  }
                >
                  {expiringError}
                </ErrorBanner>
              </div>
            ) : expiring === null ? (
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
                    <TableHead className="hidden md:table-cell">Expires</TableHead>
                    <TableHead>Days</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expiring.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium text-white">
                        {r.associateName}
                        <div className="text-xs2 text-silver/70 md:hidden tabular-nums">
                          {fmtDate(parseYmd(r.expiresOn))}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.kind === 'OTHER' && r.customLabel
                          ? r.customLabel
                          : KIND_LABELS[r.kind]}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-silver tabular-nums">
                        {fmtDate(parseYmd(r.expiresOn))}
                      </TableCell>
                      <TableCell>
                        {r.overdue ? (
                          <Badge variant="destructive">
                            {Math.abs(r.daysUntil)}d overdue
                          </Badge>
                        ) : r.daysUntil <= 14 ? (
                          <Badge variant="pending">{r.daysUntil}d</Badge>
                        ) : (
                          <Badge variant="info">{r.daysUntil}d</Badge>
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
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [kind, setKind] = useState<VaccinationKind>('COVID19');
  const [customLabel, setCustomLabel] = useState('');
  const [doseNumber, setDoseNumber] = useState('1');
  const [doseTouched, setDoseTouched] = useState(false);
  const [totalDoses, setTotalDoses] = useState('');
  const [administeredOn, setAdministeredOn] = useState(ymdLocal());
  const [administeredBy, setAdministeredBy] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Prefill dose = (max existing dose for this associate + kind) + 1, but only
  // while the user hasn't touched the field. Skipped for OTHER — custom labels
  // don't form one dose series.
  useEffect(() => {
    if (doseTouched || !assoc || kind === 'OTHER') return;
    let live = true;
    listVaccinations({ associateId: assoc.id, kind })
      .then((r) => {
        if (!live) return;
        const maxDose = r.records.reduce((m, rec) => Math.max(m, rec.doseNumber), 0);
        setDoseNumber(String(maxDose + 1));
      })
      .catch(() => {
        // Silent — the field keeps its current value.
      });
    return () => {
      live = false;
    };
  }, [assoc, kind, doseTouched]);

  // Expiry hint only — never auto-filled. Most records here (flu, TB test)
  // are re-verified annually.
  const administeredParsed = parseYmd(administeredOn);
  const suggestedExpiry = administeredParsed
    ? new Date(
        administeredParsed.getFullYear(),
        administeredParsed.getMonth() + 12,
        administeredParsed.getDate(),
      )
    : null;

  const submit = async () => {
    if (!assoc) {
      toast.error('Pick an associate.');
      return;
    }
    if (kind === 'OTHER' && !customLabel.trim()) {
      toast.error('Custom label required for OTHER.');
      return;
    }
    setSaving(true);
    try {
      await createVaccination({
        associateId: assoc.id,
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as VaccinationKind)}
          >
            {(Object.keys(KIND_LABELS) as VaccinationKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label>Dose</Label>
            <Input
              type="number"
              min="1"
              max="20"
              className="mt-1"
              value={doseNumber}
              onChange={(e) => {
                setDoseTouched(true);
                setDoseNumber(e.target.value);
              }}
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
            {!expiresOn && suggestedExpiry && (
              <p className="mt-1 text-xs text-silver">
                Commonly 12 months after administration —{' '}
                <button
                  type="button"
                  className="underline hover:text-white"
                  onClick={() => setExpiresOn(ymdLocal(suggestedExpiry))}
                >
                  use {fmtDate(suggestedExpiry)}
                </button>
              </p>
            )}
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
          <Textarea
            className="mt-1 h-20"
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
