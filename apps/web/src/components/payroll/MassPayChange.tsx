import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { DollarSign } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtMoney, ymdLocal } from '@/lib/format';
import { applyPayBatch, previewPayBatch, type PayBatchFilter, type PayBatchInput, type PayBatchPreview } from '@/lib/payrollDeskApi';
import { useConfirm } from '@/lib/confirm';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

/**
 * A pay change for many people at once (finance walk 13): set the rate,
 * add dollars, or add a percent, for everyone the filter names. The
 * preview shows each person's rate before → after and the margin it
 * leaves against the client's bill rate; sending it goes to a second
 * person as ONE approval (or applies at once when there is no one else).
 */
type Row = PayBatchPreview['rows'][number];

export function MassPayChange({ filter, hasFilter }: { filter: PayBatchFilter; hasFilter: boolean }) {
  const confirm = useConfirm();
  const [mode, setMode] = useState<PayBatchInput['mode']>('ADD');
  const [value, setValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => ymdLocal());
  const [reason, setReason] = useState<PayBatchInput['reason']>('MARKET_ADJUSTMENT');
  const body = (): PayBatchInput => ({ filter, mode, value: Number(value), effectiveFrom, reason });
  const valid = hasFilter && Number.isFinite(Number(value)) && Number(value) !== 0 && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);
  const preview = useMutation({ mutationFn: () => previewPayBatch(body()), onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not preview.') });
  const apply = useMutation({
    mutationFn: () => applyPayBatch(body()),
    onSuccess: (r) => {
      if (r.pending) toast.success(`Sent to a second person to approve — ${r.people} ${r.people === 1 ? 'pay change' : 'pay changes'} in one request.`);
      else toast.success(`Pay changed for ${r.applied} ${r.applied === 1 ? 'person' : 'people'}. No second approver was available; the audit says so.`);
      preview.reset();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not send the pay change.'),
  });
  const cols: GridColumn<Row>[] = [
    { key: 'name', header: 'Person', accessor: (r) => r.name, primary: true, sortable: true },
    { key: 'rate', header: 'Rate', accessor: (r) => r.to, sortable: true, className: 'tabular-nums', cell: (r) => <span>{r.from != null ? `${fmtMoney(r.from)} → ` : ''}<span className="text-ink">{fmtMoney(r.to)}</span>{r.payType === 'SALARY' ? '/yr' : '/hr'}</span> },
    { key: 'margin', header: 'Margin / hr', accessor: (r) => r.marginAfter ?? 0, sortable: true, className: 'tabular-nums', cell: (r) => (r.marginAfter == null ? '—' : <span className={cn(r.belowZeroMargin && 'text-alert')}>{r.marginBefore != null ? `${fmtMoney(r.marginBefore)} → ` : ''}{fmtMoney(r.marginAfter)}</span>) },
    { key: 'backPay', header: 'Back pay', accessor: (r) => r.backPay, align: 'right', className: 'tabular-nums', cell: (r) => (r.backPay ? fmtMoney(r.backPay) : '—') },
  ];
  const p = preview.data;
  return (
    <Card>
      <CardContent className="space-y-3">
        <SectionTitle as="h2" icon={DollarSign} title="Pay rate" description="Change the pay rate for everyone the filter names — one approval for the whole change." />
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Change">
            {(fp) => (
              <Select value={mode} onChange={(e) => setMode(e.target.value as PayBatchInput['mode'])} {...fp}>
                <option value="SET">Set to $ / hr</option>
                <option value="ADD">Add $ / hr</option>
                <option value="PCT">Add %</option>
              </Select>
            )}
          </Field>
          <Field label={mode === 'PCT' ? 'Percent' : 'Dollars'}>
            {(fp) => <Input type="number" inputMode="decimal" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'PCT' ? '3' : mode === 'SET' ? '15.00' : '0.50'} {...fp} />}
          </Field>
          <Field label="Effective from">{(fp) => <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} {...fp} />}</Field>
          <Field label="Reason">
            {(fp) => (
              <Select value={reason} onChange={(e) => setReason(e.target.value as PayBatchInput['reason'])} {...fp}>
                <option value="MARKET_ADJUSTMENT">Market adjustment</option>
                <option value="MERIT">Merit</option>
                <option value="PROMOTION">Promotion</option>
                <option value="CORRECTION">Correction</option>
                <option value="OTHER">Other</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => preview.mutate()} loading={preview.isPending} disabled={!valid}>
            Preview pay change
          </Button>
          {!hasFilter && <span className="text-xs text-ink-muted">Pick who first — a pay change never applies to everyone unqualified.</span>}
        </div>
        {p && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge>{p.willChange} of {p.matched} change</Badge>
              {p.totals.negativeMargin > 0 && <Badge variant="destructive">{p.totals.negativeMargin} below the bill rate</Badge>}
              {p.totals.backPay > 0 && <Badge variant="pending">{fmtMoney(p.totals.backPay)} back pay</Badge>}
              {p.skipped.length > 0 && <Badge variant="outline">{p.skipped.length} skipped</Badge>}
            </div>
            <DataGrid id="mass-pay-change" caption="Pay change preview" rows={p.rows} rowKey={(r) => r.associateId} columns={cols} noun={{ one: 'person', many: 'people' }} defaultSort={{ key: 'name', direction: 'asc' }} empty={{ title: 'No one would change', description: 'Everyone matched already has that rate, or was skipped.' }} />
            {p.skipped.length > 0 && (
              <ul className="space-y-0.5 text-xs text-ink-muted" aria-label="Skipped">
                {p.skipped.slice(0, 8).map((s) => (
                  <li key={s.associateId}>
                    {s.name}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
            <Button
              disabled={p.willChange === 0 || apply.isPending}
              loading={apply.isPending}
              onClick={async () => {
                if (await confirm({ title: `Change pay for ${p.willChange} ${p.willChange === 1 ? 'person' : 'people'}?`, description: 'It goes to a second person as one approval. Nothing changes until they approve.', confirmLabel: 'Send for approval' })) apply.mutate();
              }}
            >
              Send for approval
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
