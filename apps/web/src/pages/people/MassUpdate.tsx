import { useState } from 'react';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Undo2, Users } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { MassPayChange } from '@/components/payroll/MassPayChange';
import { useConfirm } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import { listCostCenters, listDepartments, listJobProfiles } from '@/lib/orgApi';
import { listPayrollSchedules } from '@/lib/payrollApi';
import { useOrgSites } from '@/lib/useOrgSites';
import { useClients } from '@/lib/useClients';
import { getDirectoryEntry } from '@/lib/directoryApi';
import { applyMassUpdate, listMassUpdateBatches, previewMassUpdate, undoMassUpdate, type MassUpdateChanges, type MassUpdateFilter, type MassUpdatePreviewRow } from '@/lib/massUpdateApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Stepper } from '@/components/ui/Stepper';
import { ListTemplate } from '@/components/templates';

/**
 * Mass update (HR pack 2026-10): filter people → see exactly who changes and
 * from what → apply as one batch with one audit row. Undo holds for 24 hours
 * and restores each person's "before".
 */

const FIELD_LABEL: Record<string, string> = { site: 'Site', department: 'Department', manager: 'Manager', paySchedule: 'Pay schedule', costCenter: 'Cost center', jobProfile: 'Job profile' };

export function MassUpdate() {
  const term = useTerm();
  const tenant = useTenant();
  const { can } = useAuth();
  const confirm = useConfirm();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  // ?ids= — the people picked on the People list (HR walk 7): the batch is
  // exactly them, so the Who filters give way to the list of names.
  const [params] = useSearchParams();
  const chosenIds = (params.get('ids') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 500);
  const chosen = chosenIds.length > 0;
  const NAMES_SHOWN = 12;
  const chosenPeople = useQueries({
    queries: chosenIds.slice(0, NAMES_SHOWN).map((id) => ({
      queryKey: ['directory', 'entry', id],
      queryFn: () => getDirectoryEntry(id),
      staleTime: 60_000,
    })),
  });
  // Filter
  const [clientId, setClientId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [manager, setManager] = useState<PickedAssociate | null>(null);
  const [scheduleId, setScheduleId] = useState('');
  // Changes
  const [newSiteId, setNewSiteId] = useState('');
  const [newDepartmentId, setNewDepartmentId] = useState<string>('');
  const [newManager, setNewManager] = useState<PickedAssociate | null | 'clear'>(null);
  const [newScheduleId, setNewScheduleId] = useState<string>('');
  const [newCostCenterId, setNewCostCenterId] = useState<string>('');
  const [newJobProfileId, setNewJobProfileId] = useState<string>('');

  const sites = useOrgSites(true);
  const { clients } = useClients({ enabled: tenant.modules.clientPortal });
  const departments = useQuery({ queryKey: ['org', 'departments'], queryFn: () => listDepartments() });
  // Pay schedules are payroll's (the API refuses a move without
  // process:payroll, and GET /payroll/schedules needs it too): the field
  // and its filter are shown only to payroll.
  const canPaySchedule = can('process:payroll');
  const schedules = useQuery({ queryKey: ['payroll', 'schedules'], queryFn: () => listPayrollSchedules(), enabled: canPaySchedule });
  // Cost center and job profile: the bulk "assign org fields" that lived on
  // Departments & job profiles › People now lives here, with the rest.
  const costCenters = useQuery({ queryKey: ['org', 'cost-centers', 'all'], queryFn: () => listCostCenters() });
  const jobProfiles = useQuery({ queryKey: ['org', 'job-profiles', 'all'], queryFn: () => listJobProfiles() });
  const batches = useQuery({ queryKey: ['people', 'mass-update', 'batches'], queryFn: listMassUpdateBatches });

  const filter: MassUpdateFilter = chosen
    ? { associateIds: chosenIds }
    : {
    ...(clientId ? { clientIds: [clientId] } : {}),
    ...(siteId ? { siteIds: [siteId] } : {}),
    ...(departmentId ? { departmentIds: [departmentId] } : {}),
    ...(manager ? { managerIds: [manager.id] } : {}),
    ...(scheduleId ? { payrollScheduleIds: [scheduleId] } : {}),
      };
  const changes: MassUpdateChanges = {
    ...(newSiteId ? { siteId: newSiteId } : {}),
    ...(newDepartmentId ? { departmentId: newDepartmentId === '__none__' ? null : newDepartmentId } : {}),
    ...(newManager === 'clear' ? { managerId: null } : newManager ? { managerId: newManager.id } : {}),
    ...(newScheduleId ? { payrollScheduleId: newScheduleId === '__none__' ? null : newScheduleId } : {}),
    ...(newCostCenterId ? { costCenterId: newCostCenterId === '__none__' ? null : newCostCenterId } : {}),
    ...(newJobProfileId ? { jobProfileId: newJobProfileId === '__none__' ? null : newJobProfileId } : {}),
  };
  const hasFilter = Object.keys(filter).length > 0;
  const hasChanges = Object.keys(changes).length > 0;

  const preview = useMutation({
    mutationFn: () => previewMassUpdate(filter, changes),
    onSuccess: () => setStep(1),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not preview.'),
  });
  const apply = useMutation({
    mutationFn: () => applyMassUpdate(filter, changes),
    onSuccess: (r) => {
      toast.success(`Updated ${r.affected} ${r.affected === 1 ? 'person' : 'people'}. Undo is available until ${fmtDateTime(r.undoUntil)}.`);
      setStep(2);
      void batches.refetch();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not apply the update.'),
  });
  const undo = useMutation({
    mutationFn: (id: string) => undoMassUpdate(id),
    onSuccess: (r) => {
      toast.success(`Restored ${r.restored} ${r.restored === 1 ? 'person' : 'people'}.`);
      void batches.refetch();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not undo.'),
  });

  const onApply = async () => {
    const n = preview.data?.willChange ?? 0;
    const ok = await confirm({
      title: `Apply to ${n} ${n === 1 ? 'person' : 'people'}?`,
      description: 'One audit entry records the batch. You can undo it for 24 hours; after that each change stands on its own.',
      confirmLabel: 'Apply',
    });
    if (ok) apply.mutate();
  };

  const previewColumns: GridColumn<MassUpdatePreviewRow>[] = [
    { key: 'name', header: term('worker'), accessor: (r) => r.name, sortable: true, primary: true, className: 'text-ink' },
    {
      key: 'changes',
      header: 'Changes',
      accessor: (r) => r.changes.map((c) => `${FIELD_LABEL[c.field] ?? c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; '),
      cell: (r) => (
        <ul className="space-y-0.5 text-sm">
          {r.changes.map((c) => (
            <li key={c.field}>
              <span className="text-ink-muted">{FIELD_LABEL[c.field] ?? c.field}:</span> <span className="text-ink-muted line-through">{c.from ?? '—'}</span> <span className="text-ink">→ {c.to ?? '—'}</span>
            </li>
          ))}
        </ul>
      ),
    },
  ];

  const summarizeChanges = (c: Record<string, unknown>) =>
    [
      c.siteName !== undefined && c.siteId ? `Site → ${String(c.siteName)}` : null,
      c.departmentName !== undefined ? `Department → ${c.departmentName ? String(c.departmentName) : 'none'}` : null,
      c.managerName !== undefined ? `Manager → ${c.managerName ? String(c.managerName) : 'none'}` : null,
      c.payrollScheduleName !== undefined ? `Pay schedule → ${c.payrollScheduleName ? String(c.payrollScheduleName) : 'the schedule rules'}` : null,
      c.costCenterName !== undefined ? `Cost center → ${c.costCenterName ? String(c.costCenterName) : 'none'}` : null,
      c.jobProfileName !== undefined ? `Job profile → ${c.jobProfileName ? String(c.jobProfileName) : 'none'}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <ListTemplate
      title="Mass update"
      subtitle={`Move a group of ${term('workers').toLowerCase()} between ${term('sites').toLowerCase()}, departments, managers, ${canPaySchedule ? 'pay schedules, ' : ''}cost centers or job profiles in one step, with one audit entry and a day to undo.`}
      breadcrumbs={[{ label: term('nav.people'), to: '/people' }, { label: 'Mass update' }]}
    >
      <Stepper steps={[{ label: 'Who and what' }, { label: 'Preview' }, { label: 'Done' }]} current={step + 1} />

      {step === 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {chosen ? (
            <Card>
              <CardContent className="space-y-3">
                <SectionTitle
                  as="h2"
                  icon={Users}
                  title={`${chosenIds.length} ${chosenIds.length === 1 ? 'person' : 'people'} chosen`}
                  description={`Picked on the ${term('nav.people')} list. Only they change.`}
                />
                <ul className="flex flex-wrap gap-1.5" aria-label="Chosen people">
                  {chosenIds.slice(0, NAMES_SHOWN).map((id, i) => {
                    const p = chosenPeople[i]?.data;
                    return (
                      <li key={id}>
                        <Badge variant="outline">{p ? `${p.firstName} ${p.lastName}` : '…'}</Badge>
                      </li>
                    );
                  })}
                  {chosenIds.length > NAMES_SHOWN && (
                    <li className="text-xs text-ink-muted">and {chosenIds.length - NAMES_SHOWN} more</li>
                  )}
                </ul>
                <Link to="/people" className="text-sm text-accent hover:underline">
                  Change who
                </Link>
              </CardContent>
            </Card>
          ) : (
          <Card>
            <CardContent className="space-y-3">
              <SectionTitle as="h2" icon={Users} title="Who" description="Leave a filter blank to not narrow by it. Separated people are never included." />
              {tenant.modules.clientPortal && clients.length > 0 && (
                <Field label={term('label.client')}>{(p) => <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Any</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
              )}
              <Field label={term('site')}>{(p) => <Select {...p} value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">Any</option>{(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
              <Field label="Department">{(p) => <Select {...p} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">Any</option>{(departments.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
              <Field label="Manager">{(p) => <div {...p}><AssociatePicker value={manager} onChange={setManager} placeholder="Any manager" /></div>}</Field>
              {canPaySchedule && (
                <Field label="Pay schedule">{(p) => <Select {...p} value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}><option value="">Any</option>{(schedules.data?.schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
              )}
            </CardContent>
          </Card>
          )}
          <Card>
            <CardContent className="space-y-3">
              <SectionTitle as="h2" title="What changes" description="Only the fields you set change; the rest stay as they are." />
              <Field label={`Move to ${term('site').toLowerCase()}`} hint="Closes today's open placement and opens one at the new site.">
                {(p) => <Select {...p} value={newSiteId} onChange={(e) => setNewSiteId(e.target.value)}><option value="">Leave as is</option>{(sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
              </Field>
              <Field label="Department">{(p) => <Select {...p} value={newDepartmentId} onChange={(e) => setNewDepartmentId(e.target.value)}><option value="">Leave as is</option><option value="__none__">Clear</option>{(departments.data?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
              <Field label="Manager">
                {(p) => (
                  <div {...p} className="flex items-center gap-2">
                    <div className="flex-1">
                      <AssociatePicker value={newManager === 'clear' ? null : newManager} onChange={(v) => setNewManager(v)} placeholder="Leave as is" />
                    </div>
                    <Button size="sm" variant={newManager === 'clear' ? 'secondary' : 'ghost'} onClick={() => setNewManager(newManager === 'clear' ? null : 'clear')}>
                      {newManager === 'clear' ? 'Clearing' : 'Clear'}
                    </Button>
                  </div>
                )}
              </Field>
              {canPaySchedule && (
                <Field label="Pay schedule" hint="Someone already on a schedule moves at the new schedule's next pay period; someone on none starts today. The preview says the date.">
                  {(p) => <Select {...p} value={newScheduleId} onChange={(e) => setNewScheduleId(e.target.value)}><option value="">Leave as is</option><option value="__none__">Let the schedule rules decide</option>{(schedules.data?.schedules ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
                </Field>
              )}
              <Field label="Cost center">{(p) => <Select {...p} value={newCostCenterId} onChange={(e) => setNewCostCenterId(e.target.value)}><option value="">Leave as is</option><option value="__none__">Clear</option>{(costCenters.data?.costCenters ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>}</Field>
              <Field label="Job profile" hint="A move that changes overtime exemption, comp class or tipped code is a promotion — send it from the person's record.">
                {(p) => <Select {...p} value={newJobProfileId} onChange={(e) => setNewJobProfileId(e.target.value)}><option value="">Leave as is</option><option value="__none__">Clear</option>{(jobProfiles.data?.jobProfiles ?? []).map((j) => <option key={j.id} value={j.id}>{j.code} · {j.title}</option>)}</Select>}
              </Field>
              <div className="flex justify-end pt-2">
                <Button onClick={() => preview.mutate()} loading={preview.isPending} disabled={!hasChanges || !hasFilter}>
                  Preview
                </Button>
              </div>
              {!hasFilter && <p className="text-xs text-ink-muted">Pick at least one filter — a mass update never applies to everyone unqualified.</p>}
            </CardContent>
          </Card>
          {/* Pay rate for many at once, as one second-person approval (finance walk 13). */}
          {can('manage:comp') && (
            <div className="lg:col-span-2">
              <MassPayChange filter={filter} hasFilter={hasFilter} />
            </div>
          )}
        </div>
      )}

      {step === 1 && preview.data && (
        <Card>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-ink">
                <span className="font-medium">{preview.data.willChange}</span> of {preview.data.matched} matched {preview.data.matched === 1 ? 'person' : 'people'} will change.
                {preview.data.matched > preview.data.willChange && <span className="text-ink-muted"> The rest already have these values.</span>}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setStep(0)}>
                  Back
                </Button>
                <Button onClick={onApply} loading={apply.isPending} disabled={preview.data.willChange === 0}>
                  Apply to {preview.data.willChange}
                </Button>
              </div>
            </div>
            <DataGrid<MassUpdatePreviewRow> id="mass-update-preview" caption="Who changes" rows={preview.data.rows} rowKey={(r) => r.associateId} search={{ placeholder: 'Name…' }} urlState={false} exportCsv={{ filename: 'mass-update-preview' }} columns={previewColumns} />
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="text-sm text-ink">Applied. The batch is below; undo it within 24 hours if it was wrong.</div>
            <Button
              variant="secondary"
              onClick={() => {
                setStep(0);
                preview.reset();
                apply.reset();
              }}
            >
              Start another
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <SectionTitle as="h2" icon={Undo2} title="Recent batches" description="Each batch is one audit entry. Undo restores every person's previous values." />
        <Card>
          <CardContent className="p-3">
            <DataGrid<NonNullable<typeof batches.data>['batches'][number]>
              id="mass-update-batches"
              caption="Mass update batches"
              rows={batches.data?.batches ?? []}
              rowKey={(b) => b.id}
              loading={batches.isLoading}
              search={false}
              urlState={false}
              columns={[
                { key: 'when', header: 'Applied', accessor: (b) => b.appliedAt, sortable: true, primary: true, className: 'text-sm', cell: (b) => fmtDateTime(b.appliedAt) },
                { key: 'by', header: 'By', accessor: (b) => b.actorName ?? b.actorEmail ?? '', className: 'text-xs text-ink-muted', cell: (b) => <span title={b.actorEmail ?? undefined}>{b.actorName ?? b.actorEmail ?? ''}</span> },
                { key: 'changes', header: 'Changes', accessor: (b) => summarizeChanges(b.changes), className: 'text-sm' },
                { key: 'count', header: 'People', accessor: (b) => b.affectedCount, align: 'right', className: 'tabular-nums' },
                {
                  key: 'undo',
                  header: '',
                  accessor: (b) => (b.undoneAt ? 'undone' : b.canUndo ? 'can undo' : ''),
                  searchable: false,
                  stopRowClick: true,
                  cell: (b) =>
                    b.undoneAt ? (
                      <Badge variant="default">Undone {fmtDateTime(b.undoneAt)}</Badge>
                    ) : b.canUndo ? (
                      <Button size="sm" variant="outline" onClick={() => undo.mutate(b.id)} loading={undo.isPending}>
                        Undo
                      </Button>
                    ) : (
                      <span className="text-xs text-ink-muted">Window closed</span>
                    ),
                },
              ]}
            />
          </CardContent>
        </Card>
      </section>
    </ListTemplate>
  );
}
