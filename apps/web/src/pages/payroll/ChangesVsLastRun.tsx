import type { PayrollRunPreviewResponse } from '@alto-people/shared';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

/**
 * Changes against the last regular run on the same schedule, before this
 * run exists (finance walk 9): who moved more than 15%, who is new, who is
 * missing, and a Δ per person — caught here instead of by a void later.
 */
export function ChangesVsLastRun({ preview }: { preview: PayrollRunPreviewResponse }) {
  const prev = preview.previous;
  if (!prev) {
    return <p className="text-xs text-ink-muted">No earlier regular run on this schedule to compare against.</p>;
  }
  const lastBy = new Map(prev.byAssociate.map((b) => [b.associateId, b]));
  const movedIds = new Set(prev.moved.map((m) => m.associateId));
  const newIds = new Set(prev.newPeople.map((n) => n.associateId));
  const netNow = preview.totals.totalNet;
  const delta = netNow - prev.net;
  const rows = preview.items
    .map((i) => {
      const last = lastBy.get(i.associateId);
      return { id: i.associateId, name: i.associateName, last: last?.net ?? null, now: i.netPay, d: last ? i.netPay - last.net : null };
    })
    .sort((a, b) => Math.abs(b.d ?? Infinity) - Math.abs(a.d ?? Infinity));
  return (
    <section aria-label="Changes vs last run" className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">
          Changes vs {fmtDate(prev.periodStart)} – {fmtDate(prev.periodEnd)}
        </h3>
        <span className={cn('text-xs tabular-nums', Math.abs(delta) >= 0.01 ? (delta > 0 ? 'text-warning' : 'text-ink-muted') : 'text-ink-muted')}>
          Net {fmtMoney(prev.net)} → {fmtMoney(netNow)} ({delta >= 0 ? '+' : '−'}
          {fmtMoney(Math.abs(delta))}) · {prev.people} → {preview.items.length} people
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {prev.moved.length > 0 && <Badge variant="pending">{prev.moved.length} {prev.moved.length === 1 ? 'person' : 'people'} moved &gt;15%</Badge>}
        {prev.newPeople.length > 0 && <Badge variant="info">{prev.newPeople.length} new: {prev.newPeople.slice(0, 3).map((n) => n.associateName).join(', ')}{prev.newPeople.length > 3 ? '…' : ''}</Badge>}
        {prev.missing.length > 0 && <Badge variant="destructive">{prev.missing.length} missing: {prev.missing.slice(0, 3).map((n) => n.associateName).join(', ')}{prev.missing.length > 3 ? '…' : ''}</Badge>}
        {prev.moved.length === 0 && prev.newPeople.length === 0 && prev.missing.length === 0 && <Badge variant="success">Same people, no one moved more than 15%</Badge>}
      </div>
      {rows.length > 0 && (
        <div className="max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 font-normal">Person</th>
                <th className="py-1 text-right font-normal">Last net</th>
                <th className="py-1 text-right font-normal">This net</th>
                <th className="py-1 text-right font-normal">Δ</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => (
                <tr key={r.id} className={cn(movedIds.has(r.id) && 'text-warning', newIds.has(r.id) && 'text-info')}>
                  <td className="py-0.5 text-ink">{r.name}</td>
                  <td className="py-0.5 text-right">{r.last == null ? 'new' : fmtMoney(r.last)}</td>
                  <td className="py-0.5 text-right">{fmtMoney(r.now)}</td>
                  <td className="py-0.5 text-right">{r.d == null ? '—' : `${r.d >= 0 ? '+' : '−'}${fmtMoney(Math.abs(r.d))}`}</td>
                </tr>
              ))}
              {prev.missing.map((m) => (
                <tr key={m.associateId} className="text-alert">
                  <td className="py-0.5">{m.associateName}</td>
                  <td className="py-0.5 text-right">{fmtMoney(m.net)}</td>
                  <td className="py-0.5 text-right">not in this run</td>
                  <td className="py-0.5 text-right">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
