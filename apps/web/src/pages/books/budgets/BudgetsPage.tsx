import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Target } from 'lucide-react';
import type { BudgetSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { createBudget, listBudgets } from '@/lib/books/closeApi';
import { fmtDate, fmtMoneyWhole } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { toast } from '@/components/ui/Toaster';

export const BUDGET_STATUS: Record<string, { label: string; variant: 'success' | 'pending' | 'default' }> = {
  ACTIVE: { label: 'Active', variant: 'success' },
  DRAFT: { label: 'Draft', variant: 'pending' },
  ARCHIVED: { label: 'Archived', variant: 'default' },
};

/** Budgets by fiscal year — one active per year — each opening to its grid and budget vs actual. */
export function BudgetsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const manage = can('manage:books');
  const q = useQuery({ queryKey: ['books', 'budgets'], queryFn: listBudgets });
  const [open, setOpen] = useState(false);
  const budgets = q.data?.budgets ?? [];
  const year = new Date().getFullYear();
  const active = budgets.find((b) => b.status === 'ACTIVE' && b.fiscalYear === year) ?? null;

  const columns: GridColumn<BudgetSummary>[] = [
    { key: 'name', header: 'Budget', accessor: (b) => b.name, primary: true, sortable: true, cell: (b) => <span className="font-medium text-ink">{b.name}</span> },
    { key: 'year', header: 'Year', accessor: (b) => b.fiscalYear, sortable: true, cardMeta: true, className: 'tabular-nums' },
    { key: 'status', header: 'Status', accessor: (b) => b.status, cell: (b) => <Badge size="sm" variant={BUDGET_STATUS[b.status]?.variant ?? 'default'}>{BUDGET_STATUS[b.status]?.label ?? b.status}</Badge> },
    { key: 'income', header: 'Income', accessor: (b) => b.totalIncome, align: 'right', className: 'tabular-nums', sortable: true, cell: (b) => fmtMoneyWhole(b.totalIncome) },
    { key: 'expense', header: 'Costs and expenses', accessor: (b) => b.totalExpense, align: 'right', className: 'tabular-nums', cell: (b) => fmtMoneyWhole(b.totalExpense) },
    { key: 'net', header: 'Net', accessor: (b) => b.net, align: 'right', className: 'tabular-nums', sortable: true, cell: (b) => <span className={b.net < 0 ? 'text-alert' : 'text-ink'}>{fmtMoneyWhole(b.net)}</span> },
    { key: 'updated', header: 'Updated', accessor: (b) => b.updatedAt, defaultHidden: true, cell: (b) => fmtDate(b.updatedAt) },
  ];

  return (
    <ListTemplate
      title="Budgets"
      subtitle="The year’s plan by account and month, read against what actually happened."
      actions={[{ label: 'New budget', icon: Plus, primary: true, hidden: !manage, onSelect: () => setOpen(true) }]}
      summary={
        // Nothing to sum until a budget exists — the empty list says what to do.
        <MetricStrip label="Budgets at a glance" empty={!q.isSuccess || budgets.length === 0}>
          <MetricCard label={`Active for ${year}`} value={active ? active.name : '—'} tone="neutral" href={active ? `/books/budgets/${active.id}` : undefined} nothing={active ? undefined : `No budget active for ${year}`} hint={active ? undefined : 'Make one active to read it against actuals'} />
          <MetricCard label="Planned income" value={active ? fmtMoneyWhole(active.totalIncome) : '—'} tone="neutral" nothing={active ? undefined : 'No active budget'} />
          <MetricCard label="Planned net" value={active ? fmtMoneyWhole(active.net) : '—'} tone={active && active.net < 0 ? 'alert' : 'default'} nothing={active ? undefined : 'No active budget'} />
        </MetricStrip>
      }
    >
      <DataGrid
        id="books-budgets"
        caption="Budgets"
        noun={{ one: 'budget', many: 'budgets' }}
        rows={q.data ? budgets : null}
        loading={q.isLoading}
        error={q.error ? 'Couldn’t load the budgets.' : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(b) => b.id}
        rowHref={(b) => `/books/budgets/${b.id}`}
        empty={{ icon: Target, title: 'No budgets yet', description: 'Start one from last year’s actuals, or from a blank grid.', action: manage ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden="true" />New budget</Button> : undefined }}
      />
      <NewBudgetDialog open={open} onOpenChange={setOpen} onMade={(id) => navigate(`/books/budgets/${id}`)} />
    </ListTemplate>
  );
}

function NewBudgetDialog({ open, onOpenChange, onMade }: { open: boolean; onOpenChange: (o: boolean) => void; onMade: (id: string) => void }) {
  const qc = useQueryClient();
  const year = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState(year + (new Date().getMonth() >= 9 ? 1 : 0));
  const [name, setName] = useState('');
  const [fromActuals, setFromActuals] = useState(true);
  const [growth, setGrowth] = useState('5');
  const make = useMutation({
    mutationFn: () => createBudget({ name: name.trim() || `${fiscalYear} budget`, fiscalYear, ...(fromActuals ? { fromActuals: { growthPct: Number(growth) || 0 } } : {}) }),
    onSuccess: ({ budget }) => {
      void qc.invalidateQueries({ queryKey: ['books', 'budgets'] });
      toast.success(budget.lineCount ? `Started from ${fiscalYear - 1} actuals.` : 'Budget created.');
      onOpenChange(false);
      onMade(budget.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the budget.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New budget</DialogTitle>
          <DialogDescription>A plan for one fiscal year. You can activate it once it’s ready.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fiscal year">{(p) => <Input type="number" min={2000} max={2100} value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))} {...p} />}</Field>
          <Field label="Name">{(p) => <Input value={name} placeholder={`${fiscalYear} budget`} maxLength={120} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
        </div>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={fromActuals} onChange={(e) => setFromActuals(e.target.checked)} />
          <span>
            <span className="block font-medium text-ink">Start from {fiscalYear - 1} actuals</span>
            <span className="block text-ink-muted">Every income and expense account, month by month, as the books have it.</span>
          </span>
        </label>
        {fromActuals && <Field label="Grown by (%)">{(p) => <Input type="number" step="0.5" value={growth} onChange={(e) => setGrowth(e.target.value)} {...p} />}</Field>}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => make.mutate()} loading={make.isPending} disabled={!fiscalYear}>
            Create budget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
