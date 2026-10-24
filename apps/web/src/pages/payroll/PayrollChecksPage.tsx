import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Ban, FileDown, MoreHorizontal, Printer, RefreshCw, Ruler, Settings2, ShieldCheck, Undo2 } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import {
  clearPayByCheck,
  decidePayByCheckRequest,
  downloadFrom,
  getCheckSettings,
  getRunChecks,
  removeCheckSignature,
  reissueCheck,
  stopCheckPayment,
  updateCheckSettings,
  uploadCheckSignature,
  voidCheck,
  type CheckStatus,
  type RunCheck,
  type RunChecks,
} from '@/lib/paperChecksApi';
import { RunPageShell, type RunSubPageProps } from './RunPageShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { enumWords, known } from '@/lib/known';

/**
 * A payroll run's paper checks: who is paid by check this time (and the
 * associates' requests still waiting), the checks issued at payout with
 * their print / void / reissue / stop-payment actions, the positive-pay
 * file for the bank, and the tenant's check settings with the alignment
 * test.
 */

const STATUS: Record<CheckStatus, { label: string; variant: 'default' | 'success' | 'pending' | 'destructive' | 'info' }> = {
  ISSUED: { label: 'Not printed', variant: 'pending' },
  PRINTED: { label: 'Printed', variant: 'success' },
  VOID: { label: 'Void', variant: 'destructive' },
  STOPPED: { label: 'Stop payment', variant: 'destructive' },
};
/** STATUS for a value from the server — one this screen doesn't know yet reads as words (lib/known). */
const statusOf = (k: string) => known(STATUS, k, () => ({ label: enumWords(k), variant: 'default' as const }));

export function PayrollChecksPage({ runId, embedded = false }: RunSubPageProps = {}) {
  const params = useParams<{ id: string }>();
  const id = runId ?? params.id ?? '';
  const qc = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({ queryKey: ['payroll', 'checks', id], queryFn: () => getRunChecks(id), enabled: !!id });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll'] });
  const crumbs = [{ label: 'Payroll', to: '/payroll' }, { label: 'Run', to: `/payroll/runs/${id}` }, { label: 'Paper checks' }];

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  if (q.isError) {
    return (
      <RunPageShell embedded={embedded} title="Paper checks" breadcrumbs={crumbs}>
        <EmptyState title="We couldn’t load this run’s checks" description={q.error instanceof ApiError ? q.error.message : undefined} action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>Retry</Button>} />
      </RunPageShell>
    );
  }
  if (!q.data) {
    return (
      <RunPageShell embedded={embedded} title="Paper checks" breadcrumbs={crumbs}>
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </RunPageShell>
    );
  }
  const d = q.data;
  const live = d.checks.filter((c) => c.status === 'ISSUED' || c.status === 'PRINTED');
  const unpaid = d.run.status === 'DRAFT' || d.run.status === 'FINALIZED';
  const period = `${fmtDate(d.run.periodStart)} – ${fmtDate(d.run.periodEnd)}`;

  const onVoid = async (c: RunCheck) => {
    const reason = await prompt({ title: `Void check #${c.checkNumber}?`, description: `${c.payeeName} · ${fmtMoney(c.amount)}. The number stays on the register, and the next positive-pay file tells the bank.`, confirmLabel: 'Void check', destructive: true, reasonLabel: 'Why is it void?', reasonPlaceholder: 'Printed misaligned' });
    if (reason) await run(`void-${c.id}`, () => voidCheck(c.id, reason), `Check #${c.checkNumber} is void.`);
  };
  const onReissue = async (c: RunCheck) => {
    const reason = await prompt({ title: `Reissue check #${c.checkNumber}?`, description: `${c.status === 'VOID' || c.status === 'STOPPED' ? 'A new check' : 'This check is voided and a new one'} with the next number pays ${c.payeeName} ${fmtMoney(c.amount)}.`, confirmLabel: 'Reissue', reasonLabel: 'Why reissue?', reasonPlaceholder: 'Lost in the mail' });
    if (reason) await run(`reissue-${c.id}`, () => reissueCheck(c.id, reason), 'A new check is ready to print.');
  };
  const onStop = async (c: RunCheck) => {
    const reason = await prompt({ title: `Record a stop payment on #${c.checkNumber}?`, description: 'Do this after the bank confirms the stop. The check is voided here too; reissue it if the person still needs paying.', confirmLabel: 'Record stop payment', destructive: true, reasonLabel: 'Reason and the bank’s reference', reasonPlaceholder: 'Reported stolen · bank ref SP-4471' });
    if (reason) {
      const ref = /ref(?:erence)?\s*[:#]?\s*([A-Za-z0-9-]+)/i.exec(reason)?.[1] ?? null;
      await run(`stop-${c.id}`, () => stopCheckPayment(c.id, reason, ref), `Stop payment on #${c.checkNumber} recorded.`);
    }
  };

  const columns: GridColumn<RunCheck>[] = [
    { key: 'no', header: 'Check', sortable: true, accessor: (c) => c.checkNumber, cell: (c) => <span className="font-medium tabular-nums text-ink">#{c.checkNumber}</span>, primary: true },
    { key: 'payee', header: 'Payee', sortable: true, accessor: (c) => c.payeeName, cell: (c) => <span className={cn(c.status === 'VOID' || c.status === 'STOPPED' ? 'text-ink-muted line-through' : 'text-ink')}>{c.payeeName}</span> },
    { key: 'amount', header: 'Amount', align: 'right', sortable: true, searchable: false, accessor: (c) => c.amount, cell: (c) => fmtMoney(c.amount), className: 'tabular-nums' },
    {
      key: 'status',
      header: 'Status',
      accessor: (c) => statusOf(c.status).label,
      cardMeta: true,
      cell: (c) => (
        <span className="flex flex-col gap-0.5">
          <Badge variant={statusOf(c.status).variant}>{statusOf(c.status).label}</Badge>
          {c.voidReason && <span className="text-xs text-ink-muted">{c.voidReason}</span>}
          {c.replacesCheckNumber && <span className="text-xs text-ink-muted">Replaces #{c.replacesCheckNumber}</span>}
        </span>
      ),
    },
    { key: 'printed', header: 'Printed', accessor: (c) => c.printedAt ?? '', cell: (c) => (c.printedAt ? <span className="text-xs text-ink-muted">{fmtDateTime(c.printedAt)}{c.printCount > 1 ? ` · ${c.printCount}×` : ''}</span> : <span className="text-xs text-ink-muted">—</span>), defaultHidden: false },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      stopRowClick: true,
      cell: (c) =>
        c.status === 'VOID' || c.status === 'STOPPED' ? (
          !d.checks.some((x) => x.replacesCheckNumber === c.checkNumber) ? (
            <Button size="sm" variant="ghost" loading={busy === `reissue-${c.id}`} onClick={() => void onReissue(c)}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Reissue
            </Button>
          ) : null
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label={`Actions for check #${c.checkNumber}`}>
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!d.settings.ready} onSelect={() => void run(`print-${c.id}`, () => downloadFrom(`/payroll/checks/${c.id}/print.pdf`, `check-${c.checkNumber}.pdf`), `Check #${c.checkNumber} is ready to print.`)}>
                <Printer className="h-4 w-4" aria-hidden="true" />
                {c.printedAt ? 'Reprint' : 'Print'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void onReissue(c)}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Void and reissue
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void onVoid(c)}>
                <Ban className="h-4 w-4" aria-hidden="true" />
                Void
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void onStop(c)}>
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                Record stop payment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
    },
  ];

  return (
    <RunPageShell
      embedded={embedded}
      title="Paper checks"
      subtitle={`Pay period ${period}`}
      breadcrumbs={crumbs}
      primaryAction={
        <Button
          disabled={!d.settings.ready || live.length === 0}
          loading={busy === 'print-all'}
          onClick={() => void run('print-all', () => downloadFrom(`/payroll/runs/${id}/checks.pdf`, 'checks.pdf'), `${live.length} check${live.length === 1 ? '' : 's'} ready to print.`)}
        >
          <Printer className="h-4 w-4" aria-hidden="true" />
          Print {live.length > 0 ? `${live.length} check${live.length === 1 ? '' : 's'}` : 'checks'}
        </Button>
      }
      secondaryActions={
        <>
          <Button variant="secondary" disabled={d.checks.length === 0 || !d.settings.ready} loading={busy === 'pp'} onClick={() => void run('pp', () => downloadFrom(`/payroll/positive-pay.csv?runId=${id}`, 'positive-pay.csv'), 'Positive-pay file downloaded. Send it to the bank.')}>
            <FileDown className="h-4 w-4" aria-hidden="true" />
            Positive pay
          </Button>
          <Button variant="secondary" disabled={d.checks.length === 0} loading={busy === 'reg'} onClick={() => void run('reg', () => downloadFrom(`/payroll/runs/${id}/check-register.pdf`, 'check-register.pdf'), 'Check register downloaded.')}>
            <FileDown className="h-4 w-4" aria-hidden="true" />
            Register
          </Button>
          <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" aria-hidden="true" />
            Check settings
          </Button>
        </>
      }
      // The setup gaps matter once there is a check to print (or one coming at payout); on a run with
      // no paper checks they'd be a red alarm about nothing — Check settings still lists them (F500 G3).
      summary={
        d.settings.gaps.length > 0 && (d.checks.length > 0 || d.overrides.length > 0) ? (
          <div role="status" className={cn('flex items-start gap-3 rounded-lg border p-3.5', d.settings.ready ? 'border-warning/40 bg-warning/5' : 'border-alert/40 bg-alert/5')}>
            <AlertTriangle className={cn('mt-0.5 h-5 w-5 shrink-0', d.settings.ready ? 'text-warning' : 'text-alert')} aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">{d.settings.ready ? 'Before checks go to a bank' : 'Set up check printing first'}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-muted">
                {d.settings.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
            <Button size="sm" variant="secondary" className="ml-auto shrink-0" onClick={() => setSettingsOpen(true)}>
              Open settings
            </Button>
          </div>
        ) : null
      }
    >
      <PayByCheckCard data={d} unpaid={unpaid} onChanged={refresh} />

      <section aria-labelledby="checks-title" className="space-y-2">
        <h2 id="checks-title" className="text-base font-medium text-ink">
          Checks issued
        </h2>
        {d.checks.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                size="sm"
                icon={Printer}
                title={unpaid ? 'Checks are issued at payout' : 'No paper checks in this run'}
                description={unpaid ? 'Each check gets its number when the run pays out. Print them from here afterwards.' : 'Everyone in this run was paid electronically.'}
              />
            </CardContent>
          </Card>
        ) : (
          <DataGrid id="payroll-run-checks" caption="Checks issued for this run" rows={d.checks} columns={columns} rowKey={(c) => c.id} noun={{ one: 'check', many: 'checks' }} defaultSort={{ key: 'no', direction: 'asc' }} />
        )}
      </section>

      {settingsOpen && <CheckSettingsDrawer onClose={() => setSettingsOpen(false)} onSaved={refresh} />}
    </RunPageShell>
  );
}

/* ---- Who is paid by check this time ----------------------------------------- */

function PayByCheckCard({ data, unpaid, onChanged }: { data: RunChecks; unpaid: boolean; onChanged: () => void }) {
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };
  if (data.overrides.length === 0 && data.requests.length === 0) {
    return unpaid ? (
      <Card>
        <CardContent className="flex flex-col gap-2 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="text-ink-muted">Everyone is paid their usual way this payday. Switch a paycheck to a paper check from the run’s paystubs.</span>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/payroll?run=${data.run.id}`}>
              Open the run
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    ) : null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Paid by check this time{data.overrides.length > 0 && <span className="ml-1.5 text-ink-muted">({data.overrides.length})</span>}
        </CardTitle>
        <CardDescription>Their usual deposit stays on file and resumes next payday. These checks never go into the bank file.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-line">
          {data.requests.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  {r.title}
                  <Badge size="sm" withDot={false} variant="pending">
                    Asked {fmtDate(r.createdAt)}
                  </Badge>
                </span>
                {r.reason && <span className="mt-0.5 block text-xs text-ink-muted">“{r.reason}”</span>}
              </span>
              {unpaid && (
                <span className="flex shrink-0 gap-2">
                  <Button size="sm" loading={busy === `ok-${r.id}`} onClick={() => void act(`ok-${r.id}`, () => decidePayByCheckRequest(r.id, 'APPROVE'), 'Approved. This paycheck goes by paper check.')}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `no-${r.id}`}
                    onClick={async () => {
                      const why = await prompt({ title: 'Decline this request?', description: 'They’re paid their usual way and see your reason.', confirmLabel: 'Decline', reasonLabel: 'Reason they’ll see' });
                      if (why) await act(`no-${r.id}`, () => decidePayByCheckRequest(r.id, 'REJECT', why), 'Declined.');
                    }}
                  >
                    Decline
                  </Button>
                </span>
              )}
            </li>
          ))}
          {data.overrides.map((o) => (
            <li key={o.itemId} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  {o.name}
                  <Badge size="sm" withDot={false} variant={o.source === 'ASSOCIATE' ? 'info' : 'outline'}>
                    {o.source === 'ASSOCIATE' ? 'They asked' : 'Payroll’s call'}
                  </Badge>
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">{o.reason}</span>
              </span>
              {unpaid && (
                <Button size="sm" variant="ghost" loading={busy === `undo-${o.itemId}`} onClick={() => void act(`undo-${o.itemId}`, () => clearPayByCheck(o.itemId), `${o.name} is back to their usual deposit.`)}>
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---- Settings ------------------------------------------------------------------ */

function CheckSettingsDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const q = useQuery({ queryKey: ['payroll', 'check-settings'], queryFn: getCheckSettings });
  const [form, setForm] = useState<{ bankAccountId: string; bankName: string; bankAddress: string; fractionalRouting: string; signatureSignerName: string; twoSignatureOver: string; voidAfterDays: string; offsetXPt: string; offsetYPt: string } | null>(null);
  useEffect(() => {
    if (!q.data || form) return;
    const s = q.data.settings;
    setForm({
      bankAccountId: s.bankAccountId ?? '',
      bankName: s.bankName ?? '',
      bankAddress: s.bankAddress ?? '',
      fractionalRouting: s.fractionalRouting ?? '',
      signatureSignerName: s.signatureSignerName ?? '',
      twoSignatureOver: s.twoSignatureOver != null ? String(s.twoSignatureOver) : '',
      voidAfterDays: String(s.voidAfterDays),
      offsetXPt: String(s.offsetXPt),
      offsetYPt: String(s.offsetYPt),
    });
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: () =>
      updateCheckSettings({
        bankAccountId: form!.bankAccountId || null,
        bankName: form!.bankName.trim() || null,
        bankAddress: form!.bankAddress.trim() || null,
        fractionalRouting: form!.fractionalRouting.trim() || null,
        signatureSignerName: form!.signatureSignerName.trim() || null,
        twoSignatureOver: form!.twoSignatureOver.trim() ? Number(form!.twoSignatureOver) : null,
        voidAfterDays: Number(form!.voidAfterDays) || 90,
        offsetXPt: Number(form!.offsetXPt) || 0,
        offsetYPt: Number(form!.offsetYPt) || 0,
      }),
    onSuccess: () => {
      toast.success('Check settings saved.');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const signature = useMutation({
    mutationFn: async (file: File | null) => {
      if (!file) return removeCheckSignature();
      if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Use a PNG or JPEG.');
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(new Error('Could not read the file.'));
        r.readAsDataURL(file);
      });
      return uploadCheckSignature(b64, file.type as 'image/png' | 'image/jpeg', form?.signatureSignerName || null);
    },
    onSuccess: () => {
      toast.success('Signature updated.');
      void q.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not upload the signature.'),
  });
  const set = (k: keyof NonNullable<typeof form>) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  const offsetsOk = form ? [form.offsetXPt, form.offsetYPt].every((v) => Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 36) : false;

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>Check settings</DrawerTitle>
        <DrawerDescription>The account checks are drawn on, how they’re signed, and printer calibration.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {!form || !q.data ? (
          <Skeleton className="h-96" />
        ) : (
          <form
            id="check-settings"
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (offsetsOk) save.mutate();
            }}
          >
            <fieldset className="space-y-3">
              <legend className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">Bank</legend>
              <Field label="Account checks are drawn on" hint={q.data.accounts.length === 0 ? 'Add the account in Payroll banking first.' : 'Its routing and account numbers print in the MICR line.'}>
                <Select value={form.bankAccountId} onChange={set('bankAccountId')}>
                  <option value="">Choose…</option>
                  {q.data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ••••{a.accountLast4}
                      {a.bankName ? ` · ${a.bankName}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Bank name on the check">
                <Input value={form.bankName} maxLength={120} onChange={set('bankName')} placeholder="First Coast Bank" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Bank city and state">
                  <Input value={form.bankAddress} maxLength={200} onChange={set('bankAddress')} placeholder="Panama City, FL" />
                </Field>
                <Field label="ABA fraction" hint="Top right of your bank’s checks.">
                  <Input value={form.fractionalRouting} maxLength={20} onChange={set('fractionalRouting')} placeholder="63-1234/631" inputMode="numeric" />
                </Field>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">Signature</legend>
              <Field label="Authorized signer">
                <Input value={form.signatureSignerName} maxLength={120} onChange={set('signatureSignerName')} placeholder="Dana Reyes, Controller" />
              </Field>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={cn('inline-flex items-center gap-1.5', q.data.settings.hasSignature ? 'text-success' : 'text-ink-muted')}>
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  {q.data.settings.hasSignature ? 'Facsimile signature on file' : 'No facsimile: checks print with a blank line for a wet signature'}
                </span>
                <label className="cursor-pointer text-accent underline underline-offset-2">
                  {q.data.settings.hasSignature ? 'Replace' : 'Upload PNG or JPEG'}
                  <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && signature.mutate(e.target.files[0])} />
                </label>
                {q.data.settings.hasSignature && (
                  <button type="button" className="text-ink-muted underline underline-offset-2" onClick={() => signature.mutate(null)}>
                    Remove
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Two signatures over" hint="The facsimile never prints on these.">
                  <Input value={form.twoSignatureOver} onChange={set('twoSignatureOver')} inputMode="decimal" placeholder="5000" />
                </Field>
                <Field label="Void after (days)">
                  <Input value={form.voidAfterDays} onChange={set('voidAfterDays')} inputMode="numeric" />
                </Field>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-muted">Printer calibration</legend>
              <p className="text-sm text-ink-muted">Print the alignment test on plain paper, lay it over your check stock, and shift by points (72 = one inch) until the boxes line up.</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Across (pt)" error={offsetsOk ? undefined : 'Between −36 and 36'}>
                  <Input value={form.offsetXPt} onChange={set('offsetXPt')} inputMode="decimal" />
                </Field>
                <Field label="Down (pt)">
                  <Input value={form.offsetYPt} onChange={set('offsetYPt')} inputMode="decimal" />
                </Field>
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={() => void downloadFrom('/payroll/checks/alignment.pdf', 'check-alignment-test.pdf').catch((err: Error) => toast.error(err.message))}>
                <Ruler className="h-4 w-4" aria-hidden="true" />
                Alignment test
              </Button>
            </fieldset>

            {!q.data.settings.micrFontInstalled && (
              <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-ink-muted">
                <span className="font-medium text-ink">MICR font not installed.</span> Banks read the bottom line of a check magnetically. Install a licensed E-13B MICR font on the server and print on MICR toner before issuing checks to a bank.
              </p>
            )}
          </form>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form="check-settings" loading={save.isPending} disabled={!form || !offsetsOk}>
          Save settings
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
