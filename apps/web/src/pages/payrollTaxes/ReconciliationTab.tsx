import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Scale } from 'lucide-react';
import { getReconciliation, type ReconLine } from '@/lib/payrollTaxesApi';
import { fmtMoney } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { KIND_SHORT, ReturnBadge, quarterName, recentQuarters } from './taxShared';

/** One quarter: what payroll posted, what was paid, what the return says, and where they disagree. */
export function ReconciliationTab() {
  const quarters = recentQuarters();
  const [period, setPeriod] = useState(quarters[0]!);
  const q = useQuery({ queryKey: ['payroll-taxes', 'reconciliation', period], queryFn: () => getReconciliation(period) });
  const lines = q.data?.lines ?? [];
  const columns: GridColumn<ReconLine>[] = [
    { key: 'agency', header: 'Agency', primary: true, accessor: (l) => l.agencyLabel, cell: (l) => <span className="font-medium text-ink">{l.agencyLabel}</span>, sortable: true },
    { key: 'kind', header: 'Tax', accessor: (l) => KIND_SHORT[l.kind], cardMeta: true },
    { key: 'posted', header: 'Payroll posted', accessor: (l) => l.posted, cell: (l) => fmtMoney(l.posted), align: 'right', className: 'tabular-nums', sortable: true },
    { key: 'paid', header: 'Paid', accessor: (l) => l.paid, cell: (l) => fmtMoney(l.paid), align: 'right', className: 'tabular-nums' },
    { key: 'return', header: 'Return says', accessor: (l) => l.returnTax ?? '', cell: (l) => (l.returnTax === null ? <span className="text-ink-muted">—</span> : fmtMoney(l.returnTax)), align: 'right', className: 'tabular-nums' },
    { key: 'returnStatus', header: 'Return', accessor: (l) => l.returnStatus ?? '', cell: (l) => (l.returnKind ? <ReturnBadge status={(l.returnStatus ?? 'NOT_STARTED') as never} /> : <span className="text-ink-muted">Yearly</span>), searchable: false },
    {
      key: 'flags',
      header: 'Check',
      accessor: (l) => l.flags.join('; '),
      cell: (l) =>
        l.flags.length === 0 ? (
          <Badge variant="success">Agrees</Badge>
        ) : (
          <ul className="space-y-0.5 text-sm text-warning">
            {l.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ),
    },
  ];
  return (
    <div className="space-y-4">
      <Field label="Quarter" className="w-full sm:w-72">
        {(p) => (
          <Select {...p} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {quarters.map((x) => (
              <option key={x} value={x}>
                {quarterName(x)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {q.data && lines.length > 0 && (
        <Card className={q.data.clean ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'}>
          <CardContent className="flex items-center gap-3 py-3">
            {q.data.clean ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden /> : <Scale className="h-5 w-5 shrink-0 text-warning" aria-hidden />}
            <p className="text-sm text-ink">
              {q.data.clean
                ? `Everything payroll posted for ${quarterName(period)} is paid and matches its return.`
                : `${lines.filter((l) => l.flags.length).length} of ${lines.length} agencies need a look for ${quarterName(period)}.`}
            </p>
          </CardContent>
        </Card>
      )}
      <DataGrid<ReconLine>
        id="payroll-taxes-reconciliation"
        caption="Reconciliation"
        noun={{ one: 'agency', many: 'agencies' }}
        rows={q.data?.lines}
        loading={q.isLoading}
        error={q.isError ? (q.error as Error).message : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(l) => `${l.kind}|${l.jurisdiction}`}
        search={false}
        empty={{ icon: Scale, title: 'Nothing posted this quarter', description: 'Reconciliation fills in as payroll runs are paid.' }}
        footnote="The 941 counts both the employee’s and the employer’s Social Security and Medicare, as payroll posts them. A difference over $1 is flagged."
      />
    </div>
  );
}
