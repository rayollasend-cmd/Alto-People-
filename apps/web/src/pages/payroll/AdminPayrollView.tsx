import { useCallback, useEffect, useState } from 'react';
import type {
  PayrollRunDetail,
  PayrollRunStatus,
  PayrollRunSummary,
} from '@alto-people/shared';
import {
  createPayrollRun,
  disbursePayrollRun,
  finalizePayrollRun,
  getPayrollRun,
  listPayrollRuns,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_FILTERS: Array<{ value: PayrollRunStatus | 'ALL'; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'FINALIZED', label: 'Finalized' },
  { value: 'DISBURSED', label: 'Disbursed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
];

interface AdminPayrollViewProps {
  canProcess: boolean;
}

export function AdminPayrollView({ canProcess }: AdminPayrollViewProps) {
  const [filter, setFilter] = useState<PayrollRunStatus | 'ALL'>('DRAFT');
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [selected, setSelected] = useState<PayrollRunDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listPayrollRuns(filter === 'ALL' ? {} : { status: filter });
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openRun = async (id: string) => {
    try {
      const detail = await getPayrollRun(id);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load run.');
    }
  };

  const onFinalize = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const updated = await finalizePayrollRun(selected.id);
      setSelected(updated);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Finalize failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDisburse = async () => {
    if (!selected || busy) return;
    if (!window.confirm('Disburse this run? (Stubbed — no real funds move.)')) return;
    setBusy(true);
    try {
      const updated = await disbursePayrollRun(selected.id);
      setSelected(updated);
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Disburse failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Payroll
          </h1>
          <p className="text-silver">
            {canProcess
              ? 'Aggregate approved time, review paystubs, and disburse.'
              : 'Read-only view of payroll runs.'}
          </p>
        </div>
        {canProcess && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
          >
            {showCreate ? 'Close' : '+ New run'}
          </button>
        )}
      </header>

      {showCreate && canProcess && (
        <CreateRunForm
          onCreated={(detail) => {
            setShowCreate(false);
            setSelected(detail);
            refresh();
          }}
        />
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition',
              filter === f.value
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <h2 className="font-display text-2xl text-white mb-3">Runs</h2>
          {!runs && <p className="text-silver">Loading…</p>}
          {runs && runs.length === 0 && (
            <p className="text-silver">No runs match this filter.</p>
          )}
          {runs && runs.length > 0 && (
            <ul className="space-y-2">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => openRun(r.id)}
                    className={cn(
                      'w-full text-left p-3 rounded border transition',
                      selected?.id === r.id
                        ? 'border-gold/40 bg-gold/5'
                        : 'border-navy-secondary hover:border-silver/40'
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-white">
                        {r.periodStart} → {r.periodEnd}
                      </div>
                      <span className="text-xs uppercase tracking-widest text-silver">
                        {r.status}
                      </span>
                    </div>
                    <div className="text-xs text-silver mt-1 tabular-nums">
                      {r.itemCount} paystubs · gross {fmtMoney(r.totalGross)} · net{' '}
                      {fmtMoney(r.totalNet)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h2 className="font-display text-2xl text-white mb-3">Detail</h2>
          {!selected && <p className="text-silver">Select a run on the left.</p>}
          {selected && (
            <div className="bg-navy border border-navy-secondary rounded-lg p-4">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <div className="font-display text-xl text-white">
                  {selected.periodStart} → {selected.periodEnd}
                </div>
                <span className="text-xs uppercase tracking-widest text-silver">
                  {selected.status}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
                <div>
                  <div className="text-xs uppercase tracking-widest text-silver/60">Gross</div>
                  <div className="text-white tabular-nums">{fmtMoney(selected.totalGross)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest text-silver/60">Tax</div>
                  <div className="text-white tabular-nums">{fmtMoney(selected.totalTax)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-widest text-gold">Net</div>
                  <div className="text-gold tabular-nums">{fmtMoney(selected.totalNet)}</div>
                </div>
              </div>

              {selected.items.length === 0 && (
                <p className="text-sm text-silver">
                  No approved time entries in this period — no paystubs created.
                </p>
              )}
              {selected.items.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="text-silver text-xs uppercase tracking-widest">
                    <tr>
                      <th className="text-left py-1">Associate</th>
                      <th className="text-right py-1">Hrs</th>
                      <th className="text-right py-1">Rate</th>
                      <th className="text-right py-1">Net</th>
                      <th className="text-right py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.items.map((it) => (
                      <tr key={it.id} className="border-t border-navy-secondary/60 text-white">
                        <td className="py-2">{it.associateName ?? '—'}</td>
                        <td className="py-2 text-right tabular-nums">
                          {it.hoursWorked.toFixed(2)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmtMoney(it.hourlyRate)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {fmtMoney(it.netPay)}
                        </td>
                        <td className="py-2 text-right text-xs uppercase tracking-widest text-silver">
                          {it.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {canProcess && (
                <div className="flex gap-2 mt-4 pt-3 border-t border-navy-secondary">
                  {selected.status === 'DRAFT' && (
                    <button
                      type="button"
                      onClick={onFinalize}
                      disabled={busy}
                      className="px-3 py-1.5 rounded text-sm border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                    >
                      Finalize
                    </button>
                  )}
                  {selected.status === 'FINALIZED' && (
                    <button
                      type="button"
                      onClick={onDisburse}
                      disabled={busy}
                      className="px-3 py-1.5 rounded text-sm border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                    >
                      Disburse (stub)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface CreateRunFormProps {
  onCreated: (detail: PayrollRunDetail) => void;
}

function CreateRunForm({ onCreated }: CreateRunFormProps) {
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [defaultRate, setDefaultRate] = useState('15');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const detail = await createPayrollRun({
        periodStart,
        periodEnd,
        defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined,
        notes: notes || undefined,
      });
      onCreated(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5 space-y-3"
    >
      <h2 className="font-display text-2xl text-white">New payroll run</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Period start
          </span>
          <input
            type="date"
            required
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Period end
          </span>
          <input
            type="date"
            required
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Default rate ($/hr)
          </span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={defaultRate}
            onChange={(e) => setDefaultRate(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Notes
        </span>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={inputCls}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <div className="pt-1">
        <button
          type="submit"
          disabled={submitting}
          className={cn(
            'px-5 py-2.5 rounded font-medium transition',
            submitting
              ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
              : 'bg-gold text-navy hover:bg-gold-bright'
          )}
        >
          {submitting ? 'Aggregating…' : 'Create + aggregate'}
        </button>
      </div>
    </form>
  );
}
