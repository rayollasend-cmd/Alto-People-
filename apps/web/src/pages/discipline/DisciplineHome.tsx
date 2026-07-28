import { useEffect, useMemo, useState } from 'react';
import { Download, Gavel, Plus, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  acknowledgeDisciplinaryAction,
  getLadder,
  issueDisciplinaryAction,
  KIND_LABELS,
  listDisciplinaryActions,
  rescindDisciplinaryAction,
  type DisciplinaryActionRow,
  type DisciplineKind,
  type DisciplineStatus,
} from '@/lib/discipline118Api';
import { useAuth } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { hasCapability } from '@/lib/roles';
import {
  AssociatePicker,
  type PickedAssociate,
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
  FilterChip,
  Input,
  PageHeader,
  SearchInput,
  Select,
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

const STATUS_LABELS: Record<DisciplineStatus, string> = {
  ACTIVE: 'Active',
  ACKNOWLEDGED: 'Acknowledged',
  RESCINDED: 'Rescinded',
};

/** Warning ladder, lowest rung first — drives the "suggested next" hint. */
const KIND_ORDER: DisciplineKind[] = [
  'VERBAL_WARNING',
  'WRITTEN_WARNING',
  'FINAL_WARNING',
  'SUSPENSION',
  'TERMINATION',
];

export function DisciplineHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  const [rows, setRows] = useState<DisciplinaryActionRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DisciplineStatus | 'ALL'>('ACTIVE');
  const [kindFilter, setKindFilter] = useState<DisciplineKind | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [openRow, setOpenRow] = useState<DisciplinaryActionRow | null>(null);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listDisciplinaryActions({
      status: filter === 'ALL' ? undefined : filter,
      kind: kindFilter === 'ALL' ? undefined : kindFilter,
    })
      .then((r) => setRows(r.actions))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load disciplinary actions.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [filter, kindFilter]);

  const visibleRows = useMemo(() => {
    const all = rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (a) =>
        a.associateName.toLowerCase().includes(q) ||
        a.associateEmail.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const exportCsv = () => {
    downloadCsv(`disciplinary-actions-${ymdLocal()}.csv`, [
      [
        'Associate',
        'Email',
        'Kind',
        'Status',
        'Incident date',
        'Effective date',
        'Suspension days',
        'Description',
        'Issued by',
        'Acknowledged at',
        'Rescinded at',
      ],
      ...visibleRows.map((a) => [
        a.associateName,
        a.associateEmail,
        KIND_LABELS[a.kind],
        STATUS_LABELS[a.status],
        a.incidentDate,
        a.effectiveDate,
        a.suspensionDays ?? '',
        a.description,
        a.issuedByEmail ?? '',
        a.acknowledgedAt ? fmtDateTime(a.acknowledgedAt) : '',
        a.rescindedAt ? fmtDateTime(a.rescindedAt) : '',
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Disciplinary actions"
        subtitle="Formal warning ladder. Verbal → written → final → suspension → termination."
        breadcrumbs={[{ label: 'Performance' }, { label: 'Discipline' }]}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {(['ACTIVE', 'ACKNOWLEDGED', 'RESCINDED', 'ALL'] as const).map((s) => (
            <FilterChip
              key={s}
              active={filter === s}
              onClick={() => setFilter(s)}
            >
              {s === 'ALL' ? 'All' : STATUS_LABELS[s]}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SearchInput
            aria-label="Search associate"
            className="h-8 w-52 text-xs"
            placeholder="Search associate"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            size="sm"
            aria-label="Filter by kind"
            value={kindFilter}
            onChange={(e) =>
              setKindFilter(e.target.value as DisciplineKind | 'ALL')
            }
          >
            <option value="ALL">All kinds</option>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            onClick={exportCsv}
            disabled={visibleRows.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          {canManage && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Issue action
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : visibleRows.length === 0 ? (
            <EmptyState
              icon={Gavel}
              title="No disciplinary actions"
              description={
                filter === 'ACTIVE' &&
                kindFilter === 'ALL' &&
                !search.trim()
                  ? 'No active actions.'
                  : 'Nothing matches this filter.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="hidden md:table-cell">Incident</TableHead>
                  <TableHead className="hidden lg:table-cell">Effective</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((a) => (
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
                      <div className="text-xs2 text-silver/70 md:hidden">
                        {fmtDate(parseYmd(a.incidentDate))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={KIND_VARIANT[a.kind]}>
                        {KIND_LABELS[a.kind]}
                        {a.kind === 'SUSPENSION' && a.suspensionDays
                          ? ` (${a.suspensionDays}d)`
                          : ''}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-silver">
                      {fmtDate(parseYmd(a.incidentDate))}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-silver">
                      {fmtDate(parseYmd(a.effectiveDate))}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[a.status]}>
                        {STATUS_LABELS[a.status]}
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
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [kind, setKind] = useState<DisciplineKind>('VERBAL_WARNING');
  const today = ymdLocal();
  const [incidentDate, setIncidentDate] = useState(today);
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [suspensionDays, setSuspensionDays] = useState('1');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [saving, setSaving] = useState(false);
  const [ladder, setLadder] = useState<{
    total: number;
    prior: Array<{ kind: DisciplineKind; effectiveDate: string }>;
    suggested: DisciplineKind;
  } | null>(null);
  const [ladderError, setLadderError] = useState(false);

  // When the associate resolves, pull their prior-action rollup so the
  // issuer sees where this person sits on the ladder before picking a kind.
  const assocId = assoc?.id ?? null;
  useEffect(() => {
    setLadder(null);
    setLadderError(false);
    if (!assocId) return;
    let cancelled = false;
    Promise.all([
      getLadder(assocId),
      listDisciplinaryActions({ associateId: assocId }),
    ])
      .then(([rollup, list]) => {
        if (cancelled) return;
        const prior = list.actions
          .filter((a) => a.status !== 'RESCINDED')
          .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
          .map((a) => ({ kind: a.kind, effectiveDate: a.effectiveDate }));
        const total = KIND_ORDER.reduce((n, k) => n + rollup.ladder[k], 0);
        let highest = -1;
        KIND_ORDER.forEach((k, i) => {
          if (rollup.ladder[k] > 0) highest = i;
        });
        const suggested =
          highest >= KIND_ORDER.length - 1
            ? 'TERMINATION'
            : KIND_ORDER[highest + 1];
        setLadder({ total, prior, suggested });
        // Pre-select the suggested rung; the Select stays fully editable.
        setKind(suggested);
      })
      .catch(() => {
        if (!cancelled) setLadderError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assocId]);

  const effective = parseYmd(effectiveDate);
  const days = parseInt(suspensionDays, 10);
  const returnDate =
    kind === 'SUSPENSION' && effective && days > 0
      ? new Date(
          effective.getFullYear(),
          effective.getMonth(),
          effective.getDate() + days,
        )
      : null;

  const submit = async () => {
    if (!assoc) {
      toast.error('Pick an associate.');
      return;
    }
    if (!description.trim()) {
      toast.error('Description required.');
      return;
    }
    setSaving(true);
    try {
      await issueDisciplinaryAction({
        associateId: assoc.id,
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
      toast.error(err instanceof ApiError ? err.message : 'Could not issue the action.');
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={assoc} onChange={setAssoc} />
          </div>
        </div>
        {assoc && (
          <div className="text-xs text-silver rounded border border-navy-secondary p-2.5">
            {ladderError ? (
              <span role="alert" className="text-alert">
                Couldn&apos;t load this associate&apos;s prior actions.
              </span>
            ) : !ladder ? (
              'Checking prior actions…'
            ) : ladder.total === 0 ? (
              <>
                No prior actions — suggested:{' '}
                <span className="text-white">
                  {KIND_LABELS[ladder.suggested]}
                </span>
              </>
            ) : (
              <>
                {ladder.total} prior:{' '}
                {ladder.prior
                  .map(
                    (p) =>
                      `${KIND_LABELS[p.kind]} (${fmtDate(
                        parseYmd(p.effectiveDate),
                      )})`,
                  )
                  .join(', ')}{' '}
                — suggested next:{' '}
                <span className="text-white">
                  {KIND_LABELS[ladder.suggested]}
                </span>
              </>
            )}
          </div>
        )}
        <div>
          <Label htmlFor="discipline-kind">Kind</Label>
          <Select
            id="discipline-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as DisciplineKind)}
          >
            {(Object.keys(KIND_LABELS) as DisciplineKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
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
        {returnDate && (
          <div className="text-xs text-silver">
            Returns to work {fmtDate(returnDate)}
          </div>
        )}
        <div>
          <Label>What happened</Label>
          <Textarea
            className="mt-1 h-32"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Factual description of the incident…"
          />
        </div>
        <div>
          <Label>Expected change</Label>
          <Textarea
            className="mt-1 h-20"
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
  // The typed signature must match the associate's name on file
  // (case-insensitive, whitespace-trimmed) before submit unlocks.
  const signatureMatches =
    signature.trim().toLowerCase() === row.associateName.trim().toLowerCase();

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{KIND_LABELS[row.kind]} — {row.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={KIND_VARIANT[row.kind]}>{KIND_LABELS[row.kind]}</Badge>
          <Badge variant={STATUS_VARIANT[row.status]}>
            {STATUS_LABELS[row.status]}
          </Badge>
          {row.kind === 'SUSPENSION' && row.suspensionDays && (
            <span className="text-sm text-silver">
              {row.suspensionDays} days
            </span>
          )}
        </div>
        <div className="text-xs text-silver">
          Incident: {fmtDate(parseYmd(row.incidentDate))} · Effective:{' '}
          {fmtDate(parseYmd(row.effectiveDate))}
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
              {fmtDateTime(row.acknowledgedAt)} —{' '}
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
              {fmtDateTime(row.rescindedAt)}
              {row.rescindedByEmail && ` by ${row.rescindedByEmail}`}
            </div>
            <div className="text-sm text-silver italic">{row.rescindedReason}</div>
          </div>
        )}

        {row.status === 'ACTIVE' && isSubject && (
          <div className="space-y-2 pt-3 border-t border-navy-secondary">
            <Label>Acknowledge with signature</Label>
            <p className="text-xs text-silver">
              Type your full name exactly as it appears:{' '}
              <span className="text-white">{row.associateName}</span>
            </p>
            <Input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder={row.associateName}
              invalid={signature.trim().length > 0 && !signatureMatches}
              aria-label="Signature"
            />
            {signature.trim().length > 0 && !signatureMatches && (
              <p role="alert" className="text-xs text-alert">
                Signature must match your name on file.
              </p>
            )}
            <Button
              size="sm"
              loading={busy}
              disabled={!signatureMatches}
              onClick={async () => {
                setBusy(true);
                try {
                  await acknowledgeDisciplinaryAction(row.id, signature.trim());
                  toast.success('Acknowledged.');
                  onChanged();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Could not record the acknowledgment.',
                  );
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
            <Textarea
              className="h-20"
              value={rescindReason}
              onChange={(e) => setRescindReason(e.target.value)}
              placeholder="Why this is being rescinded…"
            />
            <Button
              size="sm"
              variant="destructive"
              loading={busy}
              disabled={!rescindReason.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await rescindDisciplinaryAction(row.id, rescindReason.trim());
                  toast.success('Rescinded.');
                  onChanged();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Could not rescind the action.',
                  );
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
