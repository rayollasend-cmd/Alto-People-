import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, MoreHorizontal, Pencil, Plus, Power, Scale, Trash2 } from 'lucide-react';
import { LEDGER_ACCOUNT_TYPES, LEDGER_SUBTYPES, LEDGER_SUBTYPE_LABELS, LEDGER_TYPE_LABELS, type LedgerAccountRow, type LedgerAccountType } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { createLedgerAccount, deleteLedgerAccount, getOpeningBalances, postOpeningBalances, updateLedgerAccount } from '@/lib/books/ledgerApi';
import { ymdLocal } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { Amount, useLedgerAccounts } from './ledgerKit';

/**
 * The chart of accounts: every account the books keep, grouped as the
 * statements group them, with today's balance. Finance adds, renames,
 * nests and turns accounts off; an account with entries keeps its type,
 * and the ones the automatic posting uses can't be deleted.
 */
export function AccountsPage() {
  const { can } = useAuth();
  const manage = can('manage:books');
  const q = useLedgerAccounts();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<LedgerAccountRow | 'new' | null>(null);
  const [opening, setOpening] = useState(false);
  const accounts = q.data?.accounts ?? [];
  const visible = accounts.filter((a) => showInactive || a.isActive);
  const inactive = accounts.filter((a) => !a.isActive).length;

  return (
    <ListTemplate
      title="Chart of accounts"
      subtitle="The accounts the books keep, grouped as the statements read them, with today’s balances."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Chart of accounts' }]}
      primaryAction={
        manage ? (
          <Button onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New account
          </Button>
        ) : undefined
      }
      secondaryActions={
        manage ? (
          <Button variant="secondary" onClick={() => setOpening(true)}>
            <Scale className="h-4 w-4" aria-hidden="true" />
            Opening balances
          </Button>
        ) : undefined
      }
      filters={
        inactive > 0 ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
            <input type="checkbox" className="h-4 w-4 accent-gold" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show {inactive} turned-off {inactive === 1 ? 'account' : 'accounts'}
          </label>
        ) : undefined
      }
    >
      {q.isError ? (
        <QueryError what="the chart of accounts" query={q} />
      ) : !q.data ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-[var(--d-stack)]">
          {LEDGER_ACCOUNT_TYPES.map((t) => {
            const list = visible.filter((a) => a.type === t);
            if (list.length === 0) return null;
            const total = list.filter((a) => a.isActive).reduce((s, a) => s + a.balance, 0);
            return (
              <Card key={t}>
                <CardContent className="p-4">
                  <SectionTitle as="h3" title={LEDGER_TYPE_LABELS[t]} trailing={<Amount value={total} strong />} />
                  <ul className="mt-2 divide-y divide-line">
                    {list.map((a) => (
                      <li key={a.id} className={cn('flex items-center gap-3 py-2 text-sm', !a.isActive && 'opacity-60', a.parentId && 'pl-6')}>
                        <span className="w-14 shrink-0 tabular-nums text-ink-muted">{a.code}</span>
                        <Link to={`/books/accounts/${a.id}`} className="min-w-0 flex-1 truncate text-ink hover:text-accent">
                          {a.name}
                        </Link>
                        <span className="hidden text-2xs text-ink-muted md:inline">{LEDGER_SUBTYPE_LABELS[a.subtype] ?? a.subtype}</span>
                        {a.systemKey && (
                          <span title="The automatic posting uses this account" className="text-ink-muted">
                            <Lock className="h-3.5 w-3.5" aria-label="Used by automatic posting" />
                          </span>
                        )}
                        {!a.isActive && (
                          <Badge size="sm" variant="outline">
                            Off
                          </Badge>
                        )}
                        <Amount value={a.balance} className="w-32 text-right" />
                        {manage && <AccountMenu account={a} onEdit={() => setEditing(a)} />}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {editing && <AccountDialog account={editing === 'new' ? null : editing} accounts={accounts} onClose={() => setEditing(null)} />}
      {opening && <OpeningBalancesDialog accounts={accounts} onClose={() => setOpening(false)} />}
    </ListTemplate>
  );
}

function AccountMenu({ account: a, onEdit }: { account: LedgerAccountRow; onEdit: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['books'] });
  const toggle = useMutation({
    mutationFn: () => updateLedgerAccount(a.id, { isActive: !a.isActive }),
    onSuccess: () => {
      refresh();
      toast.success(a.isActive ? `${a.name} turned off.` : `${a.name} turned back on.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the account.'),
  });
  const remove = useMutation({
    mutationFn: () => deleteLedgerAccount(a.id),
    onSuccess: () => {
      refresh();
      toast.success(`${a.name} deleted.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the account.'),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`More for ${a.name}`}>
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggle.mutate()}>
          <Power className="h-4 w-4" aria-hidden="true" /> {a.isActive ? 'Turn off' : 'Turn back on'}
        </DropdownMenuItem>
        {!a.hasEntries && !a.systemKey && (
          <DropdownMenuItem
            onSelect={async () => {
              if (await confirm({ title: `Delete ${a.code} ${a.name}?`, description: 'It has no entries, so nothing else changes.', confirmLabel: 'Delete', destructive: true })) remove.mutate();
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountDialog({ account, accounts, onClose }: { account: LedgerAccountRow | null; accounts: LedgerAccountRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(account?.code ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<LedgerAccountType>(account?.type ?? 'EXPENSE');
  const [subtype, setSubtype] = useState(account?.subtype ?? 'EXPENSE');
  const [parentId, setParentId] = useState(account?.parentId ?? '');
  const [description, setDescription] = useState(account?.description ?? '');
  const typeLocked = !!account && (account.hasEntries || !!account.systemKey);
  useEffect(() => {
    if (!LEDGER_SUBTYPES[type].includes(subtype)) setSubtype(LEDGER_SUBTYPES[type][0]!);
  }, [type, subtype]);
  const save = useMutation({
    mutationFn: () =>
      account
        ? updateLedgerAccount(account.id, { code: code.trim(), name: name.trim(), ...(typeLocked ? {} : { type, subtype }), parentId: parentId || null, description: description.trim() || null })
        : createLedgerAccount({ code: code.trim(), name: name.trim(), type, subtype, parentId: parentId || null, description: description.trim() || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['books'] });
      toast.success(account ? 'Account saved.' : 'Account added.');
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the account.'),
  });
  const parents = accounts.filter((a) => a.type === type && a.id !== account?.id && a.isActive);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.code} ${account.name}` : 'New account'}</DialogTitle>
          <DialogDescription>{typeLocked ? 'This account has entries or is used by the automatic posting, so its type stays as it is.' : 'The type decides which statement the account lands on.'}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Code">{(p) => <Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} {...p} />}</Field>
          <Field label="Name">{(p) => <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
          <Field label="Type">
            {(p) => (
              <Select value={type} disabled={typeLocked} onChange={(e) => setType(e.target.value as LedgerAccountType)} {...p}>
                {LEDGER_ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LEDGER_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Kind">
            {(p) => (
              <Select value={subtype} disabled={typeLocked} onChange={(e) => setSubtype(e.target.value)} {...p}>
                {LEDGER_SUBTYPES[type].map((s) => (
                  <option key={s} value={s}>
                    {LEDGER_SUBTYPE_LABELS[s] ?? s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Under" className="sm:col-span-2" hint="Optional: a sub-account rolls up under its parent.">
            {(p) => (
              <Select value={parentId} onChange={(e) => setParentId(e.target.value)} {...p}>
                <option value="">Top level</option>
                {parents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Description" className="sm:col-span-2">
            {(p) => <Textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} {...p} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!code.trim() || !name.trim()}>
            {account ? 'Save' : 'Add account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The balances the books start from: one figure per balance-sheet account, the difference to opening balance equity. */
function OpeningBalancesDialog({ accounts, onClose }: { accounts: LedgerAccountRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['books', 'opening'], queryFn: getOpeningBalances });
  const [date, setDate] = useState(`${Number(ymdLocal().slice(0, 4)) - 1}-12-31`);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (current.data?.date) {
      setDate(current.data.date);
      setAmounts(Object.fromEntries(current.data.lines.map((l) => [l.accountId, String(l.amount)])));
    }
  }, [current.data]);
  const sheet = useMemo(() => accounts.filter((a) => a.isActive && (a.type === 'ASSET' || a.type === 'LIABILITY' || (a.type === 'EQUITY' && a.systemKey !== 'OPENING_BALANCE'))), [accounts]);
  const save = useMutation({
    mutationFn: () => postOpeningBalances({ date, lines: Object.entries(amounts).filter(([, v]) => v.trim() !== '' && Number(v) !== 0).map(([accountId, v]) => ({ accountId, amount: Number(v.replace(/[$,\s]/g, '')) })) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['books'] });
      toast.success('Opening balances posted.');
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not post the opening balances.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Opening balances</DialogTitle>
          <DialogDescription>What each account held the day before the books start here, from your last balance sheet. The difference goes to opening balance equity, so it always balances; posting again replaces it.</DialogDescription>
        </DialogHeader>
        <Field label="As of">{(p) => <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} {...p} />}</Field>
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <tbody>
              {sheet.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-1.5 text-ink">
                    <span className="mr-2 tabular-nums text-ink-muted">{a.code}</span>
                    {a.name}
                  </td>
                  <td className="w-40 px-3 py-1.5">
                    <Input inputMode="decimal" aria-label={`${a.name} opening balance`} className="text-right tabular-nums" value={amounts[a.id] ?? ''} placeholder="0.00" onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!date || Object.values(amounts).every((v) => !v.trim() || Number(v) === 0)}>
            Post opening balances
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

