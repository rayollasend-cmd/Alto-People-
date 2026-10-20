import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FIXED_ASSET_CATEGORY_LABELS, type FixedAssetCategory, type FixedAssetMethod, type FixedAssetStatus, type FixedAssetSuggestion } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { createFixedAsset } from '@/lib/books/closeApi';
import { ymdLocal } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';
import { AccountSelect } from '../close/closeKit';

/** Shared bits for the fixed-asset pages. */

export const ASSET_STATUS: Record<FixedAssetStatus, { label: string; variant: 'success' | 'default' | 'info' }> = {
  ACTIVE: { label: 'Depreciating', variant: 'success' },
  FULLY_DEPRECIATED: { label: 'Fully depreciated', variant: 'info' },
  DISPOSED: { label: 'Disposed', variant: 'default' },
};

export const METHOD_LABEL: Record<FixedAssetMethod, string> = {
  STRAIGHT_LINE: 'Straight line',
  DECLINING_BALANCE: 'Double declining',
};

/** Typical lives, so the form starts somewhere sensible. */
const DEFAULT_LIFE: Record<FixedAssetCategory, number> = { VEHICLE: 60, EQUIPMENT: 84, COMPUTERS: 36, LEASEHOLD: 120, FURNITURE: 84, OTHER: 60 };

export function AssetStatusBadge({ status, size }: { status: FixedAssetStatus; size?: 'sm' | 'default' | 'lg' }) {
  const s = ASSET_STATUS[status] ?? { label: status, variant: 'default' as const };
  return (
    <Badge variant={s.variant} size={size}>
      {s.label}
    </Badge>
  );
}

export const lifeLabel = (months: number) => (months % 12 === 0 ? `${months / 12} ${months === 12 ? 'year' : 'years'}` : `${months} months`);

/** Put an asset on the register — blank, or from a van or asset record the company already has. */
export function AddAssetDialog({ open, onOpenChange, from, onMade }: { open: boolean; onOpenChange: (o: boolean) => void; from: FixedAssetSuggestion | null; onMade: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<FixedAssetCategory>('EQUIPMENT');
  const [acquiredOn, setAcquiredOn] = useState(ymdLocal());
  const [cost, setCost] = useState('');
  const [salvage, setSalvage] = useState('');
  const [life, setLife] = useState(String(DEFAULT_LIFE.EQUIPMENT));
  const [method, setMethod] = useState<FixedAssetMethod>('STRAIGHT_LINE');
  const [paidFrom, setPaidFrom] = useState('');
  const [onBooksAlready, setOnBooksAlready] = useState(false);
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (!open) return;
    setName(from?.label ?? '');
    setCategory(from?.category ?? 'EQUIPMENT');
    setAcquiredOn(from?.acquiredOn ?? ymdLocal());
    setCost(from?.cost ? String(from.cost) : '');
    setSalvage('');
    setLife(String(DEFAULT_LIFE[from?.category ?? 'EQUIPMENT']));
    setMethod('STRAIGHT_LINE');
    setPaidFrom('');
    setOnBooksAlready(false);
    setNotes('');
  }, [open, from]);
  const save = useMutation({
    mutationFn: () =>
      createFixedAsset({
        name: name.trim(),
        category,
        acquiredOn,
        cost: Number(cost),
        salvageValue: Number(salvage) || 0,
        usefulLifeMonths: Number(life),
        method,
        vanId: from?.kind === 'VAN' ? from.id : null,
        assetId: from?.kind === 'ASSET' ? from.id : null,
        notes: notes.trim() || null,
        ...(!onBooksAlready && paidFrom ? { acquisition: { creditAccountId: paidFrom } } : {}),
      }),
    onSuccess: ({ asset }) => {
      void qc.invalidateQueries({ queryKey: ['books', 'assets'] });
      toast.success(`${asset.name} is on the register.`);
      onOpenChange(false);
      onMade(asset.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add the asset.'),
  });
  const valid = name.trim() && Number(cost) > 0 && Number(life) > 0 && (Number(salvage) || 0) <= Number(cost) && (onBooksAlready || paidFrom);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{from ? `Add ${from.label} to fixed assets` : 'Add a fixed asset'}</DialogTitle>
          <DialogDescription>It depreciates from the month it goes into service, a full month at a time.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">{(p) => <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
          <Field label="Category">
            {(p) => (
              <Select
                value={category}
                onChange={(e) => {
                  const c = e.target.value as FixedAssetCategory;
                  setCategory(c);
                  setLife(String(DEFAULT_LIFE[c]));
                }}
                {...p}
              >
                {(Object.keys(FIXED_ASSET_CATEGORY_LABELS) as FixedAssetCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {FIXED_ASSET_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Acquired">{(p) => <Input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)} {...p} />}</Field>
          <Field label="Cost">{(p) => <Input type="number" inputMode="decimal" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} {...p} />}</Field>
          <Field label="Salvage value" hint="What it’s worth at the end">{(p) => <Input type="number" inputMode="decimal" min="0" step="0.01" value={salvage} onChange={(e) => setSalvage(e.target.value)} {...p} />}</Field>
          <Field label="Useful life (months)" hint={Number(life) > 0 ? lifeLabel(Number(life)) : undefined}>{(p) => <Input type="number" min="1" max="600" value={life} onChange={(e) => setLife(e.target.value)} {...p} />}</Field>
          <Field label="Method">
            {(p) => (
              <Select value={method} onChange={(e) => setMethod(e.target.value as FixedAssetMethod)} {...p}>
                <option value="STRAIGHT_LINE">Straight line — the same every month</option>
                <option value="DECLINING_BALANCE">Double declining — more up front</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="space-y-2 rounded-lg border border-line p-3">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={onBooksAlready} onChange={(e) => setOnBooksAlready(e.target.checked)} />
            <span>
              <span className="block font-medium text-ink">Already on the books</span>
              <span className="block text-ink-muted">A bill or entry already put its cost on the asset account — only the depreciation is new.</span>
            </span>
          </label>
          {!onBooksAlready && (
            <Field label="Paid from" hint="The asset account is debited; this account is credited">{(p) => <AccountSelect value={paidFrom} onChange={setPaidFrom} types={['ASSET', 'LIABILITY', 'EQUITY']} subtypes={['BANK', 'CREDIT_CARD', 'AP', 'LONG_TERM_LIABILITY', 'CURRENT_LIABILITY', 'EQUITY']} {...p} />}</Field>
          )}
        </div>
        <Field label="Notes">{(p) => <Textarea rows={2} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} {...p} />}</Field>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            Add to fixed assets
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
