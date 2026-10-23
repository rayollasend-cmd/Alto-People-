import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Plus, Power, Scale, Trash2 } from 'lucide-react';
import { LEDGER_ACCOUNT_TYPES, LEDGER_SUBTYPES, LEDGER_SUBTYPE_LABELS, LEDGER_TYPE_LABELS, type LedgerAccountRow, type LedgerAccountType } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { createLedgerAccount, deleteLedgerAccount, getOpeningBalances, postOpeningBalances, updateLedgerAccount } from '@/lib/books/ledgerApi';
import { ymdLocal } from '@/lib/format';
import { urlBoolean, useUrlParam, useUrlState } from '@/lib/useUrlState';
import { useDesktopTable } from '@/lib/useViewport';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { Amount, useLedgerAccounts } from './ledgerKit';

/**
 * The chart of accounts: every account the books keep, grouped as the
 * statements group them, with today's balance and what moved through it
 * this year — searchable, filterable by type, and exportable. Finance
 * adds, renames, nests and turns accounts off; an account with entries
 * keeps its type, and the ones the automatic posting uses can't be
 * deleted (the row's menu simply doesn't offer it).
 */

const TYPE_FILTERS = ['all', ...LEDGER_ACCOUNT_TYPES] as const;
const TYPE_ORDER = new Map<string, number>(LEDGER_ACCOUNT_TYPES.map((t, i) => [t, i]));
const byTypeThenCode = (a: LedgerAccountRow, b: LedgerAccountRow) =>
  (TYPE_ORDER.get(a.type) ?? 9) - (TYPE_ORDER.get(b.type) ?? 9) || a.code.localeCompare(b.code, undefined, { numeric: true });

export function AccountsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const manage = can('manage:books');
  const desktop = useDesktopTable();
  const q = useLedgerAccounts();
  const [type, setType] = useUrlParam('type', 'all', TYPE_FILTERS);
  const [showInactive, setShowInactive] = useUrlState('inactive', false, urlBoolean);
  const [editing, setEditing] = useState<LedgerAccountRow | 'new' | null>(null);
  const [opening, setOpening] = useState(false);
  const accounts = useMemo(() => q.data?.accounts ?? [], [q.data]);
  const inactive = accounts.filter((a) => !a.isActive).length;
  const rows = useMemo(
    () => accounts.filter((a) => (showInactive || a.isActive) && (type === 'all' || a.type === type)).sort(byTypeThenCode),
    [accounts, showInactive, type],
  );
  const activeFilters = (type !== 'all' ? 1 : 0) + (showInactive ? 1 : 0);

  const columns: GridColumn<LedgerAccountRow>[] = [
    { key: 'code', header: 'Code', accessor: (a) => a.code, sortable: true, width: '6rem', className: 'tabular-nums', cardMeta: true },
    {
      key: 'name',
      header: 'Name',
      accessor: (a) => a.name,
      primary: true,
      sortable: true,
      // The name wraps on its own line — never "Op…" — and a sub-account sits in under its parent.
      cell: (a) => (
        <span className={cn('inline-flex flex-wrap items-center gap-1.5 break-words text-ink', a.parentId && 'pl-4', !a.isActive && 'opacity-60')}>
          {a.name}
          {!a.isActive && (
            <Badge size="sm" variant="outline">
              Off
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'type', header: 'Type', accessor: (a) => LEDGER_SUBTYPE_LABELS[a.subtype] ?? a.subtype, sortable: true, cardMeta: true },
    { key: 'balance', header: 'Balance', accessor: (a) => a.balance, sortable: true, align: 'right', cell: (a) => <Amount value={a.balance} />, csv: (a) => a.balance.toFixed(2) },
    { key: 'activityYtd', header: 'Activity YTD', accessor: (a) => a.activityYtd, sortable: true, align: 'right', cell: (a) => <Amount value={a.activityYtd} blankZero />, csv: (a) => a.activityYtd.toFixed(2) },
    // The row menu (edit, turn off, delete) is a desk task: a phone card reads the account and opens it, without a second row of chrome under every card.
    ...(manage && desktop
      ? [{ key: 'actions', header: '', accessor: () => '', searchable: false, stopRowClick: true, width: '3rem', csv: () => null, cell: (a: LedgerAccountRow) => <AccountMenu account={a} onEdit={() => setEditing(a)} /> } satisfies GridColumn<LedgerAccountRow>]
      : []),
  ];

  return (
    <ListTemplate
      title="Chart of accounts"
      subtitle="The accounts the books keep, grouped as the statements read them, with today’s balances and this year’s activity."
      actions={
        manage
          ? [
              { key: 'new', label: 'New account', icon: Plus, primary: true, onSelect: () => setEditing('new') },
              { key: 'opening', label: 'Opening balances', icon: Scale, onSelect: () => setOpening(true) },
            ]
          : undefined
      }
    >
      {q.isError ? (
        <QueryError what="the chart of accounts" query={q} />
      ) : (
        <DataGrid
          id="books-accounts"
          caption="Chart of accounts"
          noun={{ one: 'account', many: 'accounts' }}
          rows={q.data ? rows : null}
          loading={q.isLoading}
          columns={columns}
          rowKey={(a) => a.id}
          search={{ placeholder: 'Search code or name' }}
          exportCsv={{ filename: 'chart-of-accounts' }}
          onRowClick={(a) => navigate(`/books/accounts/${a.id}`)}
          rowActionLabel={(a) => `Open ${a.code} ${a.name}`}
          groupBy={{
            key: (a) => a.type,
            header: (k, list) => (
              <span className="flex items-center justify-between gap-3">
                <span>{LEDGER_TYPE_LABELS[k as LedgerAccountType] ?? k}</span>
                <Amount value={list.filter((a) => a.isActive).reduce((s, a) => s + a.balance, 0)} strong />
              </span>
            ),
          }}
          filters={
            <>
              <Select size="sm" aria-label="Account type" value={type} onChange={(e) => setType(e.target.value as (typeof TYPE_FILTERS)[number])} className="w-auto">
                <option value="all">All types</option>
                {LEDGER_ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LEDGER_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
              {inactive > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
                  <input type="checkbox" className="h-4 w-4 accent-gold" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
                  Show {inactive} turned-off {inactive === 1 ? 'account' : 'accounts'}
                </label>
              )}
            </>
          }
          activeFilters={activeFilters}
          filterKeys={['type', 'inactive']}
          empty={{ title: 'No accounts yet', description: 'The chart is set up the first time the books open.' }}
        />
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

