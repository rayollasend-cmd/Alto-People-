import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarCheck2, HardHat, Plus, Trash2, Users } from 'lucide-react';
import { addRate, addWorker, endWorker, getProject, removeRate, updateProject, type ProjectDetail, type ProjectRate, type ProjectWorker, type WeekRow } from '@/lib/certifiedPayrollApi';
import { RecordTemplate } from '@/components/templates';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtMoney } from '@/lib/format';

/**
 * One prevailing-wage project: the weeks it owes (each opens to its
 * WH-347), the wage determination's classifications with effective-dated
 * base and fringe rates, the workers and their classifications, and the
 * contract facts.
 */

const today = () => new Date().toISOString().slice(0, 10);
const FRINGE: Record<string, string> = { CASH: 'Fringe paid in cash', PLAN: 'Fringe paid to plans', MIXED: 'Fringe partly cash, partly plans' };

export function WeekStatusBadge({ status }: { status: WeekRow['status'] }) {
  if (status === 'SUBMITTED') return <Badge variant="success">Submitted</Badge>;
  if (status === 'SIGNED') return <Badge variant="info">Signed, not submitted</Badge>;
  return <Badge variant="pending">Not signed</Badge>;
}

export function CertifiedProject() {
  const { id = '' } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'weeks';
  const q = useQuery({ queryKey: ['certified-payroll', 'project', id], queryFn: () => getProject(id), enabled: !!id });

  if (q.isError) return <QueryError what="this project" query={q} />;
  if (q.isLoading || !q.data) return <SkeletonRows count={8} />;
  const { project, weeks } = q.data;
  const owed = weeks.filter((w) => w.status !== 'SUBMITTED').length;

  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Certified payroll', to: '/payroll/certified' }, { label: project.name }]}
      identity={<HardHat className="h-8 w-8 text-gold" aria-hidden />}
      title={project.name}
      subtitle={[project.contractNumber && `Contract ${project.contractNumber}`, project.agency, project.wageDeterminationNumber && `WD ${project.wageDeterminationNumber}`].filter(Boolean).join(' · ') || 'Add the contract facts under Details'}
      status={
        <>
          <Badge variant={project.status === 'ACTIVE' ? 'success' : 'default'}>{project.status === 'ACTIVE' ? 'Active' : project.status === 'CLOSED' ? 'Closed' : 'Archived'}</Badge>
          {owed > 0 ? <Badge variant="pending">{`${owed} week${owed === 1 ? '' : 's'} owed`}</Badge> : null}
        </>
      }
      activeTab={tab}
      onTabChange={(k) => {
        const next = new URLSearchParams(params);
        if (k === 'weeks') next.delete('tab');
        else next.set('tab', k);
        setParams(next, { replace: true });
      }}
      tabs={[
        { key: 'weeks', label: 'Weeks', count: owed || undefined, content: <WeeksTab projectId={project.id} weeks={weeks} /> },
        { key: 'rates', label: 'Rates', count: project.rates.length, content: <RatesTab project={project} /> },
        { key: 'workers', label: 'Workers', count: project.workers.filter((w) => !w.endedOn).length, content: <WorkersTab project={project} /> },
        { key: 'details', label: 'Details', content: <DetailsTab project={project} /> },
      ]}
    />
  );
}

function WeeksTab({ projectId, weeks }: { projectId: string; weeks: WeekRow[] }) {
  const columns: GridColumn<WeekRow>[] = [
    { key: 'week', header: 'Week ending', primary: true, accessor: (w) => w.weekEnding, cell: (w) => <span className="font-medium text-ink">{fmtDate(w.weekEnding)}</span> },
    { key: 'number', header: 'Payroll no.', accessor: (w) => w.payrollNumber ?? '', align: 'right', className: 'tabular-nums' },
    { key: 'status', header: 'Status', accessor: (w) => w.status, cell: (w) => <WeekStatusBadge status={w.status} />, cardMeta: true },
    { key: 'signed', header: 'Signed', accessor: (w) => w.signedAt ?? '', cell: (w) => (w.signedAt ? fmtDate(w.signedAt) : '') },
    { key: 'submitted', header: 'Submitted', accessor: (w) => w.submittedAt ?? '', cell: (w) => (w.submittedAt ? fmtDate(w.submittedAt) : '') },
  ];
  return (
    <DataGrid
      id="certified-payroll-weeks"
      caption="Reporting weeks"
      noun={{ one: 'week', many: 'weeks' }}
      rows={weeks}
      columns={columns}
      rowKey={(w) => w.weekEnding}
      search={false}
      urlState={false}
      rowHref={(w) => `/payroll/certified/${projectId}/weeks/${w.weekEnding}`}
      rowActionLabel={(w) => `Open the week ending ${fmtDate(w.weekEnding)}`}
      empty={{ icon: CalendarCheck2, title: 'No weeks have ended yet', description: 'The first reporting week appears here the day after it ends.' }}
    />
  );
}

function RatesTab({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (rateId: string) => removeRate(project.id, rateId),
    onSuccess: () => {
      toast.success('Rate removed');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: GridColumn<ProjectRate>[] = [
    { key: 'class', header: 'Classification', primary: true, accessor: (r) => r.classification, cell: (r) => <span className="font-medium text-ink">{r.classification}</span> },
    { key: 'base', header: 'Base', accessor: (r) => r.baseRate, cell: (r) => fmtMoney(r.baseRate), align: 'right', className: 'tabular-nums' },
    { key: 'fringe', header: 'Fringe', accessor: (r) => r.fringeRate, cell: (r) => fmtMoney(r.fringeRate), align: 'right', className: 'tabular-nums' },
    { key: 'ratio', header: 'Apprentices per journeyworker', accessor: (r) => r.apprenticesPerJourneyman ?? '', align: 'right', defaultHidden: false },
    { key: 'from', header: 'In force', accessor: (r) => r.effectiveFrom, cell: (r) => `${fmtDate(r.effectiveFrom)} – ${r.effectiveTo ? fmtDate(r.effectiveTo) : 'now'}`, cardMeta: true },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (r) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove the ${r.classification} rate from ${fmtDate(r.effectiveFrom)}`}
          onClick={async () => {
            if (await confirm({ title: 'Remove this rate?', description: 'The rate before it runs on in its place. Signed weeks keep the rate they were signed with.', confirmLabel: 'Remove', destructive: true })) remove.mutate(r.id);
          }}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">{`${FRINGE[project.fringeMode]}. A new rate for a classification ends the one before it.`}</p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Add rate
        </Button>
      </div>
      <DataGrid
        id="certified-payroll-rates"
        caption="Wage determination rates"
        noun={{ one: 'rate', many: 'rates' }}
        rows={project.rates}
        columns={columns}
        rowKey={(r) => r.id}
        search={false}
        urlState={false}
        empty={{ icon: CalendarCheck2, title: 'No rates yet', description: 'Add each classification from the wage determination with its base and fringe rate.', action: <Button size="sm" onClick={() => setAdding(true)}>Add rate</Button> }}
      />
      <RateDialog projectId={project.id} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function RateDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ classification: '', baseRate: '', fringeRate: '0', ratio: '', effectiveFrom: today() });
  const save = useMutation({
    mutationFn: () => addRate(projectId, { classification: f.classification.trim(), baseRate: Number(f.baseRate), fringeRate: Number(f.fringeRate || 0), apprenticesPerJourneyman: f.ratio ? Number(f.ratio) : null, effectiveFrom: f.effectiveFrom }),
    onSuccess: () => {
      toast.success('Rate added');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
      onOpenChange(false);
      setF({ classification: '', baseRate: '', fringeRate: '0', ratio: '', effectiveFrom: today() });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ok = f.classification.trim() && Number(f.baseRate) > 0 && f.effectiveFrom;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a rate</DialogTitle>
          <DialogDescription>As printed in the wage determination for this classification.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <Field label="Classification" required className="col-span-2">
            <Input value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })} placeholder="Electrician" />
          </Field>
          <Field label="Base rate" required>
            <Input type="number" inputMode="decimal" step="0.01" min="0" value={f.baseRate} onChange={(e) => setF({ ...f, baseRate: e.target.value })} />
          </Field>
          <Field label="Fringe rate">
            <Input type="number" inputMode="decimal" step="0.01" min="0" value={f.fringeRate} onChange={(e) => setF({ ...f, fringeRate: e.target.value })} />
          </Field>
          <Field label="Apprentices per journeyworker" hint="Leave empty if the determination sets none">
            <Input type="number" inputMode="decimal" step="0.25" min="0" value={f.ratio} onChange={(e) => setF({ ...f, ratio: e.target.value })} />
          </Field>
          <Field label="In force from" required>
            <Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
          </Field>
          <DialogFooter className="col-span-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={save.isPending}>
              Add rate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkersTab({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const end = useMutation({
    mutationFn: (w: ProjectWorker) => endWorker(project.id, w.id, today()),
    onSuccess: () => {
      toast.success('Taken off the project');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: GridColumn<ProjectWorker>[] = [
    { key: 'name', header: 'Worker', primary: true, accessor: (w) => w.name, cell: (w) => <span className="font-medium text-ink">{w.name}</span> },
    {
      key: 'class',
      header: 'Classification',
      accessor: (w) => w.classification,
      cardMeta: true,
      cell: (w) => (
        <span>
          {w.classification}
          {w.isApprentice ? <Badge variant="info" className="ml-2">{`Apprentice ${w.apprenticeLevelPercent ?? ''}%`}</Badge> : null}
        </span>
      ),
    },
    { key: 'from', header: 'On the project', accessor: (w) => w.startedOn, cell: (w) => `${fmtDate(w.startedOn)} – ${w.endedOn ? fmtDate(w.endedOn) : 'now'}` },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (w) =>
        w.endedOn ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (await confirm({ title: `Take ${w.name} off the project?`, description: 'Their time after today no longer counts toward this project.', confirmLabel: 'Take off' })) end.mutate(w);
            }}
          >
            End
          </Button>
        ),
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">Time these people clock at the job site, or tag to the project, goes on its WH-347.</p>
        <Button size="sm" onClick={() => setAdding(true)} disabled={project.rates.length === 0} title={project.rates.length === 0 ? 'Add a rate first' : undefined}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Add worker
        </Button>
      </div>
      <DataGrid
        id="certified-payroll-workers"
        caption="Workers on the project"
        noun={{ one: 'worker', many: 'workers' }}
        rows={project.workers}
        columns={columns}
        rowKey={(w) => w.id}
        search={false}
        urlState={false}
        empty={{ icon: Users, title: 'No workers on this project', description: project.rates.length === 0 ? 'Add the wage determination rates first, then the people working under them.' : 'Add each person with the classification they work under.' }}
      />
      <WorkerDialog project={project} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function WorkerDialog({ project, open, onOpenChange }: { project: ProjectDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const classes = [...new Set(project.rates.map((r) => r.classification))];
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [f, setF] = useState({ classification: classes[0] ?? '', isApprentice: false, registration: '', level: '', startedOn: today() });
  const save = useMutation({
    mutationFn: () =>
      addWorker(project.id, {
        associateId: person!.id,
        classification: f.classification,
        isApprentice: f.isApprentice,
        apprenticeRegistration: f.isApprentice ? f.registration || null : null,
        apprenticeLevelPercent: f.isApprentice ? Number(f.level) : null,
        startedOn: f.startedOn,
      }),
    onSuccess: () => {
      toast.success('Added to the project');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
      onOpenChange(false);
      setPerson(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ok = person && f.classification && f.startedOn && (!f.isApprentice || Number(f.level) > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a worker</DialogTitle>
          <DialogDescription>Each person works under one classification on this project at a time.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <Field label="Worker" required>
            {({ id }) => <AssociatePicker id={id} value={person} onChange={setPerson} />}
          </Field>
          <Field label="Classification" required>
            <Select value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })}>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={f.isApprentice} onChange={(e) => setF({ ...f, isApprentice: e.target.checked })} />
            <span>A registered apprentice</span>
          </label>
          {f.isApprentice ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Registration number">
                <Input value={f.registration} onChange={(e) => setF({ ...f, registration: e.target.value })} />
              </Field>
              <Field label="Share of journeyworker rate" required hint="Percent, from the program">
                <Input type="number" inputMode="decimal" min="1" max="100" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} />
              </Field>
            </div>
          ) : null}
          <Field label="On the project from" required>
            <Input type="date" value={f.startedOn} onChange={(e) => setF({ ...f, startedOn: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={save.isPending}>
              Add worker
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailsTab({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const close = useMutation({
    mutationFn: (status: 'ACTIVE' | 'CLOSED') => updateProject(project.id, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['certified-payroll'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const facts: Array<[string, string | null]> = [
    ['Contract number', project.contractNumber],
    ['Contracting agency', project.agency],
    ['Awarding body', project.awardingBody],
    ['Wage determination', project.wageDeterminationNumber],
    ['DIR project ID', project.dirProjectId],
    ['Job site', project.site?.name ?? null],
    ['Location', [project.addressLine1, project.city, project.county && `${project.county} County`, project.state, project.zip].filter(Boolean).join(', ') || null],
    ['Dates', `${fmtDate(project.startDate)} – ${project.endDate ? fmtDate(project.endDate) : 'open'}`],
    ['Week ends on', ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][project.weekEndsOn] ?? ''],
    ['Fringe', FRINGE[project.fringeMode] ?? project.fringeMode],
    ['Payroll officer', [project.payrollOfficerName, project.payrollOfficerTitle].filter(Boolean).join(', ') || null],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract facts</CardTitle>
        <CardDescription>These print on every WH-347 and eCPR file for the project.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-ink-muted">{k}</dt>
              <dd className="break-words text-sm text-ink">{v || '—'}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          {project.status === 'ACTIVE' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (await confirm({ title: 'Close this project?', description: 'Weeks that already ended still appear until they are submitted. No new weeks are added after the end date.', confirmLabel: 'Close project' })) close.mutate('CLOSED');
              }}
            >
              Close project
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => close.mutate('ACTIVE')}>
              Reopen project
            </Button>
          )}
          <Button asChild variant="ghost" size="sm">
            <Link to="/payroll/certified">Back to all projects</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
