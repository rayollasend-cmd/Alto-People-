import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HardHat, Plus } from 'lucide-react';
import { createProject, listProjects, type FringeMode, type ProjectInput, type ProjectSummary } from '@/lib/certifiedPayrollApi';
import { listSites } from '@/lib/orgApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { Select } from '@/components/ui/Select';
import { fmtDate } from '@/lib/format';

/**
 * Certified payroll — public-works projects paid at prevailing wage. Each
 * one owes the agency a WH-347 every week with a signed Statement of
 * Compliance (California: the DIR eCPR file). This desk lists the projects
 * and how many weeks each still owes; a project opens to its weeks, rates
 * and workers.
 */
export function CertifiedPayrollDesk() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const projects = useQuery({ queryKey: ['certified-payroll', 'projects'], queryFn: listProjects });
  const rows = projects.data?.projects ?? null;
  const active = (rows ?? []).filter((p) => p.status === 'ACTIVE');
  const due = active.reduce((a, p) => a + p.weeksDue, 0);
  const unsigned = active.reduce((a, p) => a + p.unsigned, 0);

  const columns: GridColumn<ProjectSummary>[] = [
    {
      key: 'name',
      header: 'Project',
      primary: true,
      accessor: (p) => p.name,
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{p.name}</p>
          <p className="truncate text-xs text-ink-muted">{[p.contractNumber && `Contract ${p.contractNumber}`, p.agency].filter(Boolean).join(' · ') || 'No contract number yet'}</p>
        </div>
      ),
    },
    { key: 'state', header: 'State', accessor: (p) => p.state ?? '', cardMeta: true, width: '80px' },
    { key: 'site', header: 'Site', accessor: (p) => p.site?.name ?? '', defaultHidden: true },
    { key: 'workers', header: 'Workers', accessor: (p) => p.workers, align: 'right', className: 'tabular-nums' },
    {
      key: 'due',
      header: 'Weeks owed',
      accessor: (p) => p.weeksDue,
      align: 'right',
      cell: (p) =>
        p.weeksDue === 0 ? (
          <Badge variant="success">Up to date</Badge>
        ) : (
          <Badge variant={p.unsigned > 0 ? 'pending' : 'info'}>{`${p.weeksDue} owed${p.oldestDue ? ` since ${fmtDate(p.oldestDue)}` : ''}`}</Badge>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (p) => p.status,
      cell: (p) => <Badge variant={p.status === 'ACTIVE' ? 'success' : 'default'}>{p.status === 'ACTIVE' ? 'Active' : p.status === 'CLOSED' ? 'Closed' : 'Archived'}</Badge>,
    },
  ];

  return (
    <ListTemplate
      title="Certified payroll"
      subtitle="Public-works projects paid at prevailing wage, and the weekly WH-347 each one owes the agency."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Certified payroll' }]}
      primaryAction={
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          New project
        </Button>
      }
      summary={
        rows ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label="Active projects" value={String(active.length)} />
            <MetricCard label="Weeks owed" value={String(due)} hint="Ended weeks not yet submitted" accent={due > 0} />
            <MetricCard label="Waiting for a signature" value={String(unsigned)} hint="The Statement of Compliance" accent={unsigned > 0} />
          </div>
        ) : null
      }
    >
      <DataGrid
        id="certified-payroll-projects"
        caption="Prevailing-wage projects"
        noun={{ one: 'project', many: 'projects' }}
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        loading={projects.isLoading}
        error={projects.isError ? 'The projects could not be loaded.' : null}
        onRetry={() => void projects.refetch()}
        rowHref={(p) => `/payroll/certified/${p.id}`}
        rowActionLabel={(p) => `Open ${p.name}`}
        empty={{
          icon: HardHat,
          title: 'No prevailing-wage projects',
          description: 'Add a public-works project with its wage determination to start weekly certified payroll.',
          action: <Button onClick={() => setCreating(true)}>New project</Button>,
        }}
      />
      <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={(id) => navigate(`/payroll/certified/${id}`)} />
    </ListTemplate>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ['certified-payroll', 'sites'], queryFn: listSites, enabled: open, retry: false });
  const blank: ProjectInput = { name: '', startDate: new Date().toISOString().slice(0, 10), weekEndsOn: 6, fringeMode: 'CASH' };
  const [form, setForm] = useState<ProjectInput>(blank);
  const set = <K extends keyof ProjectInput>(k: K, v: ProjectInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () => createProject({ ...form, state: form.state ? form.state.toUpperCase() : null }),
    onSuccess: (r) => {
      toast.success('Project added');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
      onOpenChange(false);
      setForm(blank);
      onCreated(r.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const canSave = form.name.trim().length > 0 && !!form.startDate;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New prevailing-wage project</DialogTitle>
          <DialogDescription>From the contract and its wage determination. You add the classifications and rates next.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <Field label="Project name" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Contract number">
            <Input value={form.contractNumber ?? ''} onChange={(e) => set('contractNumber', e.target.value || null)} />
          </Field>
          <Field label="Wage determination" hint="For example CA20260001">
            <Input value={form.wageDeterminationNumber ?? ''} onChange={(e) => set('wageDeterminationNumber', e.target.value || null)} />
          </Field>
          <Field label="Contracting agency">
            <Input value={form.agency ?? ''} onChange={(e) => set('agency', e.target.value || null)} />
          </Field>
          <Field label="Awarding body" hint="If different from the agency">
            <Input value={form.awardingBody ?? ''} onChange={(e) => set('awardingBody', e.target.value || null)} />
          </Field>
          <Field label="Job site" hint={sites.isError ? 'Time is tagged to the project by hand when no site is set.' : 'Time clocked here counts toward the project.'} className="sm:col-span-2">
            <Select value={form.siteId ?? ''} onChange={(e) => set('siteId', e.target.value || null)} disabled={!sites.data}>
              <option value="">No site: tag time by hand</option>
              {(sites.data?.sites ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.clientName ? `${s.name} · ${s.clientName}` : s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Street address" className="sm:col-span-2">
            <Input value={form.addressLine1 ?? ''} onChange={(e) => set('addressLine1', e.target.value || null)} />
          </Field>
          <Field label="City">
            <Input value={form.city ?? ''} onChange={(e) => set('city', e.target.value || null)} />
          </Field>
          <Field label="County">
            <Input value={form.county ?? ''} onChange={(e) => set('county', e.target.value || null)} />
          </Field>
          <Field label="State" hint="Two letters. CA adds daily overtime and the eCPR file.">
            <Input value={form.state ?? ''} maxLength={2} onChange={(e) => set('state', e.target.value.toUpperCase() || null)} />
          </Field>
          <Field label="ZIP">
            <Input value={form.zip ?? ''} inputMode="numeric" onChange={(e) => set('zip', e.target.value || null)} />
          </Field>
          <Field label="DIR project ID" hint="California only">
            <Input value={form.dirProjectId ?? ''} onChange={(e) => set('dirProjectId', e.target.value || null)} />
          </Field>
          <Field label="Start date" required>
            <Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </Field>
          <Field label="Week ends on">
            <Select value={String(form.weekEndsOn ?? 6)} onChange={(e) => set('weekEndsOn', Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fringe benefits are paid" hint="Decides the cash rate each worker must get">
            <Select value={form.fringeMode ?? 'CASH'} onChange={(e) => set('fringeMode', e.target.value as FringeMode)}>
              <option value="CASH">In cash, with wages</option>
              <option value="PLAN">To approved plans</option>
              <option value="MIXED">Partly each</option>
            </Select>
          </Field>
          <Field label="Payroll officer">
            <Input value={form.payrollOfficerName ?? ''} onChange={(e) => set('payrollOfficerName', e.target.value || null)} />
          </Field>
          <Field label="Officer's title">
            <Input value={form.payrollOfficerTitle ?? ''} onChange={(e) => set('payrollOfficerTitle', e.target.value || null)} />
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} loading={save.isPending}>
              Add project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
