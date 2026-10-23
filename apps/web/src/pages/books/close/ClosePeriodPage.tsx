import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CheckCircle2, Circle, CircleSlash, Lock, LockOpen, Plus, Sparkles, Undo2 } from 'lucide-react';
import type { CloseTaskView, ClosePeriodDetail } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { createAccrual, finalizeCloseStatements, getCloseMonth, listAccruals, markCloseReady, postCloseHistory, requestCloseReopen, signOffClose, unmarkCloseReady, updateCloseTask } from '@/lib/books/closeApi';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtMoney, ymdLocal } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { cn } from '@/lib/cn';
import { RecordTemplate } from '@/components/templates';
import type { PageAction } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { AccountSelect, CloseStatusBadge, accountIdForKey, daysSinceMonthEnd, pct, useAccountOptions } from './closeKit';

/**
 * One month's close: the checklist (most steps check themselves against
 * the books and say what's left and where to fix it), the accruals, the
 * liability balances to tie out, and the two-person lock.
 */
export function ClosePeriodPage() {
  const { periodKey = '' } = useParams<{ periodKey: string }>();
  const qc = useQueryClient();
  const prompt = usePrompt();
  const [tab, setTab] = useUrlParam('tab', 'checklist', CLOSE_TABS, { history: 'push' });
  const q = useQuery({ queryKey: ['books', 'close', periodKey], queryFn: () => getCloseMonth(periodKey) });
  const d = q.data;

  const refresh = (next?: ClosePeriodDetail) => {
    if (next) qc.setQueryData(['books', 'close', periodKey], next);
    void qc.invalidateQueries({ queryKey: ['books', 'close'] });
  };
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : 'That didn’t go through.');

  const setTask = useMutation({
    mutationFn: (v: { key: string; status: 'OPEN' | 'DONE' | 'SKIPPED'; note?: string | null }) => updateCloseTask(periodKey, v.key, { status: v.status, note: v.note ?? null }),
    onSuccess: (next) => refresh(next),
    onError: fail,
  });
  const ready = useMutation({ mutationFn: () => markCloseReady(periodKey), onSuccess: (n) => (refresh(n), toast.success('Marked ready — a second person signs it off.')), onError: fail });
  const unready = useMutation({ mutationFn: () => unmarkCloseReady(periodKey), onSuccess: (n) => (refresh(n), toast.success('Taken back to work on.')), onError: fail });
  const signOff = useMutation({ mutationFn: () => signOffClose(periodKey), onSuccess: (n) => (refresh(n), toast.success(`${n.label} is closed.`)), onError: fail });
  // Finance walk 16: the step's own button — done here, no page change.
  type ActionResult = { month: ClosePeriodDetail; finalized?: number; failed: Array<{ clientName?: string; error: string }> };
  const runAction = useMutation<ActionResult, unknown, 'finalize_statements' | 'post_history'>({
    mutationFn: (kind) => (kind === 'finalize_statements' ? finalizeCloseStatements(periodKey) : postCloseHistory(periodKey)),
    onSuccess: (r, kind) => {
      refresh(r.month);
      void qc.invalidateQueries({ queryKey: ['books'] });
      const first = r.failed[0];
      if (kind === 'finalize_statements') {
        const n = r.finalized ?? 0;
        if (first) toast.error(`${n} finalized; ${first.clientName ?? 'one'}: ${first.error}`);
        else toast.success(`${n} ${n === 1 ? 'statement' : 'statements'} finalized — each numbered, due on its terms, and in the books.`);
      } else if (first) toast.error(`Some history couldn’t post: ${first.error}`);
      else toast.success('History posted to the books.');
    },
    onError: fail,
  });
  const reopen = useMutation({
    mutationFn: (reason: string) => requestCloseReopen(periodKey, reason),
    onSuccess: () => (refresh(), toast.success('Asked — someone else with the books decides.')),
    onError: fail,
  });

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error || !d) {
    return <EmptyState title="Couldn’t load this month" description={q.error instanceof ApiError ? q.error.message : 'Try again in a moment.'} />;
  }

  const skip = async (t: CloseTaskView) => {
    const note = await prompt({ title: `Skip “${t.title}”?`, description: 'The reason stays on the close for whoever signs it off.', reasonLabel: 'Why', confirmLabel: 'Skip step' });
    if (note) setTask.mutate({ key: t.key, status: 'SKIPPED', note });
  };
  // One click; a note only when there's something to say (inline on the row).
  const done = (t: CloseTaskView, note?: string) => setTask.mutate({ key: t.key, status: 'DONE', note: note?.trim() || null }, { onSuccess: () => toast.success(`“${t.title}” done.`) });
  const askReopen = async () => {
    const reason = await prompt({ title: `Reopen ${d.label}?`, description: 'Entries can post to it again until it’s closed again. Someone else with the books approves.', reasonLabel: 'Why it needs to reopen', confirmLabel: 'Ask to reopen' });
    if (reason) reopen.mutate(reason);
  };

  const waiting =
    d.status === 'READY'
      ? `Prepared by ${d.preparedByName ?? 'someone'} — waiting for a second person to sign it off.`
      : d.status === 'CLOSED'
        ? 'Locked — nothing more posts to it.'
        : d.reopenedAt
          ? `Reopened ${fmtDate(d.reopenedAt)}${d.reopenReason ? ` — ${d.reopenReason}` : ''}.`
          : d.ended
            ? 'Work the steps below, then mark it ready.'
            : `${d.label} is still running; the close opens when it ends.`;

  // The two-person lock, as the header's actions: one primary at a time.
  const actions: PageAction[] = [
    ...(d.status === 'OPEN' ? [{ key: 'ready', label: 'Ready to close', icon: Check, primary: true, disabled: !d.can.ready, hint: d.can.ready ? undefined : (d.can.why ?? undefined), loading: ready.isPending, onSelect: () => ready.mutate() }] : []),
    ...(d.status === 'READY' && d.can.signOff ? [{ key: 'sign', label: 'Sign off and close', icon: Lock, primary: true, loading: signOff.isPending, onSelect: () => signOff.mutate() }] : []),
    ...(d.status === 'READY' && d.can.unready ? [{ key: 'unready', label: 'Take it back', icon: Undo2, loading: unready.isPending, onSelect: () => unready.mutate() }] : []),
    ...(d.status === 'CLOSED' && d.can.reopen ? [{ key: 'reopen', label: 'Ask to reopen', icon: LockOpen, loading: reopen.isPending, onSelect: () => void askReopen() }] : []),
  ];
  const today = ymdLocal();
  const sinceEnd = daysSinceMonthEnd(periodKey, today);
  const closedAfter = d.closedAt ? Math.max(0, daysSinceMonthEnd(periodKey, d.closedAt.slice(0, 10))) : null;
  const openTasks = d.tasks.filter((t) => t.status === 'OPEN');
  // What stands between the month and its lock: each open step's listed items (a step with none is one thing).
  const blocking = openTasks.reduce((n, t) => n + Math.max(1, t.items.length), 0);

  return (
    <RecordTemplate
      title={`${d.label} close`}
      subtitle={waiting}
      status={<CloseStatusBadge status={d.status} ended={d.ended} size="lg" />}
      actions={actions}
      facts={[
        { label: 'Prepared by', value: d.preparedByName },
        { label: 'Signed off by', value: d.signedOffByName },
        { label: 'Closed', value: d.closedAt ? fmtDateTime(d.closedAt) : null },
      ]}
      summary={
        <div className="space-y-3">
          {/* Why the lock is out of reach, in words — not only in a tooltip. */}
          {d.status === 'OPEN' && !d.can.ready && d.can.why && (
            <p className="text-sm text-ink-muted" data-testid="close-why">
              {d.can.edit ? (
                <>
                  <span className="font-medium text-ink">Not ready to close yet:</span> {d.can.why}
                </>
              ) : (
                d.can.why
              )}
            </p>
          )}
          <MetricStrip label={`${d.label} close at a glance`}>
            <MetricCard label="Steps done" value={`${d.tasksDone} of ${d.tasksTotal}`} meter={{ percent: pct(d.tasksDone, d.tasksTotal), tone: d.tasksDone === d.tasksTotal ? 'good' : 'primary' }} />
            {d.status === 'CLOSED' && closedAfter !== null ? (
              <MetricCard label="Time to close" value={`${closedAfter} ${closedAfter === 1 ? 'day' : 'days'}`} hint="From month end to the lock" />
            ) : (
              <MetricCard label="Since month end" value={`${sinceEnd} ${sinceEnd === 1 ? 'day' : 'days'}`} nothing={sinceEnd > 0 ? undefined : `${d.label} is still running`} tone={sinceEnd > 10 ? 'warning' : 'default'} />
            )}
            <MetricCard
              label="Blocking the close"
              value={blocking}
              nothing={d.status === 'CLOSED' ? 'Closed' : blocking ? undefined : 'Nothing blocking'}
              hint={blocking ? `Across ${openTasks.length} open ${openTasks.length === 1 ? 'step' : 'steps'}` : undefined}
              tone={blocking ? 'warning' : 'default'}
              onClick={blocking ? () => setTab('checklist') : undefined}
            />
          </MetricStrip>
        </div>
      }
      activeTab={tab}
      onTabChange={(k) => setTab(k as (typeof CLOSE_TABS)[number])}
      tabs={[
        {
          key: 'checklist',
          label: 'Checklist',
          count: d.tasksTotal - d.tasksDone,
          content: (
            <div className="space-y-3">
              {d.pendingReopen && <p className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-sm text-ink">A request to reopen this month is waiting for a decision in Approvals.</p>}
              <ol className="space-y-2">
                {d.tasks.map((t) => (
                  <TaskRow key={t.key} task={t} editable={d.can.edit} busy={setTask.isPending} running={runAction.isPending && runAction.variables === t.action?.kind} onAction={t.action ? () => runAction.mutate(t.action!.kind) : undefined} onDone={(note) => done(t, note)} onSkip={() => void skip(t)} onReopen={() => setTask.mutate({ key: t.key, status: 'OPEN' })} />
                ))}
              </ol>
            </div>
          ),
        },
        { key: 'accruals', label: 'Accruals', content: <AccrualsTab periodKey={periodKey} editable={d.can.edit} /> },
        {
          key: 'liabilities',
          label: 'Payroll liabilities',
          content: (
            <Card>
              <CardContent className="pt-[var(--d-tile)]">
                <p className="mb-3 text-sm text-ink-muted">Balances at {d.label}’s end. Each should match what’s due on the next deposit or filing.</p>
                {d.liabilities.length === 0 ? (
                  <EmptyState title="No payroll liability accounts" description="They appear once payroll posts to the books." />
                ) : (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-line">
                      {d.liabilities.map((l) => (
                        <tr key={l.accountId}>
                          <td className="py-2 pr-3">
                            <Link to={`/books/accounts/${l.accountId}`} className="text-ink hover:text-gold hover:underline">
                              <span className="tabular-nums text-ink-muted">{l.code}</span> {l.name}
                            </Link>
                          </td>
                          <td className="py-2 text-right tabular-nums text-ink">{fmtMoney(l.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          ),
        },
      ]}
    />
  );
}

const CLOSE_TABS = ['checklist', 'accruals', 'liabilities'] as const;

function TaskRow({ task: t, editable, busy, running = false, onAction, onDone, onSkip, onReopen }: { task: CloseTaskView; editable: boolean; busy: boolean; running?: boolean; onAction?: () => void; onDone: (note?: string) => void; onSkip: () => void; onReopen: () => void }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const Icon = t.status === 'DONE' ? CheckCircle2 : t.status === 'SKIPPED' ? CircleSlash : Circle;
  return (
    <li className={cn('rounded-lg border bg-surface p-4', t.status === 'OPEN' ? 'border-line' : 'border-line/60')}>
      {/* Phone: the step reads full width and its buttons wrap under it; from sm the buttons sit to the right. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', t.status === 'DONE' ? 'text-success' : t.status === 'SKIPPED' ? 'text-ink-muted' : 'text-warning')} aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{t.title}</span>
              {t.auto ? (
                <Badge size="sm" variant="info" withDot={false}>
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  Checks itself
                </Badge>
              ) : (
                <Badge size="sm" variant="outline" withDot={false}>
                  By hand
                </Badge>
              )}
              {t.status === 'SKIPPED' && <Badge size="sm" variant="default">Skipped</Badge>}
            </div>
            <p className="text-sm text-ink-muted">{t.summary ?? t.detail}</p>
            {t.items.length > 0 && t.status === 'OPEN' && (
              <ul className="space-y-1 pt-1">
                {t.items.map((i, n) => (
                  <li key={n} className="text-sm">
                    {i.link ? (
                      <Link to={i.link} className="inline-flex items-center gap-1 text-gold hover:underline">
                        {i.label}
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    ) : (
                      <span className="text-ink">{i.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {t.note && <p className="border-l-2 border-line pl-2 text-sm text-ink">{t.note}</p>}
            {t.doneByName && t.status !== 'OPEN' && (
              <p className="text-xs text-ink-muted">
                {t.status === 'SKIPPED' ? 'Skipped' : 'Done'} by {t.doneByName}
                {t.doneAt ? ` · ${fmtDateTime(t.doneAt)}` : ''}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pl-8 sm:shrink-0 sm:justify-end sm:pl-0">
          {editable && t.status === 'OPEN' && t.action && onAction && (
            <Button size="sm" onClick={onAction} loading={running} disabled={busy || running}>
              <Check className="h-4 w-4" aria-hidden="true" />
              {t.action.label}
            </Button>
          )}
          {t.link && t.status === 'OPEN' && (
            <Button asChild size="sm" variant="ghost">
              <Link to={t.link}>Open</Link>
            </Button>
          )}
          {editable && t.status === 'OPEN' && !t.auto && !noting && (
            <>
              <Button size="sm" variant="secondary" onClick={() => onDone()} disabled={busy}>
                <Check className="h-4 w-4" aria-hidden="true" />
                Mark done
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNoting(true)} disabled={busy}>
                Add a note
              </Button>
            </>
          )}
          {editable && t.status === 'OPEN' && (
            <Button size="sm" variant="ghost" onClick={onSkip} disabled={busy}>
              Skip
            </Button>
          )}
          {editable && (t.status === 'SKIPPED' || (!t.auto && t.status === 'DONE')) && (
            <Button size="sm" variant="ghost" onClick={onReopen} disabled={busy}>
              Undo
            </Button>
          )}
        </div>
      </div>
      {noting && editable && t.status === 'OPEN' && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2 pl-8"
          onSubmit={(e) => {
            e.preventDefault();
            onDone(note);
          }}
        >
          <Input aria-label={`Note for “${t.title}”`} className="min-w-[16rem] flex-1" autoFocus maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tied to the statement; nothing outstanding" onKeyDown={(e) => e.key === 'Escape' && setNoting(false)} />
          <Button size="sm" type="submit" disabled={busy}>
            Mark done
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setNoting(false)}>
            Cancel
          </Button>
        </form>
      )}
    </li>
  );
}

function nextMonthStart(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function lastDay(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  return `${periodKey}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function AccrualsTab({ periodKey, editable }: { periodKey: string; editable: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['books', 'close', periodKey, 'accruals'], queryFn: () => listAccruals(periodKey) });
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState('');
  const [amount, setAmount] = useState('');
  const accounts = useAccountOptions();
  const [debitPick, setDebit] = useState('');
  const [creditPick, setCredit] = useState('');
  const debit = debitPick || accountIdForKey(accounts.data?.accounts, 'UTILITIES');
  const credit = creditPick || accountIdForKey(accounts.data?.accounts, 'ACCRUED_EXPENSES');
  const save = useMutation({
    mutationFn: () =>
      createAccrual({
        date: lastDay(periodKey),
        memo: memo.trim(),
        reverseOn: nextMonthStart(periodKey),
        lines: [
          { account: debit, debit: Number(amount) },
          { account: credit, credit: Number(amount) },
        ],
      }),
    onSuccess: () => {
      toast.success('Accrual recorded — it reverses on the 1st.');
      setOpen(false);
      setMemo('');
      setAmount('');
      void qc.invalidateQueries({ queryKey: ['books', 'close'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the accrual.'),
  });
  const rows = q.data?.accruals ?? [];
  return (
    <Card>
      <CardContent className="space-y-3 pt-[var(--d-tile)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">Costs of this month billed later, recorded now and reversed on the 1st of next month.</p>
          {editable && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Record an accrual
            </Button>
          )}
        </div>
        {q.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState title="No accruals this month" description="Record one for anything incurred this month that’s billed next." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="py-2 pr-3 font-medium">Entry</th>
                <th className="py-2 pr-3 font-medium">Memo</th>
                <th className="py-2 pr-3 text-right font-medium">Amount</th>
                <th className="py-2 font-medium">Reverses</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.entryId}>
                  <td className="py-2 pr-3">
                    <Link to={`/books/journal/${r.entryId}`} className="tabular-nums text-gold hover:underline">
                      #{r.number}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-ink">{r.memo ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-ink">{fmtMoney(r.amount)}</td>
                  <td className="py-2 text-ink-muted">{r.reversedOn ? `Reversed ${fmtDate(r.reversedOn)}` : r.reverseOn ? `On ${fmtDate(r.reverseOn)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record an accrual</DialogTitle>
            <DialogDescription>Dated {fmtDate(lastDay(periodKey))}; it reverses itself on {fmtDate(nextMonthStart(periodKey))}.</DialogDescription>
          </DialogHeader>
          <Field label="What it’s for">{(p) => <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="September utilities, billed in October" maxLength={500} {...p} />}</Field>
          <Field label="Amount">{(p) => <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} {...p} />}</Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Expense (debit)">{(p) => <AccountSelect value={debit} onChange={setDebit} types={['EXPENSE', 'ASSET']} {...p} />}</Field>
            <Field label="Owed (credit)">{(p) => <AccountSelect value={credit} onChange={setCredit} types={['LIABILITY']} {...p} />}</Field>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!memo.trim() || !(Number(amount) > 0) || !debit || !credit}>
              Record accrual
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
