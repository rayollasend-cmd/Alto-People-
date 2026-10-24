import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageX, Pencil } from '@/components/ui/icons';
import { FIXED_ASSET_CATEGORY_LABELS, type FixedAssetDetail } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { disposeFixedAsset, getFixedAsset, updateFixedAsset } from '@/lib/books/closeApi';
import { fmtDate, fmtMoney, fmtMonthShortYear, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import type { PageFact } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { AccountSelect } from '../close/closeKit';
import { AssetStatusBadge, METHOD_LABEL, lifeLabel } from './assetKit';

// Mid-month, midday: no display time zone moves it into the next or last month.
const monthLabel = (k: string) => fmtMonthShortYear(`${k}-15T12:00:00.000Z`);

/** One fixed asset: what it is, its accounts, the schedule month by month, and disposal. */
export function FixedAssetDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { can } = useAuth();
  const manage = can('manage:books');
  const [tab, setTab] = useState('schedule');
  const [disposing, setDisposing] = useState(false);
  const [editing, setEditing] = useState(false);
  const q = useQuery({
    queryKey: ['books', 'assets', id],
    queryFn: () => getFixedAsset(id),
  });
  const a = q.data?.asset;

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error || !a) return <EmptyState title="Couldn’t load this asset" description={q.error instanceof ApiError ? q.error.message : 'Try again in a moment.'} />;

  const posted = a.schedule.filter((m) => m.posted).length;
  const remaining = a.schedule.length - posted;
  const linked = linkedRecord(a, can);
  const facts: PageFact[] = [
    { label: 'In service', value: fmtDate(a.inServiceOn) },
    ...(a.linkedLabel ? [{ label: a.vanId ? 'Van' : 'Equipment', value: a.linkedLabel, to: linked ?? undefined }] : []),
    { label: 'Life', value: `${lifeLabel(a.usefulLifeMonths)} · ${METHOD_LABEL[a.method]}` },
  ];

  return (
    <>
      <RecordTemplate
        title={a.name}
        subtitle={FIXED_ASSET_CATEGORY_LABELS[a.category]}
        facts={facts}
        status={<AssetStatusBadge status={a.status} size="lg" />}
        actions={
          manage && a.status !== 'DISPOSED'
            ? [
                { label: 'Edit', icon: Pencil, onSelect: () => setEditing(true) },
                // The dispose dialog is its own confirmation: date, proceeds, the gain or loss.
                { label: 'Dispose', icon: PackageX, destructive: true, onSelect: () => setDisposing(true) },
              ]
            : undefined
        }
        summary={
          <MetricStrip label={`${a.name} at a glance`}>
            <MetricCard label="Cost" value={fmtMoney(a.cost)} hint={a.salvageValue ? `Salvage ${fmtMoney(a.salvageValue)}` : undefined} tone="neutral" />
            <MetricCard label="Depreciated" value={fmtMoney(a.accumulated)} hint={`${posted} of ${a.schedule.length} months`} tone="neutral" />
            <MetricCard label="Book value" value={fmtMoney(a.netBookValue)} />
            <MetricCard
              label={a.status === 'DISPOSED' ? 'Disposed' : 'Months left'}
              value={a.status === 'DISPOSED' ? (a.disposedOn ? fmtDate(a.disposedOn) : '—') : remaining}
              hint={a.status === 'DISPOSED' ? (a.disposalProceeds ? `Sold for ${fmtMoney(a.disposalProceeds)}` : 'No proceeds') : undefined}
              tone="neutral"
            />
          </MetricStrip>
        }
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          {
            key: 'schedule',
            label: 'Depreciation schedule',
            count: a.duePeriods || undefined,
            content: <Schedule asset={a} />,
          },
          { key: 'details', label: 'Details', content: <Details asset={a} /> },
        ]}
      />
      <DisposeDialog asset={a} open={disposing} onOpenChange={setDisposing} />
      {editing && <EditDialog asset={a} open={editing} onOpenChange={setEditing} />}
    </>
  );
}

/**
 * Where the asset's own record is: a van on the fleet list, recorded
 * equipment in Assets — for someone who can open it; otherwise the label
 * stays plain text.
 */
export function linkedRecord(a: Pick<FixedAssetDetail, 'vanId' | 'assetId'>, can: (cap: 'view:transport' | 'view:org') => boolean): string | null {
  if (a.vanId) return can('view:transport') ? '/transport?tab=vans' : null;
  if (a.assetId) return can('view:org') ? '/assets' : null;
  return null;
}

function Schedule({ asset: a }: { asset: FixedAssetDetail }) {
  if (a.schedule.length === 0) return <EmptyState title="No depreciation" description="Cost and salvage value are the same, so there’s nothing to depreciate." />;
  const current = ymdLocal().slice(0, 7);
  return (
    <Card>
      <CardContent className="pt-[var(--d-tile)]">
        {/* Below sm: one line per month, the book value on the right where it stays on screen. */}
        <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto sm:hidden" aria-label="Depreciation schedule">
          {a.schedule.map((m) => (
            <li key={m.periodKey} className={cn('flex items-start justify-between gap-3 py-2', m.periodKey === current && 'bg-gold/[0.06]')}>
              <span className="min-w-0">
                <span className="block text-sm text-ink">{monthLabel(m.periodKey)}</span>
                <span className="block text-xs text-ink-muted">
                  {fmtMoney(m.amount)} · {m.posted ? (m.postedLate ? 'posted late' : 'posted') : m.periodKey < current && a.status === 'ACTIVE' ? <span className="text-warning">due</span> : 'not yet'}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm tabular-nums text-ink">{fmtMoney(m.netBookValue)}</span>
                <span className="block text-2xs text-ink-muted">book value</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="hidden max-h-[32rem] overflow-y-auto sm:block">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-2 pr-3 font-medium">Month</th>
                <th className="py-2 pr-3 text-right font-medium">Depreciation</th>
                <th className="py-2 pr-3 text-right font-medium">To date</th>
                <th className="py-2 pr-3 text-right font-medium">Book value</th>
                <th className="py-2 font-medium">Posted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {a.schedule.map((m) => (
                <tr key={m.periodKey} className={cn(m.periodKey === current && 'bg-gold/[0.06]')}>
                  <td className="py-1.5 pr-3 text-ink">{monthLabel(m.periodKey)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{fmtMoney(m.amount)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink-muted">{fmtMoney(m.accumulated)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{fmtMoney(m.netBookValue)}</td>
                  <td className="py-1.5">
                    {m.posted ? (
                      <span className="inline-flex items-center gap-2">
                        {m.entryId ? (
                          <Link to={`/books/journal/${m.entryId}`} className="text-gold hover:underline">
                            Posted
                          </Link>
                        ) : (
                          <span className="text-success">Posted</span>
                        )}
                        {m.postedLate && (
                          <Badge size="sm" variant="pending" withDot={false}>
                            Posted late
                          </Badge>
                        )}
                      </span>
                    ) : m.periodKey < current && a.status === 'ACTIVE' ? (
                      <span className="text-warning">Due</span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Details({ asset: a }: { asset: FixedAssetDetail }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Acquired', fmtDate(a.acquiredOn)],
    ['In service', fmtDate(a.inServiceOn)],
    ['Method', METHOD_LABEL[a.method]],
    ['Useful life', lifeLabel(a.usefulLifeMonths)],
    [
      'Asset account',
      <Link key="a" to={`/books/accounts/${a.assetAccountId}`} className="text-gold hover:underline">
        {a.accounts.asset}
      </Link>,
    ],
    [
      'Accumulated depreciation',
      <Link key="b" to={`/books/accounts/${a.accumulatedAccountId}`} className="text-gold hover:underline">
        {a.accounts.accumulated}
      </Link>,
    ],
    [
      'Depreciation expense',
      <Link key="c" to={`/books/accounts/${a.expenseAccountId}`} className="text-gold hover:underline">
        {a.accounts.expense}
      </Link>,
    ],
    [
      'Put on the books',
      a.acquisitionEntryId ? (
        <Link key="d" to={`/books/journal/${a.acquisitionEntryId}`} className="text-gold hover:underline">
          Acquisition entry
        </Link>
      ) : (
        'By a bill or earlier entry'
      ),
    ],
    ...(a.disposalEntryId
      ? ([
          [
            'Disposal',
            <Link key="e" to={`/books/journal/${a.disposalEntryId}`} className="text-gold hover:underline">
              Disposal entry
            </Link>,
          ],
        ] as Array<[string, React.ReactNode]>)
      : []),
    ['Notes', a.notes ?? '—'],
  ];
  return (
    <Card>
      <CardContent className="pt-[var(--d-tile)]">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs uppercase tracking-wide text-ink-muted">{k}</dt>
              <dd className="mt-0.5 text-sm text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function DisposeDialog({ asset: a, open, onOpenChange }: { asset: FixedAssetDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [on, setOn] = useState(ymdLocal());
  const [proceeds, setProceeds] = useState('');
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const amount = Number(proceeds) || 0;
  const save = useMutation({
    mutationFn: () =>
      disposeFixedAsset(a.id, {
        disposedOn: on,
        proceeds: amount,
        proceedsAccountId: amount > 0 ? account : undefined,
        note: note.trim() || undefined,
      }),
    onSuccess: ({ asset }) => {
      qc.setQueryData(['books', 'assets', a.id], { asset });
      void qc.invalidateQueries({ queryKey: ['books', 'assets'] });
      toast.success(`${asset.name} is off the books.`);
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not dispose of the asset.'),
  });
  const gain = amount - a.netBookValue;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispose of {a.name}</DialogTitle>
          <DialogDescription>Depreciation runs through the month before; the cost and its depreciation come off the books, and any difference from the proceeds is a gain or loss.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Disposed on">{(p) => <Input type="date" value={on} min={a.inServiceOn} onChange={(e) => setOn(e.target.value)} {...p} />}</Field>
          <Field label="Proceeds" hint="What it sold for (0 if scrapped)">
            {(p) => <Input type="number" inputMode="decimal" min="0" step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)} {...p} />}
          </Field>
        </div>
        {amount > 0 && <Field label="Deposited to">{(p) => <AccountSelect value={account} onChange={setAccount} types={['ASSET']} subtypes={['BANK', 'CURRENT_ASSET']} {...p} />}</Field>}
        <Field label="Note">{(p) => <Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} {...p} />}</Field>
        <p className="text-sm text-ink-muted">
          Book value today {fmtMoney(a.netBookValue)} — {gain === 0 ? 'no gain or loss' : gain > 0 ? `about ${fmtMoney(gain)} gain` : `about ${fmtMoney(-gain)} loss`} (exact once depreciation through
          the month before is posted).
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => save.mutate()} loading={save.isPending} disabled={!on || (amount > 0 && !account)}>
            Dispose
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ asset: a, open, onOpenChange }: { asset: FixedAssetDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(a.name);
  const [notes, setNotes] = useState(a.notes ?? '');
  const [life, setLife] = useState(String(a.usefulLifeMonths));
  const started = a.schedule.some((m) => m.posted);
  const save = useMutation({
    mutationFn: () =>
      updateFixedAsset(a.id, {
        name: name.trim(),
        notes: notes.trim() || null,
        ...(!started && Number(life) !== a.usefulLifeMonths ? { usefulLifeMonths: Number(life) } : {}),
      }),
    onSuccess: ({ asset }) => {
      qc.setQueryData(['books', 'assets', a.id], { asset });
      void qc.invalidateQueries({ queryKey: ['books', 'assets'] });
      toast.success('Saved.');
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {a.name}</DialogTitle>
          <DialogDescription>{started ? 'Depreciation has posted, so its life and method are fixed.' : 'Nothing has posted yet — the life can still change.'}</DialogDescription>
        </DialogHeader>
        <Field label="Name">{(p) => <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
        {!started && <Field label="Useful life (months)">{(p) => <Input type="number" min="1" max="600" value={life} onChange={(e) => setLife(e.target.value)} {...p} />}</Field>}
        <Field label="Notes">{(p) => <Textarea rows={3} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} {...p} />}</Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
