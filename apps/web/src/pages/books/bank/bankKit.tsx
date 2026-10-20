import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Landmark, Link2 } from 'lucide-react';
import type { BankCsvMapping, BankImportPreview, BankLedgerAccountOption, BankPlaidAccount } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  BANK_KEY,
  createBankAccount,
  createPlaidLinkToken,
  exchangePlaidToken,
  getPlaidStatus,
  importBankFile,
  listBankAccounts,
  listLedgerAccountOptions,
  openPlaidLink,
  previewBankImport,
  readFileText,
} from '@/lib/books/bankApi';
import { fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';

/** Shared pieces for the books' bank and card pages. */

export const money = (n: number | null | undefined) => fmtMoney(n ?? null);

/** Money in reads plain; money out reads with a minus and a quieter tone. */
export function Amount({ value, className }: { value: number; className?: string }) {
  return <span className={cn('tabular-nums', value < 0 ? 'text-ink' : 'text-success', className)}>{value < 0 ? `−${fmtMoney(-value)}` : fmtMoney(value)}</span>;
}

export const ledgerOptionsKey = [...BANK_KEY, 'ledger-accounts'] as const;

export function useLedgerOptions() {
  return useQuery({ queryKey: ledgerOptionsKey, queryFn: listLedgerAccountOptions, staleTime: 5 * 60_000 });
}

const TYPE_LABEL: Record<string, string> = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', INCOME: 'Income', EXPENSE: 'Expenses' };

/** Every active account, grouped by type — expenses and income first, the way people categorize. */
export function AccountSelect({
  value,
  onChange,
  exclude,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  placeholder = 'Choose an account…',
  only,
}: {
  value: string;
  onChange: (id: string) => void;
  exclude?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true | undefined;
  placeholder?: string;
  only?: (a: BankLedgerAccountOption) => boolean;
}) {
  const q = useLedgerOptions();
  const groups = useMemo(() => {
    const rows = (q.data?.accounts ?? []).filter((a) => a.id !== exclude && (!only || only(a)));
    return ['EXPENSE', 'INCOME', 'LIABILITY', 'ASSET', 'EQUITY']
      .map((t) => ({ type: t, rows: rows.filter((a) => a.type === t) }))
      .filter((g) => g.rows.length > 0);
  }, [q.data, exclude, only]);
  return (
    <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)} disabled={q.isPending}>
      <option value="">{q.isPending ? 'One moment…' : placeholder}</option>
      {groups.map((g) => (
        <optgroup key={g.type} label={TYPE_LABEL[g.type] ?? g.type}>
          {g.rows.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

const isFeedSubtype = (a: BankLedgerAccountOption) => a.subtype === 'BANK' || a.subtype === 'CREDIT_CARD';

/* ---- Add an account ------------------------------------------------------- */

export function AddAccountDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: [...BANK_KEY, 'accounts'], queryFn: listBankAccounts, enabled: open });
  const taken = new Set((accounts.data?.accounts ?? []).map((a) => a.ledgerAccountId));
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [ledgerAccountId, setLedgerAccountId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [subtype, setSubtype] = useState<'BANK' | 'CREDIT_CARD'>('BANK');
  const [institution, setInstitution] = useState('');
  const [mask, setMask] = useState('');
  const save = useMutation({
    mutationFn: () =>
      createBankAccount({
        ...(mode === 'existing' ? { ledgerAccountId } : { newAccount: { code: code.trim(), name: name.trim(), subtype } }),
        institution: institution.trim() || null,
        mask: mask.trim() || null,
      }),
    onSuccess: ({ account }) => {
      toast.success(`${account.name} is ready for statements.`);
      void qc.invalidateQueries({ queryKey: BANK_KEY });
      onOpenChange(false);
      onCreated?.(account.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add the account.'),
  });
  const ok = mode === 'existing' ? !!ledgerAccountId : !!code.trim() && !!name.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a bank or card account</DialogTitle>
          <DialogDescription>Its transactions come in from statement files (CSV or OFX), or from a live feed once you connect the bank.</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="Which ledger account" className="grid grid-cols-2 gap-2">
          {(['existing', 'new'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn('rounded-lg border px-3 py-2 text-left text-sm transition-colors', mode === m ? 'border-gold bg-gold/10 text-ink' : 'border-navy-secondary text-silver hover:border-silver/40')}
            >
              <span className="block font-medium">{m === 'existing' ? 'An account in the chart' : 'A new account'}</span>
              <span className="block text-xs text-silver">{m === 'existing' ? 'Operating checking, the company card…' : 'Adds it to the chart too'}</span>
            </button>
          ))}
        </div>
        {mode === 'existing' ? (
          <Field label="Ledger account" hint="Bank and credit card accounts that don’t have a feed yet.">
            {(p) => <AccountSelect {...p} value={ledgerAccountId} onChange={setLedgerAccountId} only={(a) => isFeedSubtype(a) && !taken.has(a.id)} />}
          </Field>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[7rem_1fr]">
            <Field label="Code">{(p) => <Input {...p} value={code} maxLength={20} onChange={(e) => setCode(e.target.value)} placeholder="1020" />}</Field>
            <Field label="Name">{(p) => <Input {...p} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} placeholder="Savings" />}</Field>
            <Field label="Kind" className="sm:col-span-2">
              {(p) => (
                <Select {...p} value={subtype} onChange={(e) => setSubtype(e.target.value as 'BANK' | 'CREDIT_CARD')}>
                  <option value="BANK">Bank account</option>
                  <option value="CREDIT_CARD">Credit card</option>
                </Select>
              )}
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <Field label="Bank" hint="Optional">{(p) => <Input {...p} value={institution} maxLength={120} onChange={(e) => setInstitution(e.target.value)} placeholder="First Coast Bank" />}</Field>
          <Field label="Last four" hint="Optional">{(p) => <Input {...p} value={mask} maxLength={8} inputMode="numeric" onChange={(e) => setMask(e.target.value)} placeholder="0042" />}</Field>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!ok}>
            Add account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Connect a bank (Plaid) ----------------------------------------------- */

/**
 * Plaid Link, then: each account the bank shared, paired with a ledger
 * account (an existing one, or skipped). Only offered when Plaid is set up
 * under Integrations.
 */
export function ConnectBankButton({ onLinked }: { onLinked?: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: [...BANK_KEY, 'plaid'], queryFn: getPlaidStatus, staleTime: 60_000 });
  const [linked, setLinked] = useState<{ itemId: string; accounts: BankPlaidAccount[] } | null>(null);
  const connect = useMutation({
    mutationFn: async () => {
      const { linkToken } = await createPlaidLinkToken();
      const publicToken = await openPlaidLink(linkToken);
      if (!publicToken) return null;
      return exchangePlaidToken(publicToken);
    },
    onSuccess: (r) => r && setLinked(r),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not connect the bank.'),
  });
  if (!status.data?.configured) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => connect.mutate()} loading={connect.isPending}>
        <Link2 className="h-4 w-4" aria-hidden="true" />
        Connect a bank
      </Button>
      {linked && (
        <PairPlaidDialog
          linked={linked}
          onClose={() => {
            setLinked(null);
            void qc.invalidateQueries({ queryKey: BANK_KEY });
            onLinked?.();
          }}
        />
      )}
    </>
  );
}

function PairPlaidDialog({ linked, onClose }: { linked: { itemId: string; accounts: BankPlaidAccount[] }; onClose: () => void }) {
  const accounts = useQuery({ queryKey: [...BANK_KEY, 'accounts'], queryFn: listBankAccounts });
  const taken = new Set((accounts.data?.accounts ?? []).map((a) => a.ledgerAccountId));
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const a of linked.accounts) {
        const ledgerAccountId = pairs[a.accountId];
        if (!ledgerAccountId || a.linkedFeedId) continue;
        await createBankAccount({ ledgerAccountId, plaid: { itemId: linked.itemId, accountId: a.accountId } });
        n += 1;
      }
      return n;
    },
    onSuccess: (n) => {
      toast.success(n ? `${n} ${n === 1 ? 'account is' : 'accounts are'} connected. Transactions arrive within a few minutes.` : 'Nothing paired.');
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not connect the accounts.'),
  });
  const chosen = new Set(Object.values(pairs).filter(Boolean));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pair the bank’s accounts with the books</DialogTitle>
          <DialogDescription>Pick the ledger account each one feeds. Leave one unpaired to skip it.</DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-navy-secondary rounded-lg border border-navy-secondary">
          {linked.accounts.map((a) => (
            <li key={a.accountId} className="flex flex-wrap items-center gap-3 px-3 py-3">
              <Landmark className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-medium text-ink">
                  {a.name}
                  {a.mask ? <span className="text-silver"> ··{a.mask}</span> : null}
                </span>
                <span className="block text-xs text-silver">{[a.institution, a.subtype ?? a.type].filter(Boolean).join(' · ')}</span>
              </span>
              {a.linkedFeedId ? (
                <span className="text-xs text-success">Already connected</span>
              ) : (
                <div className="w-full sm:w-64">
                  <AccountSelect
                    aria-describedby={undefined}
                    value={pairs[a.accountId] ?? ''}
                    onChange={(v) => setPairs((p) => ({ ...p, [a.accountId]: v }))}
                    placeholder="Skip this account"
                    only={(o) => isFeedSubtype(o) && !taken.has(o.id) && (!chosen.has(o.id) || pairs[a.accountId] === o.id)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Skip for now
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={chosen.size === 0}>
            Connect {chosen.size || ''} {chosen.size === 1 ? 'account' : 'accounts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Import a statement --------------------------------------------------- */

export function ImportButton({ feedAccountId, variant = 'secondary' }: { feedAccountId: string; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <FileUp className="h-4 w-4" aria-hidden="true" />
        Import a statement
      </Button>
      {open && <ImportDialog feedAccountId={feedAccountId} onClose={() => setOpen(false)} />}
    </>
  );
}

const COLUMN_FIELDS: Array<{ key: keyof BankCsvMapping; label: string; optional?: boolean }> = [
  { key: 'dateColumn', label: 'Date' },
  { key: 'descriptionColumn', label: 'Description' },
  { key: 'amountColumn', label: 'Amount (one column)', optional: true },
  { key: 'debitColumn', label: 'Money out', optional: true },
  { key: 'creditColumn', label: 'Money in', optional: true },
  { key: 'referenceColumn', label: 'Check or reference', optional: true },
];

function ImportDialog({ feedAccountId, onClose }: { feedAccountId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [mapping, setMapping] = useState<BankCsvMapping | null>(null);
  const [preview, setPreview] = useState<BankImportPreview | null>(null);
  const runPreview = useMutation({
    mutationFn: (args: { name: string; content: string; mapping?: BankCsvMapping }) => previewBankImport(feedAccountId, { filename: args.name, content: args.content, mapping: args.mapping }),
    onSuccess: (p) => {
      setPreview(p);
      if (p.mapping) setMapping(p.mapping);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not read the file.'),
  });
  const run = useMutation({
    mutationFn: () => importBankFile(feedAccountId, { filename: file!.name, content: file!.content, mapping: preview?.format === 'CSV' ? (mapping ?? undefined) : undefined }),
    onSuccess: (r) => {
      toast.success(
        `${r.added} new ${r.added === 1 ? 'transaction' : 'transactions'}${r.duplicates ? ` · ${r.duplicates} already here` : ''}${r.autoCategorized ? ` · ${r.autoCategorized} categorized by your rules` : ''}.`,
      );
      void qc.invalidateQueries({ queryKey: BANK_KEY });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not import the file.'),
  });
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_700_000) {
      toast.error('That file is over 1.7 MB — export a shorter date range.');
      return;
    }
    const content = await readFileText(f);
    setFile({ name: f.name, content });
    setMapping(null);
    runPreview.mutate({ name: f.name, content });
  };
  const setCol = (key: keyof BankCsvMapping, v: string) => {
    if (!mapping || !file) return;
    const next = { ...mapping, [key]: v === '' ? null : Number(v) } as BankCsvMapping;
    // One amount column or the two-column pair, never both.
    if (key === 'amountColumn' && v !== '') Object.assign(next, { debitColumn: null, creditColumn: null });
    if ((key === 'debitColumn' || key === 'creditColumn') && v !== '') next.amountColumn = null;
    setMapping(next);
    runPreview.mutate({ name: file.name, content: file.content, mapping: next });
  };
  const setOpt = (patch: Partial<BankCsvMapping>) => {
    if (!mapping || !file) return;
    const next = { ...mapping, ...patch };
    setMapping(next);
    runPreview.mutate({ name: file.name, content: file.content, mapping: next });
  };
  const fresh = preview ? preview.total - preview.duplicates : 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import a statement</DialogTitle>
          <DialogDescription>A CSV from the bank’s website, or an OFX / QFX (Quicken) download. Anything already imported is skipped.</DialogDescription>
        </DialogHeader>
        <input ref={input} type="file" accept=".csv,.ofx,.qfx,.qbo,.txt,text/csv" className="sr-only" aria-label="Statement file" onChange={(e) => void pick(e.target.files?.[0])} />
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex w-full items-center gap-3 rounded-lg border border-dashed border-navy-secondary px-4 py-5 text-left transition-colors hover:border-gold/60"
        >
          <FileUp className="h-5 w-5 text-gold" aria-hidden="true" />
          <span className="text-sm">
            <span className="block font-medium text-ink">{file ? file.name : 'Choose a statement file'}</span>
            <span className="block text-xs text-silver">{file ? 'Choose another to replace it' : 'CSV, OFX or QFX, up to 1.7 MB'}</span>
          </span>
        </button>

        {runPreview.isPending && !preview && <Skeleton className="h-32 w-full" />}

        {preview?.format === 'CSV' && mapping && (
          <div className="space-y-3 rounded-lg border border-navy-secondary p-3">
            <p className="text-sm font-medium text-ink">Which column is which</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {COLUMN_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  {(p) => (
                    <Select {...p} value={mapping[f.key] == null ? '' : String(mapping[f.key])} onChange={(e) => setCol(f.key, e.target.value)}>
                      {f.optional && <option value="">—</option>}
                      {preview.columns.map((c, i) => (
                        <option key={i} value={i}>
                          {c || `Column ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ))}
              <Field label="Dates are written">
                {(p) => (
                  <Select {...p} value={mapping.dateOrder} onChange={(e) => setOpt({ dateOrder: e.target.value as BankCsvMapping['dateOrder'] })}>
                    <option value="MDY">Month / day / year</option>
                    <option value="DMY">Day / month / year</option>
                    <option value="YMD">Year-month-day</option>
                  </Select>
                )}
              </Field>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={mapping.flipSign} onChange={(e) => setOpt({ flipSign: e.target.checked })} />
              <span>
                <span className="block text-ink">Charges are positive numbers</span>
                <span className="block text-xs text-silver">Most card exports do this. Turn on so a charge reads as money out.</span>
              </span>
            </label>
          </div>
        )}

        {preview && (
          <div className="space-y-2">
            <p className="text-sm text-ink">
              {preview.total === 0 ? (
                'No transactions found with these columns.'
              ) : (
                <>
                  <span className="font-medium">{fresh}</span> new {fresh === 1 ? 'transaction' : 'transactions'}
                  {preview.duplicates > 0 && <span className="text-silver"> · {preview.duplicates} already imported</span>}
                </>
              )}
            </p>
            {preview.parsed.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-lg border border-navy-secondary">
                <table className="w-full text-sm">
                  <caption className="sr-only">The first transactions as they will import</caption>
                  <thead className="sticky top-0 bg-navy text-left text-xs text-silver">
                    <tr>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy-secondary">
                    {preview.parsed.map((t, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-silver">{t.postedOn}</td>
                        <td className="max-w-[18rem] truncate px-3 py-1.5 text-ink">{t.description}</td>
                        <td className="px-3 py-1.5 text-right">
                          <Amount value={t.amount} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.errors.length > 0 && (
              <ul className="space-y-0.5 text-xs text-warning">
                {preview.errors.slice(0, 5).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!file || !preview || fresh === 0 || (preview.format === 'CSV' && !mapping)}>
            Import {fresh > 0 ? fresh : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
