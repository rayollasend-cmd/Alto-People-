import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useTenant, useTerm } from '@/lib/auth';
import { useClients } from '@/lib/useClients';
import { fmtMoney } from '@/lib/format';
import { getHeadcountPlan, type PlanDepartment, type PlanPosition } from '@/lib/positionsApi';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StaffingPlanView } from './StaffingPlan';
import { cn } from '@/lib/cn';

/**
 * The headcount plan (HR pack 2026-10): every seat's budget beside what it
 * really costs — the person's current pay annualized, and what payroll has
 * paid them this year. Variance is budget minus projected: red is a seat
 * running over its plan. Rolled up by department, then every position.
 */

function varianceCell(v: number | null) {
  if (v === null) return <span className="text-xs text-ink-muted">Not budgeted</span>;
  return <span className={cn('tabular-nums', v < 0 ? 'text-alert' : 'text-success')}>{v < 0 ? '−' : '+'}{fmtMoney(Math.abs(v))}</span>;
}

/** The office seats: each staff position's budget against what it costs (the original plan). */
function OfficeSeats() {
  const term = useTerm();
  const tenant = useTenant();
  const { clients } = useClients({ enabled: tenant.modules.clientPortal });
  const [clientId, setClientId] = useState('');
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const plan = useQuery({ queryKey: ['positions', 'plan', clientId, year], queryFn: () => getHeadcountPlan({ clientId: clientId || undefined, year }) });
  const d = plan.data;
  const error = plan.error ? (plan.error instanceof ApiError ? plan.error.message : 'Could not load the plan.') : null;

  const deptColumns: GridColumn<PlanDepartment>[] = [
    { key: 'dept', header: 'Department', accessor: (r) => r.departmentName, sortable: true, primary: true, className: 'text-ink' },
    { key: 'positions', header: 'Seats', accessor: (r) => r.positions, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => `${r.filled} of ${r.positions} filled` },
    { key: 'budget', header: 'Budget', accessor: (r) => r.budget, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.budget) },
    { key: 'projected', header: 'Projected cost', accessor: (r) => r.projected, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.projected) },
    { key: 'paid', header: `Paid ${year} to date`, accessor: (r) => r.paidYearToDate, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.paidYearToDate) },
    { key: 'variance', header: 'Variance', accessor: (r) => r.variance, sortable: true, searchable: false, align: 'right', cell: (r) => varianceCell(r.variance) },
    { key: 'unbudgeted', header: 'Unbudgeted', accessor: (r) => r.unbudgeted, sortable: true, searchable: false, align: 'right', cell: (r) => (r.unbudgeted > 0 ? <Badge variant="pending">{r.unbudgeted}</Badge> : '—') },
  ];
  const posColumns: GridColumn<PlanPosition>[] = [
    { key: 'code', header: 'Position', accessor: (r) => `${r.code} ${r.title}`, sortable: true, primary: true, cell: (r) => (
      <>
        <div className="text-ink">{r.title}</div>
        <div className="text-xs text-ink-muted">{r.code} · {r.departmentName ?? 'No department'}</div>
      </>
    ) },
    { key: 'person', header: term('worker'), accessor: (r) => r.filledByName ?? '', cardMeta: true, cell: (r) => (r.filledByAssociateId && r.filledByName ? <AssociateLink associateId={r.filledByAssociateId}>{r.filledByName}</AssociateLink> : <span className="text-xs text-ink-muted">Open · {r.fteAuthorized} FTE</span>) },
    { key: 'budget', header: 'Budget / year', accessor: (r) => r.annualBudget ?? '', sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.annualBudget === null ? <span className="text-xs text-ink-muted">—</span> : `${fmtMoney(r.annualBudget)}${r.budgetPeriod === 'MONTHLY' ? ' (monthly ×12)' : ''}`) },
    { key: 'projected', header: 'Projected / year', accessor: (r) => r.projectedAnnualCost ?? '', sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.projectedAnnualCost === null ? '—' : fmtMoney(r.projectedAnnualCost)) },
    { key: 'paid', header: 'Paid to date', accessor: (r) => r.paidYearToDate, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.paidYearToDate) },
    { key: 'variance', header: 'Variance', accessor: (r) => r.variance ?? '', sortable: true, searchable: false, align: 'right', cell: (r) => varianceCell(r.variance) },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        {tenant.modules.clientPortal && clients.length > 0 && (
          <Select size="sm" aria-label={term('label.client')} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">All {term('label.clients').toLowerCase()}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <Select size="sm" aria-label="Year" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
          {[0, 1, 2].map((back) => {
            const y = new Date().getUTCFullYear() - back;
            return (
              <option key={y} value={y}>
                {y}
              </option>
            );
          })}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Budgeted" value={d ? fmtMoney(d.totals.budget) : '—'} hint={d ? `${d.totals.positions - d.totals.unbudgeted} of ${d.totals.positions} seats carry a budget` : undefined} />
        <MetricCard label="Projected cost" value={d ? fmtMoney(d.totals.projected) : '—'} hint="Current pay, annualized" />
        <MetricCard label={`Paid ${year} to date`} value={d ? fmtMoney(d.totals.paidYearToDate) : '—'} hint="Gross on finalized runs" />
        <MetricCard label="Variance" value={d ? varianceCell(d.totals.variance) : '—'} accent={Boolean(d && d.totals.variance < 0)} hint={d && d.totals.unbudgeted > 0 ? `${d.totals.unbudgeted} seats have no budget yet` : 'Budget minus projected'} />
      </div>
      {error && <QueryError what="the headcount plan" query={plan} />}
      <section className="space-y-3">
        <SectionTitle as="h2" icon={Wallet} title="By department" />
        <Card>
          <CardContent className="p-3">
            <DataGrid<PlanDepartment> id="headcount-plan-departments" caption="Plan by department" rows={d?.departments ?? []} rowKey={(r) => r.departmentId ?? 'none'} loading={plan.isLoading} search={false} urlState={false} exportCsv={{ filename: `headcount-plan-${year}-departments` }} columns={deptColumns} />
          </CardContent>
        </Card>
      </section>
      <section className="space-y-3">
        <SectionTitle as="h2" title="Every position" description="Set a seat's budget on the position itself (Departments & job profiles › Positions)." />
        <Card>
          <CardContent className="p-3">
            <DataGrid<PlanPosition> id="headcount-plan-positions" caption="Plan by position" rows={d?.positions ?? []} rowKey={(r) => r.id} loading={plan.isLoading} search={{ placeholder: 'Position, person…' }} urlState={false} exportCsv={{ filename: `headcount-plan-${year}` }} columns={posColumns} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/**
 * The headcount plan, two ways: Staffing (heads required against heads in
 * place, place by place and week by week — the plan a staffing company
 * runs on) and Office seats (each staff position's budget).
 */
export function HeadcountPlan() {
  const term = useTerm();
  const [params, setParams] = useSearchParams();
  const tab: 'staffing' | 'office' = params.get('tab') === 'office' ? 'office' : 'staffing';
  return (
    <ListTemplate
      title="Headcount plan"
      subtitle={
        tab === 'staffing'
          ? `Heads required against heads in place, ${term('label.store').toLowerCase()} by ${term('label.store').toLowerCase()} and week by week — priced at today’s rates.`
          : 'Each office seat’s budget against what it costs: the person’s pay annualized, and what payroll has actually paid this year.'
      }
      breadcrumbs={[{ label: 'Headcount', to: '/headcount' }, { label: 'Headcount plan' }]}
      // Navigation is a link, not the page's primary button (the crumb above
      // already goes back to Headcount).
      related={[{ label: 'Season planner', to: '/season-planner' }]}
      filters={
        <SegmentedControl
          ariaLabel="Which plan"
          value={tab}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === 'staffing') next.delete('tab');
            else next.set('tab', v);
            setParams(next, { replace: true });
          }}
          options={[
            { value: 'staffing' as const, label: 'Staffing' },
            { value: 'office' as const, label: 'Office seats' },
          ]}
        />
      }
    >
      {tab === 'staffing' ? <StaffingPlanView /> : <OfficeSeats />}
    </ListTemplate>
  );
}
