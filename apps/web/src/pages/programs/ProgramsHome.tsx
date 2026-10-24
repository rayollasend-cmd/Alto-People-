import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarRange, Download, FileText, Plane, Plus, Users, X } from '@/components/ui/icons';
import { toast } from 'sonner';
import {
  PROGRAM_ALERT_LABELS,
  PROGRAM_TYPE_LABELS,
  type ProgramAlert,
  type ProgramAlertSettings,
  type ProgramInput,
  type ProgramSummary,
  type ProgramType,
  type ProgramUpdate,
  type SecondJobStatus,
  type Sponsor,
  type SponsorInput,
  type TransitionCalendarCell,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { listClientLocations, listClients } from '@/lib/clientsApi';
import { DOCUMENT_KIND_LABEL, getDocumentVault } from '@/lib/documentsApi';
import { fmtDate, ymdLocal } from '@/lib/format';
import {
  createProgram,
  createSponsor,
  getAlertSettings,
  getAssociateProgram,
  getSponsorReport,
  getTransitionCalendar,
  listPrograms,
  listSponsors,
  saveAlertSettings,
  sponsorReportUrl,
  transitionCalendarPdfUrl,
  updateProgram,
  updateSponsor,
  type ProgramFilters,
} from '@/lib/programsApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

/**
 * PROGRAM LIFECYCLE — who is here on which visa program, until when.
 *
 * Participants: one record per season per person — J-1 (DS-2019, sponsor,
 * SEVIS) or H-2B (the petition and the one client it was certified for) —
 * with every date that is about to fire. Sponsors: the directory and the
 * report each one asks for. Calendar: arrivals, program ends and
 * departures by month, site and channel, counts only, exportable to a
 * client. Settings: the lead times the alerts fire on.
 */

type Tab = 'participants' | 'sponsors' | 'calendar';
const TABS: readonly Tab[] = ['participants', 'sponsors', 'calendar'];

const STATUS_BADGE: Record<ProgramSummary['status'], { variant: 'success' | 'pending' | 'destructive' | 'info' | 'outline'; label: string }> = {
  UPCOMING: { variant: 'info', label: 'Upcoming' },
  ACTIVE: { variant: 'success', label: 'Active' },
  GRACE: { variant: 'pending', label: 'Grace' },
  ENDED: { variant: 'outline', label: 'Ended' },
  CLOSED: { variant: 'outline', label: 'Closed' },
};

const SECOND_JOB: Record<SecondJobStatus, string> = {
  NOT_REQUESTED: 'Not requested',
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  DENIED: 'Denied',
};

const daysWord = (d: number) => (d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`);
const urgent = (alerts: ProgramAlert[]) => [...alerts].sort((a, b) => a.daysUntil - b.daysUntil)[0] ?? null;
const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function ProgramsHome() {
  const { can } = useAuth();
  const canManage = can('manage:compliance');
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  // ?tab=settings (the old Alert settings tab) opens the settings dialog.
  const [settingsOpen, setSettingsOpen] = useState(requested === 'settings');
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : 'participants';
  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'participants') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params);
  };
  // The header's "Add program" opens the dialog over whichever tab is open.
  const [creating, setCreating] = useState<PickedAssociate | null | 'blank'>(null);
  const sponsors = useQuery({ queryKey: ['programs', 'sponsors'], queryFn: listSponsors });

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Programs"
        subtitle="J-1 and H-2B participants, their sponsors, the dates that fire alerts, and the season's transition calendar."
        actions={[
          { key: 'add', label: 'Add program', icon: Plus, primary: true, hidden: !canManage, onSelect: () => setCreating('blank') },
          // How early each alert fires: settings, not a tab of the work.
          { key: 'alerts', label: 'Alert settings', icon: BellRing, onSelect: () => setSettingsOpen(true) },
        ]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="participants">Participants</TabsTrigger>
          <TabsTrigger value="sponsors">Sponsors</TabsTrigger>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
        </TabsList>
        <TabsContent value="participants">
          <ParticipantsTab canManage={canManage} onCreate={setCreating} />
        </TabsContent>
        <TabsContent value="sponsors">
          <SponsorsTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="calendar">
          <CalendarTab />
        </TabsContent>
      </Tabs>
      {creating && (
        <ProgramDialog
          mode="create"
          preselected={creating === 'blank' ? null : creating}
          sponsors={sponsors.data?.sponsors ?? []}
          onClose={() => setCreating(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          canManage={canManage}
          onClose={() => {
            setSettingsOpen(false);
            if (requested === 'settings') {
              const params = new URLSearchParams(searchParams);
              params.delete('tab');
              setSearchParams(params, { replace: true });
            }
          }}
        />
      )}
    </ListTemplate>
  );
}

/* ------------------------------------------------------------ participants */

function ParticipantsTab({
  canManage,
  onCreate,
}: {
  canManage: boolean;
  /** Open the add dialog (blank, or for one person from a deep link). */
  onCreate: (who: PickedAssociate | 'blank') => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [type, setType] = useState<ProgramType | ''>('');
  const [sponsorId, setSponsorId] = useState('');
  const [clientId, setClientId] = useState('');
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState<ProgramSummary | null>(null);
  const filtered = !!(type || sponsorId || clientId || history);
  const clearFilters = () => {
    setType('');
    setSponsorId('');
    setClientId('');
    setHistory(false);
  };

  const filters: ProgramFilters = {
    type: type || undefined,
    sponsorId: sponsorId || undefined,
    clientId: clientId || undefined,
    history,
  };
  const programs = useQuery({ queryKey: ['programs', 'list', filters], queryFn: () => listPrograms(filters) });
  const sponsors = useQuery({ queryKey: ['programs', 'sponsors'], queryFn: listSponsors });
  const clients = useQuery({ queryKey: ['clients', 'names', 'programs'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });

  // Deep link: /programs?associateId=<id> opens that person's program (or
  // a blank record for them). The param is consumed at once so Back and
  // reload do not reopen the dialog; the lookup itself goes through the
  // query layer and the dialog opens when it answers.
  const deepLinked = useRef(false);
  const deepLinkId = searchParams.get('associateId');
  const [pendingAssociateId, setPendingAssociateId] = useState<string | null>(null);
  useEffect(() => {
    if (!deepLinkId || deepLinked.current) return;
    deepLinked.current = true;
    const next = new URLSearchParams(searchParams);
    next.delete('associateId');
    setSearchParams(next, { replace: true });
    setPendingAssociateId(deepLinkId);
  }, [deepLinkId, searchParams, setSearchParams]);
  const deepLinkProgram = useQuery({
    queryKey: ['programs', 'associate', pendingAssociateId],
    queryFn: () => getAssociateProgram(pendingAssociateId!).catch(() => ({ program: null })),
    enabled: !!pendingAssociateId,
    retry: false,
  });
  useEffect(() => {
    if (!pendingAssociateId || !deepLinkProgram.data) return;
    if (deepLinkProgram.data.program) setEditing(deepLinkProgram.data.program);
    else onCreate({ id: pendingAssociateId, name: 'Selected associate' });
    setPendingAssociateId(null);
  }, [pendingAssociateId, deepLinkProgram.data, onCreate]);

  const rows = useMemo(() => programs.data?.programs ?? [], [programs.data]);
  const stats = useMemo(() => {
    const active = rows.filter((p) => p.status === 'ACTIVE' || p.status === 'GRACE');
    return {
      active: active.length,
      ending30: rows.filter((p) => (p.status === 'ACTIVE' || p.status === 'UPCOMING') && p.daysUntilEnd >= 0 && p.daysUntilEnd <= 30).length,
      alerts: rows.reduce((s, p) => s + p.alerts.length, 0),
      h2b: active.filter((p) => p.type === 'H2B' && p.petitionClientId).length,
    };
  }, [rows]);

  if (programs.isError) return <QueryError what="programs" query={programs} />;

  // Nothing on record at all: the empty state is the page — what these
  // records are and how to start one — not four zeros over filters.
  if (!programs.isLoading && rows.length === 0 && !filtered) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={Plane}
            title="No programs on record"
            description="A program record follows one person through one visa season: a J-1 participant's DS-2019, sponsor and SEVIS dates, or an H-2B worker's petition and the one client it was certified for. Alto fires an alert before each date."
            action={
              canManage ? (
                <Button onClick={() => onCreate('blank')}>
                  <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Add program
                </Button>
              ) : undefined
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <MetricStrip label="Programs at a glance">
        <MetricCard label="Active programs" value={programs.isLoading ? '—' : String(stats.active)} hint="Running or in grace today" />
        <MetricCard label="Ending in 30 days" value={programs.isLoading ? '—' : String(stats.ending30)} hint="Program end within a month" tone={stats.ending30 > 0 ? 'warning' : 'neutral'} />
        <MetricCard label="Alerts firing" value={programs.isLoading ? '—' : String(stats.alerts)} hint="Dates inside their lead time" tone={stats.alerts > 0 ? 'warning' : 'neutral'} />
        <MetricCard label="H-2B on petition" value={programs.isLoading ? '—' : String(stats.h2b)} hint="Scheduling limited to one client" />
      </MetricStrip>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4 text-gold" aria-hidden="true" />
                Participants
              </CardTitle>
              <CardDescription>One record per season per person. The most urgent date leads each row.</CardDescription>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Select aria-label="Program type" size="sm" value={type} onChange={(e) => setType(e.target.value as ProgramType | '')}>
              <option value="">All types</option>
              {(Object.keys(PROGRAM_TYPE_LABELS) as ProgramType[]).map((t) => (
                <option key={t} value={t}>
                  {PROGRAM_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <Select aria-label="Sponsor" size="sm" value={sponsorId} onChange={(e) => setSponsorId(e.target.value)}>
              <option value="">All sponsors</option>
              {(sponsors.data?.sponsors ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Client" size="sm" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">All clients</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-silver">
              <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Include past seasons
            </label>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {programs.isLoading ? (
            <Skeleton className="h-64" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Plane}
              title="Nothing matches these filters"
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <DataGrid<ProgramSummary>
              id="programs-participants"
              caption="Program participants"
              rows={rows}
              rowKey={(p) => p.id}
              urlState={false}
              exportCsv={{ filename: 'programs' }}
              columnChooser={false}
              onRowClick={(p) => setEditing(p)}
              columns={[
                { key: 'name', header: 'Participant', accessor: (p) => p.associateName, sortable: true, primary: true, cell: (p) => (<><span className="text-white">{p.associateName}</span>{p.country ? <span className="ml-2 text-xs text-silver">{p.country}</span> : null}</>) },
                { key: 'type', header: 'Type', accessor: (p) => PROGRAM_TYPE_LABELS[p.type], sortable: true, cardMeta: true, cell: (p) => (p.type === 'H2B' ? `H-2B${p.petitionClientName ? ` · ${p.petitionClientName}` : ''}` : PROGRAM_TYPE_LABELS[p.type]) },
                { key: 'sponsor', header: 'Sponsor', accessor: (p) => p.sponsorName ?? '', sortable: true, className: 'text-silver', cell: (p) => p.sponsorName ?? '—' },
                { key: 'site', header: 'Site', accessor: (p) => [p.clientName, p.siteName].filter(Boolean).join(' · '), sortable: true, className: 'text-silver', cell: (p) => [p.clientName, p.siteName].filter(Boolean).join(' · ') || '—' },
                { key: 'dates', header: 'Program', accessor: (p) => p.programStart, sortable: true, searchable: false, className: 'tabular-nums', cell: (p) => `${fmtDate(p.programStart)} → ${fmtDate(p.programEnd)}` },
                { key: 'days', header: 'Days left', accessor: (p) => p.daysUntilEnd, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (p) => (p.status === 'CLOSED' ? '—' : p.daysUntilEnd < 0 ? `${-p.daysUntilEnd} ago` : String(p.daysUntilEnd)) },
                { key: 'status', header: 'Status', accessor: (p) => p.status, sortable: true, searchable: false, cardMeta: true, cell: (p) => <Badge variant={STATUS_BADGE[p.status].variant}>{STATUS_BADGE[p.status].label}</Badge> },
                {
                  key: 'alert',
                  header: 'Next date',
                  accessor: (p) => urgent(p.alerts)?.daysUntil ?? 9999,
                  csv: (p) => { const a = urgent(p.alerts); return a ? `${a.label} ${a.dueOn}` : ''; },
                  sortable: true,
                  searchable: false,
                  cell: (p) => {
                    const a = urgent(p.alerts);
                    if (!a) return <span className="text-silver">—</span>;
                    return (
                      <Badge variant={a.severity === 'critical' ? 'destructive' : 'pending'} size="sm">
                        {a.label} · {daysWord(a.daysUntil)}
                        {p.alerts.length > 1 ? ` +${p.alerts.length - 1}` : ''}
                      </Badge>
                    );
                  },
                },
              ]}
            />
          )}
        </CardContent>
      </Card>

      {editing && <ProgramDialog mode="edit" program={editing} sponsors={sponsors.data?.sponsors ?? []} canManage={canManage} onClose={() => setEditing(null)} />}
    </div>
  );
}

/* ------------------------------------------------------- program dialog */

interface Draft {
  type: ProgramType;
  sponsorId: string;
  ds2019Number: string;
  ds2019IssuedOn: string;
  ds2019ExpiresOn: string;
  visaExpiresOn: string;
  sevisId: string;
  country: string;
  programStart: string;
  programEnd: string;
  gracePeriodDays: string;
  secondJobStatus: SecondJobStatus;
  h2bPetitionNumber: string;
  petitionClientId: string;
  petitionValidFrom: string;
  petitionValidTo: string;
  worksiteArea: string;
  lastSponsorCheckInOn: string;
  notes: string;
  documentIds: string[];
}

// A season's programs share a type and a sponsor: start the next one where
// the last one left off (per browser), instead of a blank sponsor every time.
const PROGRAM_LAST_KEY = 'alto:programs.lastDraft.v1';
function lastProgramDefaults(): { type: Draft['type']; sponsorId: string } {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(PROGRAM_LAST_KEY) : null;
    if (raw) {
      const v = JSON.parse(raw) as { type?: unknown; sponsorId?: unknown };
      if (typeof v.type === 'string' && typeof v.sponsorId === 'string') return { type: v.type as Draft['type'], sponsorId: v.sponsorId };
    }
  } catch {
    // Private mode: no memory, just the defaults.
  }
  return { type: 'J1_SWT', sponsorId: '' };
}
function rememberProgramDefaults(v: { type: Draft['type']; sponsorId: string }): void {
  try {
    window.localStorage.setItem(PROGRAM_LAST_KEY, JSON.stringify(v));
  } catch {
    // Private mode.
  }
}

const blankDraft = (): Draft => ({
  ...lastProgramDefaults(),
  ds2019Number: '',
  ds2019IssuedOn: '',
  ds2019ExpiresOn: '',
  visaExpiresOn: '',
  sevisId: '',
  country: '',
  programStart: ymdLocal(),
  programEnd: '',
  gracePeriodDays: '30',
  secondJobStatus: 'NOT_REQUESTED',
  h2bPetitionNumber: '',
  petitionClientId: '',
  petitionValidFrom: '',
  petitionValidTo: '',
  worksiteArea: '',
  lastSponsorCheckInOn: '',
  notes: '',
  documentIds: [],
});

const fromProgram = (p: ProgramSummary): Draft => ({
  type: p.type,
  sponsorId: p.sponsorId ?? '',
  ds2019Number: p.ds2019Number ?? '',
  ds2019IssuedOn: p.ds2019IssuedOn ?? '',
  ds2019ExpiresOn: p.ds2019ExpiresOn ?? '',
  visaExpiresOn: p.visaExpiresOn ?? '',
  sevisId: p.sevisId ?? '',
  country: p.country ?? '',
  programStart: p.programStart,
  programEnd: p.programEnd,
  gracePeriodDays: String(p.gracePeriodDays),
  secondJobStatus: p.secondJobStatus,
  h2bPetitionNumber: p.h2bPetitionNumber ?? '',
  petitionClientId: p.petitionClientId ?? '',
  petitionValidFrom: p.petitionValidFrom ?? '',
  petitionValidTo: p.petitionValidTo ?? '',
  worksiteArea: p.worksiteArea ?? '',
  lastSponsorCheckInOn: p.lastSponsorCheckInOn ?? '',
  notes: p.notes ?? '',
  documentIds: p.documents.map((d) => d.id),
});

const orNull = (s: string) => (s.trim() ? s.trim() : null);

function ProgramDialog(
  props:
    | { mode: 'create'; preselected: PickedAssociate | null; sponsors: Sponsor[]; onClose: () => void }
    | { mode: 'edit'; program: ProgramSummary; sponsors: Sponsor[]; canManage: boolean; onClose: () => void },
) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const readOnly = props.mode === 'edit' && !props.canManage;
  const [associate, setAssociate] = useState<PickedAssociate | null>(
    props.mode === 'edit' ? { id: props.program.associateId, name: props.program.associateName } : props.preselected,
  );
  const [d, setD] = useState<Draft>(props.mode === 'edit' ? fromProgram(props.program) : blankDraft());
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const dirty = useMemo(
    () => JSON.stringify(d) !== JSON.stringify(props.mode === 'edit' ? fromProgram(props.program) : blankDraft()),
    [d, props],
  );

  const clients = useQuery({ queryKey: ['clients', 'names', 'programs'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });
  const vault = useQuery({
    queryKey: ['programs', 'vault', associate?.id ?? null],
    queryFn: () => getDocumentVault(associate!.id),
    enabled: !!associate,
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['programs'] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        sponsorId: orNull(d.sponsorId),
        ds2019Number: orNull(d.ds2019Number),
        ds2019IssuedOn: orNull(d.ds2019IssuedOn),
        ds2019ExpiresOn: orNull(d.ds2019ExpiresOn),
        visaExpiresOn: orNull(d.visaExpiresOn),
        sevisId: orNull(d.sevisId),
        country: orNull(d.country),
        programStart: d.programStart,
        programEnd: d.programEnd,
        gracePeriodDays: Math.max(0, Math.min(120, Number(d.gracePeriodDays) || 0)),
        secondJobStatus: d.secondJobStatus,
        h2bPetitionNumber: orNull(d.h2bPetitionNumber),
        petitionClientId: orNull(d.petitionClientId),
        petitionValidFrom: orNull(d.petitionValidFrom),
        petitionValidTo: orNull(d.petitionValidTo),
        worksiteArea: orNull(d.worksiteArea),
        lastSponsorCheckInOn: orNull(d.lastSponsorCheckInOn),
        notes: orNull(d.notes),
        documentIds: d.documentIds,
      };
      if (props.mode === 'create') {
        const body: ProgramInput = { associateId: associate!.id, type: d.type, ...common };
        rememberProgramDefaults({ type: d.type, sponsorId: d.sponsorId });
        return createProgram(body);
      }
      const body: ProgramUpdate = common;
      return updateProgram(props.program.id, body);
    },
    onSuccess: async () => {
      toast.success(props.mode === 'create' ? 'Program added.' : 'Program saved.');
      await invalidate();
      props.onClose();
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'Could not save the program.')),
  });

  const close = useMutation({
    mutationFn: (reason: string) => updateProgram((props as { program: ProgramSummary }).program.id, { closedReason: reason }),
    onSuccess: async () => {
      toast.success('Program closed.');
      await invalidate();
      props.onClose();
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'Could not close the program.')),
  });

  const valid =
    !!associate && d.programStart.length === 10 && d.programEnd.length === 10 && d.programEnd >= d.programStart && (d.type !== 'H2B' || !!d.petitionClientId);
  const busy = save.isPending || close.isPending;
  const title = props.mode === 'create' ? 'Add a program' : `${props.program.associateName} — ${PROGRAM_TYPE_LABELS[props.program.type]}`;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && props.onClose()} confirmDiscard={() => dirty && !readOnly}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {props.mode === 'edit' ? (
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_BADGE[props.program.status].variant}>{STATUS_BADGE[props.program.status].label}</Badge>
                {props.program.siteName ? `${props.program.clientName} · ${props.program.siteName}` : ''}
                {props.program.i9WorkAuthExpiresOn ? ` · I-9 work authorization to ${fmtDate(props.program.i9WorkAuthExpiresOn)}` : ''}
              </span>
            ) : (
              'The visa program this person is here on, its sponsor, and the dates that will fire alerts.'
            )}
          </DialogDescription>
        </DialogHeader>

        {props.mode === 'edit' && props.program.alerts.length > 0 && (
          <ul className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
            {props.program.alerts.map((a) => (
              <li key={a.kind} className={a.severity === 'critical' ? 'text-alert' : 'text-warning'}>
                {a.label}: {fmtDate(a.dueOn)} ({daysWord(a.daysUntil)})
              </li>
            ))}
          </ul>
        )}

        <fieldset disabled={readOnly} className="space-y-3">
          {props.mode === 'create' && (
            <Field label="Associate" required>
              <AssociatePicker value={associate} onChange={setAssociate} />
            </Field>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Program type" required>
              <Select value={d.type} onChange={(e) => set('type', e.target.value as ProgramType)} disabled={props.mode === 'edit'}>
                {(Object.keys(PROGRAM_TYPE_LABELS) as ProgramType[]).map((t) => (
                  <option key={t} value={t}>
                    {PROGRAM_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sponsor">
              <Select value={d.sponsorId} onChange={(e) => set('sponsorId', e.target.value)}>
                <option value="">None</option>
                {props.sponsors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Program start" required>
              <Input type="date" value={d.programStart} onChange={(e) => set('programStart', e.target.value)} className="text-base" />
            </Field>
            <Field label="Program end" required>
              <Input type="date" value={d.programEnd} onChange={(e) => set('programEnd', e.target.value)} className="text-base" />
            </Field>
            <Field label="Grace period (days)" hint="How long they may stay after the program ends.">
              <Input type="number" min={0} max={120} value={d.gracePeriodDays} onChange={(e) => set('gracePeriodDays', e.target.value)} />
            </Field>
            <Field label="Visa expires">
              <Input type="date" value={d.visaExpiresOn} onChange={(e) => set('visaExpiresOn', e.target.value)} className="text-base" />
            </Field>
            <Field label="Second job">
              <Select value={d.secondJobStatus} onChange={(e) => set('secondJobStatus', e.target.value as SecondJobStatus)}>
                {(Object.keys(SECOND_JOB) as SecondJobStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {SECOND_JOB[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Country">
              <Input value={d.country} onChange={(e) => set('country', e.target.value)} maxLength={80} />
            </Field>
          </div>

          {d.type === 'J1_SWT' && (
            <div className="grid grid-cols-1 gap-3 rounded-md border border-navy-secondary p-3 sm:grid-cols-2">
              <Field label="DS-2019 number">
                <Input value={d.ds2019Number} onChange={(e) => set('ds2019Number', e.target.value)} maxLength={80} />
              </Field>
              <Field label="SEVIS ID">
                <Input value={d.sevisId} onChange={(e) => set('sevisId', e.target.value)} maxLength={80} />
              </Field>
              <Field label="DS-2019 issued">
                <Input type="date" value={d.ds2019IssuedOn} onChange={(e) => set('ds2019IssuedOn', e.target.value)} className="text-base" />
              </Field>
              <Field label="DS-2019 expires">
                <Input type="date" value={d.ds2019ExpiresOn} onChange={(e) => set('ds2019ExpiresOn', e.target.value)} className="text-base" />
              </Field>
            </div>
          )}

          {d.type === 'H2B' && (
            <div className="grid grid-cols-1 gap-3 rounded-md border border-navy-secondary p-3 sm:grid-cols-2">
              <Field label="Petition number">
                <Input value={d.h2bPetitionNumber} onChange={(e) => set('h2bPetitionNumber', e.target.value)} maxLength={60} />
              </Field>
              <Field label="Certified for client" required hint="They can only be scheduled here until the program ends.">
                <Select value={d.petitionClientId} onChange={(e) => set('petitionClientId', e.target.value)}>
                  <option value="">Pick a client</option>
                  {(clients.data?.clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Petition valid from">
                <Input type="date" value={d.petitionValidFrom} onChange={(e) => set('petitionValidFrom', e.target.value)} className="text-base" />
              </Field>
              <Field label="Petition valid to">
                <Input type="date" value={d.petitionValidTo} onChange={(e) => set('petitionValidTo', e.target.value)} className="text-base" />
              </Field>
              <Field label="Worksite area">
                <Input value={d.worksiteArea} onChange={(e) => set('worksiteArea', e.target.value)} maxLength={160} placeholder="Destin–Fort Walton Beach, FL" />
              </Field>
            </div>
          )}

          <Field label="Last sponsor check-in" hint="The next one is due a cadence after this.">
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={d.lastSponsorCheckInOn} onChange={(e) => set('lastSponsorCheckInOn', e.target.value)} className="max-w-xs text-base" />
              <Button type="button" variant="outline" size="sm" onClick={() => set('lastSponsorCheckInOn', ymdLocal())}>
                Record check-in today
              </Button>
            </div>
          </Field>

          <Field label="Documents" hint="Files already in the vault that belong to this program (DS-2019, visa, petition).">
            {!associate ? (
              <span className="text-sm text-silver">Pick the associate first.</span>
            ) : vault.isLoading ? (
              <Skeleton className="h-10" />
            ) : (vault.data?.documents ?? []).length === 0 ? (
              <EmptyState size="sm" title={"No documents in the vault yet."} />
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-navy-secondary p-2">
                {(vault.data?.documents ?? []).map((doc) => (
                  <label key={doc.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={d.documentIds.includes(doc.id)}
                      onChange={(e) => set('documentIds', e.target.checked ? [...d.documentIds, doc.id] : d.documentIds.filter((x) => x !== doc.id))}
                    />
                    <span className="text-white">{doc.filename}</span>
                    <span className="text-xs text-silver">{DOCUMENT_KIND_LABEL[String(doc.kind)] ?? String(doc.kind)}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>

          <Field label="Notes">
            <Textarea value={d.notes} onChange={(e) => set('notes', e.target.value)} rows={3} maxLength={2000} />
          </Field>
        </fieldset>

        <DialogFooter>
          {props.mode === 'edit' && props.canManage && !props.program.closedAt && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const reason = await prompt({
                  title: `Close ${props.program.associateName}'s program?`,
                  description: 'Alerts stop and the H-2B scheduling limit lifts. The record stays in history.',
                  reasonLabel: 'Why is it closing early?',
                  reasonPlaceholder: 'Left the program, transferred, no-show…',
                  reasonMaxLength: 300,
                });
                if (reason === null) return;
                close.mutate(reason.trim() || 'Closed');
              }}
            >
              Close program
            </Button>
          )}
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            {readOnly ? 'Done' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid || busy}>
              {props.mode === 'create' ? 'Add program' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- sponsors */

function SponsorsTab({ canManage }: { canManage: boolean }) {
  const sponsors = useQuery({ queryKey: ['programs', 'sponsors'], queryFn: listSponsors });
  const [editing, setEditing] = useState<Sponsor | 'new' | null>(null);
  const [reporting, setReporting] = useState<Sponsor | null>(null);
  const rows = sponsors.data?.sponsors ?? [];

  if (sponsors.isError) return <QueryError what="sponsors" query={sponsors} />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Sponsor directory</CardTitle>
              <CardDescription>Who to call, what each sponsor requires of us, and how often they want to hear from us.</CardDescription>
            </div>
            {canManage && (
              <Button onClick={() => setEditing('new')}>
                <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Add sponsor
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {sponsors.isLoading ? (
            <Skeleton className="h-48" />
          ) : rows.length === 0 ? (
            <EmptyState icon={Users} title="No sponsors yet" description="Add the J-1 sponsors and H-2B agents you work with." />
          ) : (
            <DataGrid<Sponsor>
              id="programs-sponsors"
              caption="Sponsors"
              rows={rows}
              rowKey={(s) => s.id}
              urlState={false}
              exportCsv={{ filename: 'sponsors' }}
              columnChooser={false}
              onRowClick={(s) => setEditing(s)}
              columns={[
                { key: 'name', header: 'Sponsor', accessor: (s) => s.name, sortable: true, primary: true, cell: (s) => (<><span className="text-white">{s.name}</span>{!s.isActive && <Badge variant="outline" size="sm" className="ml-2">Inactive</Badge>}</>) },
                { key: 'type', header: 'Type', accessor: (s) => PROGRAM_TYPE_LABELS[s.programType], sortable: true, cardMeta: true },
                { key: 'contact', header: 'Contact', accessor: (s) => [s.contactName, s.contactEmail, s.contactPhone].filter(Boolean).join(' · '), sortable: false, className: 'text-silver', cell: (s) => [s.contactName, s.contactEmail, s.contactPhone].filter(Boolean).join(' · ') || '—' },
                { key: 'cadence', header: 'Check-in every', accessor: (s) => s.checkInCadenceDays, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (s) => `${s.checkInCadenceDays} days` },
                { key: 'active', header: 'Active participants', accessor: (s) => s.activeParticipants, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                {
                  key: 'report',
                  header: 'Report',
                  accessor: () => '',
                  sortable: false,
                  searchable: false,
                  cell: (s) => (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setReporting(s);
                      }}
                    >
                      <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Report
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {editing && <SponsorDialog sponsor={editing === 'new' ? null : editing} canManage={canManage} onClose={() => setEditing(null)} />}
      {reporting && <SponsorReportDialog sponsor={reporting} onClose={() => setReporting(null)} />}
    </div>
  );
}

function SponsorDialog({ sponsor, canManage, onClose }: { sponsor: Sponsor | null; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [d, setD] = useState<SponsorInput>({
    name: sponsor?.name ?? '',
    programType: sponsor?.programType ?? 'J1_SWT',
    contactName: sponsor?.contactName ?? '',
    contactEmail: sponsor?.contactEmail ?? '',
    contactPhone: sponsor?.contactPhone ?? '',
    website: sponsor?.website ?? '',
    checkInCadenceDays: sponsor?.checkInCadenceDays ?? 30,
    checkInRequirements: sponsor?.checkInRequirements ?? '',
    reportingCadence: sponsor?.reportingCadence ?? '',
    notes: sponsor?.notes ?? '',
    isActive: sponsor?.isActive ?? true,
  });
  const set = <K extends keyof SponsorInput>(k: K, v: SponsorInput[K]) => setD((p) => ({ ...p, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body: SponsorInput = {
        ...d,
        name: d.name.trim(),
        contactName: orNull(d.contactName ?? ''),
        contactEmail: orNull(d.contactEmail ?? ''),
        contactPhone: orNull(d.contactPhone ?? ''),
        website: orNull(d.website ?? ''),
        checkInRequirements: orNull(d.checkInRequirements ?? ''),
        reportingCadence: orNull(d.reportingCadence ?? ''),
        notes: orNull(d.notes ?? ''),
      };
      return sponsor ? updateSponsor(sponsor.id, body) : createSponsor(body);
    },
    onSuccess: async () => {
      toast.success(sponsor ? 'Sponsor saved.' : 'Sponsor added.');
      await qc.invalidateQueries({ queryKey: ['programs', 'sponsors'] });
      onClose();
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'Could not save the sponsor.')),
  });
  const readOnly = !canManage;
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={() => !readOnly && d.name.trim().length > 0}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{sponsor ? sponsor.name : 'Add a sponsor'}</DialogTitle>
          <DialogDescription>Contacts, what a check-in must cover, and how often they want to hear from us.</DialogDescription>
        </DialogHeader>
        <fieldset disabled={readOnly} className="space-y-3">
          <Field label="Name" required>
            <Input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={160} autoFocus />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Program type">
              <Select value={d.programType} onChange={(e) => set('programType', e.target.value as ProgramType)}>
                {(Object.keys(PROGRAM_TYPE_LABELS) as ProgramType[]).map((t) => (
                  <option key={t} value={t}>
                    {PROGRAM_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Check-in every (days)" hint="J-1 regulation: at least monthly.">
              <Input type="number" min={1} max={365} value={d.checkInCadenceDays} onChange={(e) => set('checkInCadenceDays', Math.max(1, Math.min(365, Number(e.target.value) || 30)))} />
            </Field>
            <Field label="Contact name">
              <Input value={d.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} maxLength={120} />
            </Field>
            <Field label="Contact email">
              <Input type="email" value={d.contactEmail ?? ''} onChange={(e) => set('contactEmail', e.target.value)} maxLength={254} />
            </Field>
            <Field label="Contact phone">
              <Input value={d.contactPhone ?? ''} onChange={(e) => set('contactPhone', e.target.value)} maxLength={40} />
            </Field>
            <Field label="Website">
              <Input value={d.website ?? ''} onChange={(e) => set('website', e.target.value)} maxLength={300} />
            </Field>
          </div>
          <Field label="Check-in requirements" hint="What a check-in has to cover, in their words.">
            <Textarea value={d.checkInRequirements ?? ''} onChange={(e) => set('checkInRequirements', e.target.value)} rows={3} maxLength={2000} />
          </Field>
          <Field label="Reporting cadence" hint='e.g. "monthly placement report by the 5th".'>
            <Input value={d.reportingCadence ?? ''} onChange={(e) => set('reportingCadence', e.target.value)} maxLength={500} />
          </Field>
          <Field label="Notes">
            <Textarea value={d.notes ?? ''} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={2000} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active sponsor
          </label>
        </fieldset>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            {readOnly ? 'Done' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={d.name.trim().length < 2}>
              {sponsor ? 'Save' : 'Add sponsor'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function firstOfMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function lastOfMonth(d: Date): string {
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
}

function SponsorReportDialog({ sponsor, onClose }: { sponsor: Sponsor; onClose: () => void }) {
  const now = new Date();
  const [from, setFrom] = useState(firstOfMonth(new Date(now.getFullYear(), now.getMonth() - 2, 1)));
  const [to, setTo] = useState(lastOfMonth(now));
  const ok = from.length === 10 && to.length === 10 && to >= from;
  const report = useQuery({
    queryKey: ['programs', 'sponsor-report', sponsor.id, from, to],
    queryFn: () => getSponsorReport(sponsor.id, from, to),
    enabled: ok,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report for {sponsor.name}</DialogTitle>
          <DialogDescription>Participants placed, hours, housing, incidents, and departures in the window.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-base" />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-base" />
          </Field>
        </div>
        {report.isLoading ? (
          <Skeleton className="h-24" />
        ) : report.data ? (
          <div className="space-y-2 text-sm">
            <p className="text-silver">
              {report.data.totals.participants} participants · {report.data.totals.hours} hours · {report.data.totals.incidents} incidents · {report.data.totals.departures} departures
            </p>
            <div className="max-h-56 overflow-y-auto rounded-md border border-navy-secondary">
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-silver">
                  <tr>
                    <th className="px-2 py-1 text-left">Participant</th>
                    <th className="px-2 py-1 text-left">Placement</th>
                    <th className="px-2 py-1 text-right">Hours</th>
                    <th className="px-2 py-1 text-right">Incidents</th>
                    <th className="px-2 py-1 text-left">Departure</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.rows.map((r) => (
                    <tr key={r.associateId} className="border-t border-navy-secondary/60">
                      <td className="px-2 py-1 text-white">{r.associateName}</td>
                      <td className="px-2 py-1 text-silver">{[r.clientName, r.siteName].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.hours}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{r.incidents}</td>
                      <td className="px-2 py-1 text-silver">{r.departure ? fmtDate(r.departure.lastDayWorked) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="outline" disabled={!ok} onClick={() => window.open(sponsorReportUrl(sponsor.id, from, to, 'csv'), '_blank', 'noopener')}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
            CSV
          </Button>
          <Button disabled={!ok} onClick={() => window.open(sponsorReportUrl(sponsor.id, from, to, 'pdf'), '_blank', 'noopener')}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
            PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- calendar */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function CalendarTab() {
  const now = new Date();
  const [from, setFrom] = useState(firstOfMonth(now));
  const [to, setTo] = useState(lastOfMonth(new Date(now.getFullYear(), now.getMonth() + 5, 1)));
  const [clientId, setClientId] = useState('');
  const [locationId, setLocationId] = useState('');
  const clients = useQuery({ queryKey: ['clients', 'names', 'programs'], queryFn: () => listClients({ status: 'ACTIVE', limit: 200 }) });
  const locations = useQuery({
    queryKey: ['clients', 'locations', clientId],
    queryFn: () => listClientLocations(clientId),
    enabled: !!clientId,
  });
  const ok = from.length === 10 && to.length === 10 && to >= from;
  const query = { from, to, clientId: clientId || undefined, locationId: locationId || undefined };
  const cal = useQuery({ queryKey: ['programs', 'calendar', query], queryFn: () => getTransitionCalendar(query), enabled: ok });

  const byMonth = useMemo(() => {
    const m = new Map<string, TransitionCalendarCell[]>();
    for (const c of cal.data?.cells ?? []) {
      const list = m.get(c.month) ?? [];
      list.push(c);
      m.set(c.month, list);
    }
    return m;
  }, [cal.data]);
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[(m ?? 1) - 1] ?? ym} ${y}`;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CalendarRange className="h-4 w-4 text-gold" aria-hidden="true" />
              Transition calendar
            </CardTitle>
            <CardDescription>Arrivals, program ends and departures by month, site and channel. Counts and dates only — the PDF can go to a client.</CardDescription>
          </div>
          {/* A secondary button, and only live when the window holds
              something: a gold PDF of "nothing in this window" helps nobody. */}
          <Button
            variant="secondary"
            disabled={!ok || !cal.data || cal.data.cells.length === 0}
            onClick={() => window.open(transitionCalendarPdfUrl(query), '_blank', 'noopener')}
          >
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Download PDF
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-base" />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-base" />
          </Field>
          <Field label="Client">
            <Select
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setLocationId('');
              }}
            >
              <option value="">All clients</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Site">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!clientId}>
              <option value="">All sites</option>
              {(locations.data?.locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </CardHeader>
      <CardContent>
        {cal.isError ? (
          <QueryError what="the calendar" query={cal} />
        ) : cal.isLoading || !cal.data ? (
          <Skeleton className="h-48" />
        ) : cal.data.cells.length === 0 ? (
          <EmptyState icon={CalendarRange} title="Nothing in this window" description="No program starts, ends or departures for the filters chosen." />
        ) : (
          <div className="space-y-4">
            {cal.data.months.map((month) => {
              const cells = byMonth.get(month) ?? [];
              return (
                <div key={month}>
                  <h3 className="mb-1 text-sm font-medium text-white">{monthLabel(month)}</h3>
                  {cells.length === 0 ? (
                    <p className="text-xs text-silver">—</p>
                  ) : (
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-silver">
                        <tr>
                          <th className="py-1 text-left">Site</th>
                          <th className="py-1 text-left">Channel</th>
                          <th className="py-1 text-right">Arrivals</th>
                          <th className="py-1 text-right">Program ends</th>
                          <th className="py-1 text-right">Departures</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cells.map((c) => (
                          <tr key={`${c.siteId ?? 'none'}-${c.channel}`} className="border-t border-navy-secondary/60">
                            <td className="py-1 text-white">{c.clientName === '—' ? c.siteName : `${c.clientName} · ${c.siteName}`}</td>
                            <td className="py-1 text-silver">{PROGRAM_TYPE_LABELS[c.channel]}</td>
                            <td className="py-1 text-right tabular-nums">{c.arrivals}</td>
                            <td className="py-1 text-right tabular-nums">{c.programEnds}</td>
                            <td className="py-1 text-right tabular-nums">{c.departures}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  )}
                </div>
              );
            })}
            <p className="border-t border-navy-secondary pt-2 text-sm text-silver">
              Totals: {cal.data.totals.arrivals} arrivals · {cal.data.totals.programEnds} program ends · {cal.data.totals.departures} departures
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- settings */

const SETTING_FIELDS: Array<{ key: keyof ProgramAlertSettings; label: string; hint: string }> = [
  { key: 'programEndDays', label: 'Program end (and grace end)', hint: 'Days before the program ends.' },
  { key: 'visaExpiryDays', label: 'Visa and DS-2019 expiry', hint: 'Days before the stamp or the form expires.' },
  { key: 'i9ReverifyDays', label: 'I-9 reverification', hint: 'Days before the work authorization on the I-9 expires.' },
  { key: 'sponsorCheckInDays', label: 'Sponsor check-in', hint: 'Days before the next check-in is due (0 = on the day).' },
  { key: 'petitionEndDays', label: 'H-2B petition end', hint: 'Days before the petition validity ends.' },
];

/** Lead times, most days first, each a whole number of days 0–365. */
export const sortLeads = (days: number[]) => [...new Set(days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 365))].sort((a, b) => b - a);

/** One lead-time list as chips: × to drop a lead, a number box to add one. */
function LeadChips({
  label,
  hint,
  days,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  days: number[];
  disabled: boolean;
  onChange: (days: number[]) => void;
}) {
  const [next, setNext] = useState('');
  const id = `lead-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const add = () => {
    const n = Number(next);
    if (next.trim() === '' || !Number.isInteger(n) || n < 0 || n > 365) return;
    onChange(sortLeads([...days, n]));
    setNext('');
  };
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm text-ink">{label}</legend>
      <p className="text-xs text-silver">{hint}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {days.length === 0 && <span className="text-xs text-silver">No alerts</span>}
        {days.map((d) => (
          <span key={d} className="inline-flex items-center gap-1 rounded-full border border-navy-secondary bg-navy-secondary/40 py-0.5 pl-2.5 pr-1 text-xs text-ink">
            {d === 0 ? 'On the day' : `${d} ${d === 1 ? 'day' : 'days'}`}
            {!disabled && (
              <button
                type="button"
                className="grid h-5 w-5 place-items-center rounded-full text-silver hover:bg-navy-secondary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                aria-label={`Remove ${d === 0 ? 'on the day' : `${d} days`} from ${label}`}
                onClick={() => onChange(days.filter((x) => x !== d))}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <span className="inline-flex items-center gap-1">
            <label htmlFor={id} className="sr-only">
              Add a lead time to {label}, in days
            </label>
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={0}
              max={365}
              value={next}
              placeholder="Days"
              className="h-8 w-20 text-base sm:text-sm"
              onChange={(e) => setNext(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button type="button" size="sm" variant="ghost" onClick={add} disabled={next.trim() === ''}>
              Add
            </Button>
          </span>
        )}
      </div>
    </fieldset>
  );
}

/** How many days before each date an alert fires — a dialog from the header, not a tab of the work. */
function SettingsDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['programs', 'alert-settings'], queryFn: getAlertSettings });
  const [draft, setDraft] = useState<ProgramAlertSettings | null>(null);
  const current = draft ?? settings.data ?? null;
  const save = useMutation({
    mutationFn: () => saveAlertSettings(Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, sortLeads(current![f.key])])) as unknown as ProgramAlertSettings),
    onSuccess: async () => {
      toast.success('Lead times saved.');
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['programs'] });
      onClose();
    },
    onError: (err: unknown) => toast.error(errMsg(err, 'Could not save.')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Alert lead times</DialogTitle>
          <DialogDescription>
            How many days before each date an alert fires. The smallest lead marks the alert urgent. Alerts show on the associate record, the dashboards and the Monday digest.
          </DialogDescription>
        </DialogHeader>
        {settings.isError ? (
          <QueryError what="alert settings" query={settings} />
        ) : !current ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {SETTING_FIELDS.map((f) => (
              <LeadChips
                key={f.key}
                label={f.label}
                hint={f.hint}
                days={current[f.key]}
                disabled={!canManage}
                onChange={(days) => setDraft({ ...current, [f.key]: days })}
              />
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            {canManage ? 'Cancel' : 'Close'}
          </Button>
          {canManage && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!draft}>
              Save lead times
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Exported for tests: the label of an alert kind. */
export const alertLabel = (k: ProgramAlert['kind']) => PROGRAM_ALERT_LABELS[k];
