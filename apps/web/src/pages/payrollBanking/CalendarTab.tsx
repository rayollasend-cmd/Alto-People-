import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarDays, Plus, X } from '@/components/ui/icons';
import { addHolidayOverride, clockText, etDeadline, getPayrollCalendar, removeHolidayOverride, shortDay, type CalendarRow } from '@/lib/bankingApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';

/**
 * The payroll calendar: every pay date the schedules produce this year,
 * where a weekend or bank holiday moved it, and when the file and the
 * money have to move.
 */
export function CalendarTab() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const q = useQuery({ queryKey: ['payroll-banking', 'calendar', year], queryFn: () => getPayrollCalendar(year) });

  const cols: GridColumn<CalendarRow>[] = [
    {
      key: 'payDate',
      header: 'Pay date',
      primary: true,
      accessor: (r) => r.payDate,
      sortable: true,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium text-ink">{shortDay(r.payDate)}</span>
          {r.shiftReason && <span className="text-xs text-warning">{`Moved from ${shortDay(r.nominalPayDate)} · ${r.shiftReason}`}</span>}
        </span>
      ),
    },
    { key: 'schedule', header: 'Schedule', accessor: (r) => r.scheduleName, cardMeta: true },
    { key: 'period', header: 'Pays for', accessor: (r) => r.periodStart, cell: (r) => `${shortDay(r.periodStart)} – ${shortDay(r.periodEnd)}` },
    { key: 'funding', header: 'Fund by', accessor: (r) => r.fundingDeadline, cell: (r) => etDeadline(r.fundingDeadline), sortable: true },
    { key: 'file', header: 'Pay file to bank', accessor: (r) => r.creditSubmitDate, cell: (r) => shortDay(r.creditSubmitDate) },
  ];
  const moved = q.data?.rows.filter((r) => r.shiftReason).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<string>
          ariaLabel="Calendar year"
          value={String(year)}
          onChange={(v) => setYear(Number(v))}
          options={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) }))}
        />
        {q.data && (
          <p className="text-sm text-ink-muted">{`${q.data.rows.length} pay date${q.data.rows.length === 1 ? '' : 's'}${moved ? `, ${moved} moved for a weekend or holiday` : ''}. Deadlines use your ${clockText(q.data.cutoffEt)} ET bank cutoff.`}</p>
        )}
      </div>
      <DataGrid<CalendarRow>
        id="payroll-banking-calendar"
        caption="Payroll calendar"
        noun={{ one: 'pay date', many: 'pay dates' }}
        rows={q.data?.rows}
        loading={q.isLoading}
        error={q.isError ? (q.error as Error).message : null}
        onRetry={() => void q.refetch()}
        columns={cols}
        rowKey={(r) => `${r.scheduleId}|${r.payDate}`}
        defaultSort={{ key: 'payDate', direction: 'asc' }}
        rowClassName={(r) => (r.shiftReason ? 'bg-warning/5' : undefined)}
        empty={{ icon: CalendarDays, title: 'No pay schedules', description: 'Add a pay schedule in Payroll and its pay dates appear here.' }}
        exportCsv={{ filename: `payroll-calendar-${year}` }}
      />
      <HolidaysCard year={year} />
    </div>
  );
}

function HolidaysCard({ year }: { year: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-banking', 'calendar', year], queryFn: () => getPayrollCalendar(year) });
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [closed, setClosed] = useState('closed');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll-banking', 'calendar'] });
  const add = useMutation({
    mutationFn: () => addHolidayOverride({ date, name: name.trim(), closed: closed === 'closed' }),
    onSuccess: () => {
      toast.success(closed === 'closed' ? 'Pay dates and deadlines now skip that day.' : 'That day now counts as a banking day.');
      setDate('');
      setName('');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (id: string) => removeHolidayOverride(id), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const overrideByDate = new Map((q.data?.overrides ?? []).map((o) => [o.date, o]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{`Bank holidays in ${year}`}</CardTitle>
        <CardDescription>The Federal Reserve’s holidays, plus any day your own bank is closed. A Saturday holiday leaves the Friday open.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {(q.data?.holidays ?? []).map((h) => {
            const o = overrideByDate.get(h.date);
            return (
              <li key={`${h.source}|${h.date}`} className="flex items-center gap-2 text-sm">
                <span className="w-28 shrink-0 tabular-nums text-ink-muted">{shortDay(h.date)}</span>
                <span className="min-w-0 flex-1 text-ink">{h.name}</span>
                {h.source === 'OVERRIDE' && <Badge variant={h.closed ? 'pending' : 'info'} size="sm">{h.closed ? 'Your bank' : 'Open'}</Badge>}
                {o && (
                  <Button size="xs" variant="ghost" onClick={() => remove.mutate(o.id)} aria-label={`Remove ${h.name} on ${shortDay(h.date)}`}>
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="grid gap-3 sm:grid-cols-[10rem_1fr_9rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (date && name.trim()) add.mutate();
          }}
        >
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} min={`${year}-01-01`} max={`${year}-12-31`} />
          </Field>
          <Field label="Why">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Bank closed for a storm" />
          </Field>
          <Field label="The bank is">
            <Select value={closed} onChange={(e) => setClosed(e.target.value)}>
              <option value="closed">Closed</option>
              <option value="open">Open</option>
            </Select>
          </Field>
          <Button type="submit" variant="outline" loading={add.isPending} disabled={!date || !name.trim()}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add day
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
