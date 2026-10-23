import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import type { BankFeedAccountView, BankRuleInput, BankRuleView } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { BANK_KEY, applyBankRules, createBankRule, deleteBankRule, listBankRules, updateBankRule } from '@/lib/books/bankApi';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { AccountSelect, money } from './bankKit';

/**
 * Bank rules — "anything from SHELL is vehicle fuel". They apply to every
 * bank and card account, so they live on Bank and cards (?view=rules), not
 * inside one account where they read as that account's own.
 */

export function RulesSection({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const rules = useQuery({ queryKey: [...BANK_KEY, 'rules'], queryFn: listBankRules });
  const [editing, setEditing] = useState<BankRuleView | 'new' | null>(null);
  const apply = useMutation({
    // Every bank and card account's waiting transactions — rules are company-wide.
    mutationFn: () => applyBankRules(),
    onSuccess: (r) => {
      toast.success(r.categorized ? `${r.categorized} ${r.categorized === 1 ? 'transaction' : 'transactions'} categorized.` : 'No waiting transaction fits a rule.');
      void qc.invalidateQueries({ queryKey: BANK_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not apply the rules.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteBankRule(id),
    onSuccess: () => {
      toast.success('Rule deleted.');
      void qc.invalidateQueries({ queryKey: [...BANK_KEY, 'rules'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the rule.'),
  });
  const list = rules.data?.rules ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-silver">Rules apply to every bank and card account, first by priority. Auto rules categorize as transactions arrive; the rest are suggestions you accept.</p>
        {manage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => apply.mutate()} loading={apply.isPending} disabled={list.length === 0}>
              <Wand2 className="h-4 w-4" aria-hidden="true" />
              Apply rules now
            </Button>
            <Button onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New rule
            </Button>
          </div>
        )}
      </div>
      {rules.isPending ? (
        <SkeletonRows count={3} />
      ) : rules.isError ? (
        <QueryError what="the rules" query={rules} />
      ) : list.length === 0 ? (
        <EmptyState icon={Wand2} title="Make the first rule" description="“Anything from SHELL is vehicle fuel.” Rules save categorizing the same thing every month — make one from any transaction too." />
      ) : (
        <ul className="divide-y divide-navy-secondary rounded-lg border border-navy-secondary bg-navy">
          {list.map((r) => (
            <li key={r.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !r.isActive && 'opacity-60')}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {r.name}
                  {r.autoApply && (
                    <Badge size="sm" variant="accent" className="ml-2">
                      Auto
                    </Badge>
                  )}
                  {!r.isActive && (
                    <Badge size="sm" variant="outline" className="ml-2">
                      Off
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-silver">
                  {r.direction === 'IN' ? 'Money in' : r.direction === 'OUT' ? 'Money out' : 'Anything'} containing “{r.contains}”
                  {r.minAmount !== null || r.maxAmount !== null ? ` · ${r.minAmount !== null ? money(r.minAmount) : '$0'}–${r.maxAmount !== null ? money(r.maxAmount) : 'any'}` : ''} → {r.accountCode} {r.accountName}
                  {` · priority ${r.priority}`}
                </p>
              </div>
              {manage && (
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${r.name}`}
                    onClick={async () => {
                      if (await confirm({ title: `Delete the rule “${r.name}”?`, description: 'What it already categorized stays as it is.', confirmLabel: 'Delete', destructive: true })) remove.mutate(r.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleDialog rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Make or change a rule. From a transaction, `feed` keeps its own bank account out of the categories. */
export function RuleDialog({ feed, rule, seed, onClose }: { feed?: BankFeedAccountView; rule?: BankRuleView; seed?: Partial<BankRuleInput>; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(rule?.name ?? seed?.name ?? '');
  const [contains, setContains] = useState(rule?.contains ?? seed?.contains ?? '');
  const [direction, setDirection] = useState<'IN' | 'OUT' | 'ANY'>(rule?.direction ?? seed?.direction ?? 'ANY');
  const [min, setMin] = useState(rule?.minAmount != null ? String(rule.minAmount) : '');
  const [max, setMax] = useState(rule?.maxAmount != null ? String(rule.maxAmount) : '');
  const [accountId, setAccountId] = useState(rule?.accountId ?? '');
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [autoApply, setAutoApply] = useState(rule?.autoApply ?? false);
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const amount = (s: string) => (s.trim() === '' ? null : Number(s));
  const valid = !!name.trim() && !!contains.trim() && !!accountId && [min, max, priority].every((v) => v.trim() === '' || Number.isFinite(Number(v)));
  const save = useMutation({
    mutationFn: () => {
      const body: BankRuleInput = { name: name.trim(), contains: contains.trim(), direction, minAmount: amount(min), maxAmount: amount(max), accountId, priority: Number(priority) || 100, autoApply, isActive };
      return rule ? updateBankRule(rule.id, body) : createBankRule(body);
    },
    onSuccess: () => {
      toast.success(rule ? 'Rule saved.' : 'Rule made. “Apply rules now” to use it on what’s waiting.');
      void qc.invalidateQueries({ queryKey: BANK_KEY });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the rule.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? `Edit “${rule.name}”` : 'New rule'}</DialogTitle>
          <DialogDescription>When a transaction’s description or payee contains these words, categorize it here.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Fuel" />}</Field>
          <Field label="Contains">{(p) => <Input {...p} value={contains} maxLength={120} onChange={(e) => setContains(e.target.value)} placeholder="shell" />}</Field>
          <Field label="Direction">
            {(p) => (
              <Select {...p} value={direction} onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT' | 'ANY')}>
                <option value="ANY">Money in or out</option>
                <option value="OUT">Money out</option>
                <option value="IN">Money in</option>
              </Select>
            )}
          </Field>
          <Field label="Priority" hint="Lower runs first">{(p) => <Input {...p} type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} />}</Field>
          <Field label="Smallest amount" hint="Optional">{(p) => <Input {...p} type="number" min={0} step="0.01" value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
          <Field label="Largest amount" hint="Optional">{(p) => <Input {...p} type="number" min={0} step="0.01" value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
          <Field label="Categorize as" className="sm:col-span-2">
            {(p) => <AccountSelect {...p} value={accountId} onChange={setAccountId} exclude={feed?.ledgerAccountId} />}
          </Field>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
          <span>
            <span className="block text-ink">Categorize automatically</span>
            <span className="block text-xs text-silver">As transactions arrive, without asking. Off: it’s offered as a one-click suggestion.</span>
          </span>
        </label>
        {rule && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            <span className="text-ink">Rule is on</span>
          </label>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            {rule ? 'Save rule' : 'Make the rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

