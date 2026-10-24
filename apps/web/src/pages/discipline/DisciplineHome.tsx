import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Gavel, Plus, ShieldOff } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  acknowledgeDisciplinaryAction,
  getLadder,
  issueDisciplinaryAction,
  KIND_LABELS,
  getDisciplineSummary,
  listDisciplinaryActions,
  rescindDisciplinaryAction,
  type DisciplinaryActionRow,
  type DisciplineKind,
  type DisciplineStatus,
} from '@/lib/discipline118Api';
import { useAuth, useTerm } from '@/lib/auth';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { hasCapability } from '@/lib/roles';
import { StatusBadge } from '@/lib/status';
import {
  AssociatePicker,
  type PickedAssociate,
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  FilterChip,
  Input,
  Select,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useUrlFilters, useUrlParam } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';
import { Label } from '@/components/ui/Label';
import { pickOne } from '@/lib/validationCopy';

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

// Deliberate departures from the shared vocabulary (visible per the status
// contract): an ACTIVE disciplinary case is a live warning against the
// associate, not a healthy state, so it reads amber instead of the canonical
// green. RESCINDED is this domain's "deliberately ended" terminal — muted.
const DISCIPLINE_STATUS_TONES = { ACTIVE: 'pending', RESCINDED: 'outline' } as const;

/** Warning ladder, lowest rung first — drives the "suggested next" hint. */
const KIND_ORDER: DisciplineKind[] = [
  'VERBAL_WARNING',
  'WRITTEN_WARNING',
  'FINAL_WARNING',
  'SUSPENSION',
  'TERMINATION',
];

/** The log's view filter: everything in force (the default), one status, or all. */
type ViewFilter = 'IN_FORCE' | DisciplineStatus | 'ALL';
const VIEW_FILTERS: readonly ViewFilter[] = ['IN_FORCE', 'ACTIVE', 'ACKNOWLEDGED', 'RESCINDED', 'ALL'];
const KIND_FILTERS: readonly (DisciplineKind | 'ALL')[] = ['ALL', ...KIND_ORDER];
/** One meaning per word: the API's ACTIVE is an action the person hasn't acknowledged yet. */
const STATUS_WORDS: Record<DisciplineStatus, string> = {
  ACTIVE: 'Awaiting acknowledgment',
  ACKNOWLEDGED: 'Acknowledged',
  RESCINDED: 'Rescinded',
};
const VIEW_WORDS: Record<ViewFilter, string> = {
  IN_FORCE: 'Active',
  ALL: 'All',
  ...STATUS_WORDS,
};

export function DisciplineHome() {
  const term = useTerm();
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:performance') : false;
  // The view and kind live in the URL (?status=, ?kind=), so a filtered log
  // can be linked and Back keeps it.
  const [filter, setFilter] = useUrlParam<ViewFilter>('status', 'IN_FORCE', VIEW_FILTERS);
  const [kindFilter, setKindFilter] = useUrlParam<DisciplineKind | 'ALL'>('kind', 'ALL', KIND_FILTERS);
  const { active: activeFilters, clear: clearFilters } = useUrlFilters(['status', 'kind']);
  const [showNew, setShowNew] = useState(false);
  const [openRow, setOpenRow] = useState<DisciplinaryActionRow | null>(null);

  const refreshQuery = useQuery({
    queryKey: ['DisciplineHome', 'rows', filter, kindFilter],
    queryFn: () => listDisciplinaryActions({
      status: filter === 'ALL' || filter === 'IN_FORCE' ? undefined : filter,
      state: filter === 'IN_FORCE' ? 'in-force' : undefined,
      kind: kindFilter === 'ALL' ? undefined : kindFilter,
    }),
  });
  const summaryQuery = useQuery({ queryKey: ['DisciplineHome', 'summary'], queryFn: getDisciplineSummary });
  const summary = summaryQuery.data;
  const rows: DisciplinaryActionRow[] | null = refreshQuery.data?.actions ?? null;
  const refresh = () => {
    void refreshQuery.refetch();
    void summaryQuery.refetch();
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Disciplinary actions"
      subtitle="Formal warning ladder. Verbal → written → final → suspension → termination."
      actions={canManage ? [{ label: 'Issue action', icon: Plus, primary: true, onSelect: () => setShowNew(true) }] : undefined}
    >
      {summary && (
        <MetricStrip label="Disciplinary actions at a glance" empty={summary.inForce === 0 && summary.issued90d === 0}>
          <MetricCard
            label="Active actions"
            value={summary.inForce}
            hint="Not rescinded"
            onClick={() => {
              clearFilters();
            }}
            selected={filter === 'IN_FORCE' && kindFilter === 'ALL'}
          />
          <MetricCard
            label="Awaiting acknowledgment"
            value={summary.awaitingAck}
            hint="Issued, not yet signed by the person"
            tone={summary.awaitingAck > 0 ? 'warning' : 'default'}
            onClick={() => {
              setKindFilter('ALL');
              setFilter('ACTIVE');
            }}
            selected={filter === 'ACTIVE' && kindFilter === 'ALL'}
          />
          <MetricCard
            label="Final warnings"
            value={summary.finalWarningPeople}
            hint={summary.finalWarningPeople === 1 ? 'Person one step from termination' : 'People one step from termination'}
            tone={summary.finalWarningPeople > 0 ? 'alert' : 'default'}
            onClick={() => {
              setFilter('IN_FORCE');
              setKindFilter('FINAL_WARNING');
            }}
            selected={filter === 'IN_FORCE' && kindFilter === 'FINAL_WARNING'}
          />
          <MetricCard label="Issued in 90 days" value={summary.issued90d} hint="Every kind, any status" />
        </MetricStrip>
      )}

      {refreshQuery.error ? (
        <QueryError what="disciplinary actions" query={refreshQuery} />
      ) : (
        <DataGrid<DisciplinaryActionRow>
          id="discipline"
          caption="Disciplinary actions"
          noun={{ one: 'action', many: 'actions' }}
          rows={rows}
          loading={rows === null}
          rowKey={(a) => a.id}
          search={{ placeholder: 'Search by name' }}
          urlKey="actions"
          exportCsv={{ filename: `disciplinary-actions-${ymdLocal()}` }}
          activeFilters={activeFilters}
          onClearFilters={clearFilters}
          filters={
            <>
              {VIEW_FILTERS.map((s) => (
                <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)}>
                  {VIEW_WORDS[s]}
                </FilterChip>
              ))}
              <Select
                size="sm"
                aria-label="Filter by kind"
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value as DisciplineKind | 'ALL')}
              >
                <option value="ALL">All kinds</option>
                {KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </>
          }
          empty={{
            icon: Gavel,
            title: 'No disciplinary actions',
            description: 'Warnings, suspensions and terminations you issue are logged here, with the person’s acknowledgment.',
            action: canManage ? (
              <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                <Plus className="mr-2 h-4 w-4" /> Issue action
              </Button>
            ) : undefined,
          }}
          onRowClick={(a) => setOpenRow(a)}
          rowActionLabel={(a) => `Open the ${KIND_LABELS[a.kind]} for ${a.associateName}`}
          columns={[
            {
              key: 'associate',
              header: term('worker'),
              accessor: (a) => `${a.associateName} ${a.associateEmail}`,
              csv: (a) => a.associateName,
              sortable: true,
              primary: true,
              className: 'font-medium text-white',
              cell: (a) => a.associateName,
            },
            {
              key: 'email',
              header: 'Email',
              accessor: (a) => a.associateEmail,
              sortable: true,
              defaultHidden: true,
              className: 'text-xs text-silver',
            },
            {
              key: 'kind',
              header: 'Kind',
              accessor: (a) => KIND_LABELS[a.kind],
              sortable: true,
              cardMeta: true,
              cell: (a) => (
                <Badge variant={KIND_VARIANT[a.kind]}>
                  {KIND_LABELS[a.kind]}
                  {a.kind === 'SUSPENSION' && a.suspensionDays ? ` (${a.suspensionDays}d)` : ''}
                </Badge>
              ),
            },
            {
              key: 'incident',
              header: 'Incident',
              accessor: (a) => a.incidentDate,
              sortable: true,
              searchable: false,
              className: 'text-sm text-silver whitespace-nowrap',
              cell: (a) => fmtDate(parseYmd(a.incidentDate)),
            },
            {
              key: 'effective',
              header: 'Effective',
              accessor: (a) => a.effectiveDate,
              sortable: true,
              searchable: false,
              className: 'text-sm text-silver whitespace-nowrap',
              cell: (a) => fmtDate(parseYmd(a.effectiveDate)),
            },
            {
              key: 'status',
              header: 'Status',
              accessor: (a) => STATUS_WORDS[a.status],
              sortable: true,
              cardMeta: true,
              cell: (a) => <StatusBadge status={a.status} overrides={DISCIPLINE_STATUS_TONES} label={STATUS_WORDS[a.status]} />,
            },
            { key: 'issuedBy', header: 'Issued by', accessor: (a) => a.issuedByEmail ?? '', sortable: true, defaultHidden: true, className: 'text-xs text-silver' },
            { key: 'acknowledged', header: 'Acknowledged', accessor: (a) => a.acknowledgedAt ?? '', csv: (a) => (a.acknowledgedAt ? fmtDateTime(a.acknowledgedAt) : ''), sortable: true, searchable: false, defaultHidden: true, cell: (a) => (a.acknowledgedAt ? fmtDate(a.acknowledgedAt) : '—') },
          ]}
        />
      )}

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
    </ListTemplate>
  );
}

function NewActionDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const term = useTerm();
  const [assoc, setAssoc] = useState<PickedAssociate | null>(null);
  const [kind, setKind] = useState<DisciplineKind>('VERBAL_WARNING');
  const today = ymdLocal();
  const [incidentDate, setIncidentDate] = useState(today);
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [suspensionDays, setSuspensionDays] = useState('1');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [saving, setSaving] = useState(false);
  // When the associate resolves, pull their prior-action rollup so the
  // issuer sees where this person sits on the ladder before picking a kind.
  const assocId = assoc?.id ?? null;
  const ladderQuery = useQuery({
    queryKey: ['NewActionDrawer', 'ladder', assocId],
    queryFn: async () => {
      const [rollup, list] = await Promise.all([
        getLadder(assocId!),
        listDisciplinaryActions({ associateId: assocId! }),
      ]);
      const prior = list.actions
        .filter((a) => a.status !== 'RESCINDED')
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
        .map((a) => ({ kind: a.kind, effectiveDate: a.effectiveDate }));
      const total = KIND_ORDER.reduce((n, k) => n + rollup.ladder[k], 0);
      let highest = -1;
      KIND_ORDER.forEach((k, i) => {
        if (rollup.ladder[k] > 0) highest = i;
      });
      const suggested: DisciplineKind =
        highest >= KIND_ORDER.length - 1
          ? 'TERMINATION'
          : KIND_ORDER[highest + 1];
      return { total, prior, suggested };
    },
    enabled: assocId !== null,
  });
  const ladder = assocId ? ladderQuery.data ?? null : null;
  const ladderError = assocId ? ladderQuery.isError : false;
  // Pre-select the suggested rung; the Select stays fully editable.
  useEffect(() => {
    const res = ladderQuery.data;
    if (res === undefined) return;
    setKind(res.suggested);
  }, [ladderQuery.data]);

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
      toast.error(pickOne(term));
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
          <Label>{term('worker')}</Label>
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
          <StatusBadge status={row.status} overrides={DISCIPLINE_STATUS_TONES} />
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
        {/* The employee's side, in their words (F500 G5). */}
        {row.employeeResponse && (
          <div className="space-y-1 pt-2 border-t border-navy-secondary" data-testid="discipline-employee-response">
            <div className="text-xs uppercase tracking-wider text-silver">
              Employee’s response{row.employeeRespondedAt ? ` · ${fmtDateTime(row.employeeRespondedAt)}` : ''}
            </div>
            <div className="text-sm text-ink whitespace-pre-wrap">{row.employeeResponse}</div>
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
              <span className="text-white"><AssociateLink associateId={row.associateId}>{row.associateName}</AssociateLink></span>
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
