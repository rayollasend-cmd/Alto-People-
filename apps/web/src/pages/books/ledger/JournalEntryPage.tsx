import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, ExternalLink, Plus, Trash2 } from 'lucide-react';
import type { BooksJournalEntryDetail } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { getJournalEntry, postManualEntry, voidJournalEntry } from '@/lib/books/ledgerApi';
import { fmtDate, fmtDateTime, fmtMoney, ymdLocal } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { AccountSelect, Amount, sourceLabel, useBooksDimensions, useLedgerAccounts } from './ledgerKit';

/**
 * One journal entry — its lines, where it came from, and its void or
 * reversal — or, at /books/journal/new, a manual entry: lines with an
 * account, a debit or a credit and the client / site / department they
 * belong to, the totals live, and Post only once it balances. An accrual
 * names the day it reverses itself.
 */
export function JournalEntryPage() {
  const { id = '' } = useParams<{ id: string }>();
  return id === 'new' ? <NewEntry /> : <ViewEntry id={id} />;
}

function ViewEntry({ id }: { id: string }) {
  const { can } = useAuth();
  const prompt = usePrompt();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['books', 'journal', 'entry', id], queryFn: () => getJournalEntry(id) });
  const voidIt = useMutation({
    mutationFn: (reason: string) => voidJournalEntry(id, reason),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['books'] });
      if (r.voided) toast.success('Entry voided.');
      else if (r.reversalId) {
        toast.success('Its month is closed, so a reversing entry was posted in the first open month.');
        navigate(`/books/journal/${r.reversalId}`);
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not void the entry.'),
  });
  if (q.isError) return <QueryError what="the entry" query={q} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const e = q.data.entry;
  const manual = ['MANUAL', 'ACCRUAL', 'OPENING'].includes(e.source) && e.origin === 'SITE';
  const debit = e.lines.reduce((s, l) => s + l.debit, 0);
  const credit = e.lines.reduce((s, l) => s + l.credit, 0);
  const askVoid = async () => {
    const reason = await prompt({
      title: e.periodClosed ? `Reverse entry #${e.number}?` : `Void entry #${e.number}?`,
      description: e.periodClosed ? `${e.periodKey} is closed, so the entry stays and a reversing entry posts in the first open month.` : 'It stays on the record, marked void, and leaves every report.',
      reasonLabel: 'Why',
      reasonPlaceholder: 'Entered twice',
      confirmLabel: e.periodClosed ? 'Reverse' : 'Void',
      destructive: true,
    });
    if (reason) voidIt.mutate(reason);
  };
  return (
    <ListTemplate
      title={`Journal entry #${e.number}`}
      subtitle={e.memo ?? sourceLabel(e.source)}
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Journal', to: '/books/journal' }, { label: `#${e.number}` }]}
      primaryAction={
        can('manage:books') && manual && e.status === 'POSTED' ? (
          <Button variant="secondary" onClick={() => void askVoid()} loading={voidIt.isPending}>
            <Ban className="h-4 w-4" aria-hidden="true" />
            {e.periodClosed ? 'Reverse' : 'Void'}
          </Button>
        ) : undefined
      }
    >
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Date" value={fmtDate(e.date)} />
          <Fact
            label="From"
            value={
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant={e.origin === 'QUICKBOOKS' ? 'info' : 'outline'}>{e.origin === 'QUICKBOOKS' ? 'Entered in QuickBooks' : sourceLabel(e.source)}</Badge>
                {e.sourceLink && (
                  <Link to={e.sourceLink.to} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
                    {e.sourceLink.label}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                )}
              </span>
            }
          />
          <Fact label="Amount" value={<Amount value={e.total} strong />} />
          <Fact
            label="Status"
            value={
              <span className="flex flex-wrap gap-1">
                <Badge variant={e.status === 'VOID' ? 'destructive' : 'success'}>{e.status === 'VOID' ? 'Void' : 'Posted'}</Badge>
                {e.periodClosed && <Badge variant="outline">{e.periodKey} closed</Badge>}
                {e.reverseOn && <Badge variant="pending">Reverses {fmtDate(e.reverseOn)}</Badge>}
              </span>
            }
          />
          <Fact label="Posted" value={`${fmtDateTime(e.postedAt)}${e.createdByName ? ` · ${e.createdByName}` : e.origin === 'SITE' && !manual ? ' · automatically' : ''}`} />
          {e.reverses && <Fact label="Reverses" value={<Link to={`/books/journal/${e.reverses.id}`} className="text-accent hover:underline">Entry #{e.reverses.number}</Link>} />}
          {e.reversedBy.length > 0 && (
            <Fact
              label="Reversed by"
              value={e.reversedBy.map((r) => (
                <Link key={r.id} to={`/books/journal/${r.id}`} className="mr-2 text-accent hover:underline">
                  #{r.number}
                </Link>
              ))}
            />
          )}
          {e.status === 'VOID' && <Fact label="Voided" value={`${e.voidedAt ? fmtDateTime(e.voidedAt) : ''}${e.voidedByName ? ` · ${e.voidedByName}` : ''}${e.voidReason ? ` — ${e.voidReason}` : ''}`} />}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="overflow-x-auto p-4">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">Lines</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-muted">
                <th className="py-2 font-medium" scope="col">Account</th>
                <th className="py-2 font-medium" scope="col">Memo</th>
                <th className="py-2 font-medium" scope="col">For</th>
                <th className="py-2 text-right font-medium" scope="col">Debit</th>
                <th className="py-2 text-right font-medium" scope="col">Credit</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id} className={cn('border-b border-line', e.status === 'VOID' && 'opacity-60')}>
                  <td className="py-2">
                    <Link to={`/books/accounts/${l.account.id}`} className="hover:underline">
                      <span className="mr-2 tabular-nums text-ink-muted">{l.account.code}</span>
                      <span className="text-ink">{l.account.name}</span>
                    </Link>
                  </td>
                  <td className="py-2 text-ink-muted">{l.memo ?? ''}</td>
                  <td className="py-2 text-ink-muted">{dimensionWords(l)}</td>
                  <td className="py-2 text-right">
                    <Amount value={l.debit} blankZero />
                  </td>
                  <td className="py-2 text-right">
                    <Amount value={l.credit} blankZero />
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row" colSpan={3} className="py-2 text-left font-semibold text-ink">
                  Total
                </th>
                <td className="py-2 text-right">
                  <Amount value={debit} strong />
                </td>
                <td className="py-2 text-right">
                  <Amount value={credit} strong />
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </ListTemplate>
  );
}

function dimensionWords(l: BooksJournalEntryDetail['lines'][number]): string {
  return [l.client?.name, l.site?.name, l.department?.name, l.costCenter?.name, l.vendor?.name].filter(Boolean).join(' · ');
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-2xs uppercase tracking-wider text-ink-muted">{label}</p>
      <div className="mt-1 text-sm text-ink">{value}</div>
    </div>
  );
}

/* ---- A manual entry ---------------------------------------------------------- */

interface DraftLine {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  clientId: string;
  siteId: string;
  departmentId: string;
}

const cents = (s: string) => Math.round((Number(s.replace(/[$,\s]/g, '')) || 0) * 100);
let nextKey = 1;
const blank = (): DraftLine => ({ key: nextKey++, accountId: '', debit: '', credit: '', memo: '', clientId: '', siteId: '', departmentId: '' });

function NewEntry() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accounts = useLedgerAccounts();
  const dims = useBooksDimensions();
  const [date, setDate] = useState(ymdLocal());
  const [memo, setMemo] = useState('');
  const [accrual, setAccrual] = useState(false);
  const [reverseOn, setReverseOn] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() => [blank(), blank()]);
  const totals = useMemo(() => {
    const d = lines.reduce((s, l) => s + cents(l.debit), 0);
    const c = lines.reduce((s, l) => s + cents(l.credit), 0);
    return { debit: d / 100, credit: c / 100, diff: (d - c) / 100 };
  }, [lines]);
  const filled = lines.filter((l) => l.accountId && (cents(l.debit) > 0 || cents(l.credit) > 0));
  const problems: string[] = [];
  if (filled.length < 2) problems.push('Add at least two lines with an account and an amount.');
  if (lines.some((l) => cents(l.debit) > 0 && cents(l.credit) > 0)) problems.push('A line is a debit or a credit, not both.');
  if (lines.some((l) => (cents(l.debit) > 0 || cents(l.credit) > 0) && !l.accountId)) problems.push('Every line with an amount needs an account.');
  if (Math.round(totals.diff * 100) !== 0) problems.push(`Debits and credits differ by ${fmtMoney(Math.abs(totals.diff))}.`);
  if (accrual && (!reverseOn || reverseOn <= date)) problems.push('Pick the day after the entry, or later, for the reversal.');

  const post = useMutation({
    mutationFn: () =>
      postManualEntry({
        date,
        memo: memo.trim() || null,
        reverseOn: accrual ? reverseOn : null,
        lines: filled.map((l) => ({
          accountId: l.accountId,
          debit: cents(l.debit) / 100,
          credit: cents(l.credit) / 100,
          memo: l.memo.trim() || null,
          clientId: l.clientId || null,
          siteId: l.siteId || null,
          departmentId: l.departmentId || null,
        })),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['books'] });
      toast.success(`Entry #${r.entry.number} posted.`);
      navigate(`/books/journal/${r.entry.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not post the entry.'),
  });

  if (!can('manage:books')) return <EmptyState title="Journal entries are Finance’s to post" description="You can read the books; posting needs the books manager role." />;

  const update = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const d = dims.data;
  return (
    <ListTemplate
      title="New journal entry"
      subtitle="For what the platform doesn’t post on its own — an adjustment, a loan, owner money, an accrual."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Journal', to: '/books/journal' }, { label: 'New entry' }]}
      secondaryActions={
        <Button asChild variant="ghost">
          <Link to="/books/journal">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Link>
        </Button>
      }
    >
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-[12rem_1fr]">
          <Field label="Date">{(p) => <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} {...p} />}</Field>
          <Field label="Memo">{(p) => <Input value={memo} maxLength={500} placeholder="What this entry is for" onChange={(e) => setMemo(e.target.value)} {...p} />}</Field>
          <label className="flex cursor-pointer items-start gap-3 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={accrual} onChange={(e) => setAccrual(e.target.checked)} />
            <span>
              <span className="block font-medium text-ink">Accrual — reverse it automatically</span>
              <span className="block text-ink-muted">For a cost this month that’s billed next month: the books carry it now and take it back on the day you pick.</span>
            </span>
          </label>
          {accrual && <Field label="Reverses on">{(p) => <Input type="date" value={reverseOn} min={date} onChange={(e) => setReverseOn(e.target.value)} {...p} />}</Field>}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4">
          <ol className="space-y-3">
            {lines.map((l, i) => (
              <li key={l.key} className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-[minmax(14rem,2fr)_8rem_8rem_auto]" aria-label={`Line ${i + 1}`}>
                <AccountSelect accounts={accounts.data?.accounts ?? []} value={l.accountId} onChange={(v) => update(l.key, { accountId: v })} label={`Line ${i + 1} account`} />
                <Input inputMode="decimal" aria-label={`Line ${i + 1} debit`} placeholder="Debit" value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })} className="text-right tabular-nums" />
                <Input inputMode="decimal" aria-label={`Line ${i + 1} credit`} placeholder="Credit" value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} className="text-right tabular-nums" />
                <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
                <div className="grid gap-2 md:col-span-4 md:grid-cols-4">
                  <Input aria-label={`Line ${i + 1} memo`} placeholder="Line memo (optional)" value={l.memo} maxLength={300} onChange={(e) => update(l.key, { memo: e.target.value })} />
                  {(d?.clients.length ?? 0) > 0 && (
                    <Select aria-label={`Line ${i + 1} client`} value={l.clientId} onChange={(e) => update(l.key, { clientId: e.target.value })}>
                      <option value="">No client</option>
                      {d!.clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  {(d?.sites.length ?? 0) > 0 && (
                    <Select aria-label={`Line ${i + 1} site`} value={l.siteId} onChange={(e) => update(l.key, { siteId: e.target.value })}>
                      <option value="">No site</option>
                      {d!.sites.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  {(d?.departments.length ?? 0) > 0 && (
                    <Select aria-label={`Line ${i + 1} department`} value={l.departmentId} onChange={(e) => update(l.key, { departmentId: e.target.value })}>
                      <option value="">No department</option>
                      {d!.departments.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a line
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-t border-line pt-3 text-sm" aria-live="polite">
            <span className="text-ink-muted">
              Debits <Amount value={totals.debit} strong />
            </span>
            <span className="text-ink-muted">
              Credits <Amount value={totals.credit} strong />
            </span>
            <span className={cn('font-medium', Math.round(totals.diff * 100) === 0 ? 'text-success' : 'text-alert')}>{Math.round(totals.diff * 100) === 0 ? 'Balanced' : `Off by ${fmtMoney(Math.abs(totals.diff))}`}</span>
          </div>
          {problems.length > 0 && filled.length > 0 && (
            <ul className="space-y-1 text-sm text-warning" role="status">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" asChild>
              <Link to="/books/journal">Cancel</Link>
            </Button>
            <Button onClick={() => post.mutate()} disabled={problems.length > 0} loading={post.isPending}>
              Post entry
            </Button>
          </div>
        </CardContent>
      </Card>
    </ListTemplate>
  );
}
