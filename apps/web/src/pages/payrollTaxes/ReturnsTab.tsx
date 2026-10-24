import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Download, FilePlus2, FileText } from '@/components/ui/icons';
import {
  amendTaxReturn,
  downloadReturnCsv,
  fileTaxReturn,
  generateTaxReturn,
  getReturn,
  listReturns,
  recordReturnOutcome,
  type ChecklistReturn,
  type TaxReturn,
} from '@/lib/payrollTaxesApi';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { listTaxForms } from '@/lib/payrollTax91Api';
import { EfileAction } from '@/pages/payrollTax/EfileAction';
import { FORM_KIND_LABEL } from '@/pages/payrollTax/PayrollTaxHome';
import { DueBadge, FIGURE_LABEL, ReturnBadge, byColumnOrder, byFigureOrder, dueText, isCountFigure, localToday, quarterName, recentQuarters } from './taxShared';

/**
 * Forms an agency sent back: every W-2, W-2c, 1099 (or 941/940) whose e-file
 * was rejected, with the agency's reason and the way to send it again. The
 * Inbox's "Tax filings rejected" opens this tab, so the list it counts is
 * the first thing here.
 */
export function RejectedFormsCard() {
  const q = useQuery({ queryKey: ['payroll-taxes', 'rejected-forms'], queryFn: () => listTaxForms({ efileStatus: 'REJECTED' }) });
  const rows = q.data?.forms ?? [];
  if (q.isError) return <QueryError what="the rejected filings" query={q} />;
  if (q.isLoading || rows.length === 0) return null;
  return (
    <Card className="border-alert/40" id="rejected-filings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-alert" aria-hidden />
          {`Rejected by the agency (${rows.length})`}
        </CardTitle>
        <CardDescription>Fix what the agency named, then send the form again. Until then it isn’t filed.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-navy-secondary" aria-label="Rejected filings">
          {rows.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {`${FORM_KIND_LABEL[f.kind]} · ${f.taxYear}${f.quarter ? ` Q${f.quarter}` : ''}${f.associateName ? ` · ${f.associateName}` : ''}`}
                </p>
                <p className="text-xs text-alert">{f.efileRejectionReason ?? 'The agency gave no reason. Check the filing partner’s message.'}</p>
                {f.efileStatusAt && <p className="text-xs text-ink-muted">{`Rejected ${fmtDateTime(f.efileStatusAt)}`}</p>}
              </div>
              <EfileAction formId={f.id} formLabel={FORM_KIND_LABEL[f.kind]} status={f.status} efileStatus={f.efileStatus} onChanged={() => void q.refetch()} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Returns by quarter: what each quarter needs, generate, review, file, amend.
 * The year-end forms (W-2, 1099, the 941/940 builders) live on the Year-end
 * page's Forms tab — one home for year-end (F500 G3).
 */
export function ReturnsTab({ provider }: { provider: boolean }) {
  const quarters = recentQuarters();
  const [period, setPeriod] = useState(quarters[1] ?? quarters[0]!);
  const [openId, setOpenId] = useState<string | null>(null);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-taxes', 'returns', period], queryFn: () => listReturns(period) });
  const generate = useMutation({
    mutationFn: (c: ChecklistReturn) => generateTaxReturn(c.kind, c.jurisdiction, c.periodLabel),
    onSuccess: (r) => {
      toast.success('Draft ready. Review the figures before filing.');
      void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });
      setOpenId(r.return.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const visible = (q.data?.returns ?? []).filter((r) => r.status !== 'SUPERSEDED');
  const columns: GridColumn<TaxReturn>[] = [
    { key: 'label', header: 'Return', primary: true, accessor: (r) => r.label, cell: (r) => <span className="font-medium text-ink">{r.label}</span>, sortable: true },
    { key: 'agency', header: 'Agency', accessor: (r) => r.agency, cardMeta: true },
    { key: 'period', header: 'Period', accessor: (r) => r.periodLabel },
    { key: 'due', header: 'Due', accessor: (r) => r.dueDate, cell: (r) => fmtDate(r.dueDate), sortable: true },
    { key: 'tax', header: 'Tax', accessor: (r) => r.totals.taxDue ?? 0, cell: (r) => fmtMoney(r.totals.taxDue ?? 0), align: 'right', className: 'tabular-nums' },
    { key: 'status', header: 'Status', accessor: (r) => r.status, cell: (r) => <ReturnBadge status={r.status} />, searchable: false },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Quarter" className="w-full sm:w-72">
          {(p) => (
            <Select {...p} value={period} onChange={(e) => setPeriod(e.target.value)}>
              {quarters.map((x) => (
                <option key={x} value={x}>
                  {quarterName(x)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{`What ${quarterName(period)} needs`}</CardTitle>
          <CardDescription>From the taxes payroll posted in the quarter. Fourth quarters add the yearly returns.</CardDescription>
        </CardHeader>
        <CardContent>
          {q.isError ? (
            <QueryError what="this quarter’s returns" query={q} />
          ) : q.isLoading ? (
            <SkeletonRows count={3} />
          ) : (q.data?.checklist ?? []).length === 0 ? (
            <EmptyState size="sm" icon={FileText} title="No returns for this quarter" description="Payroll posted no taxes in it. If runs were paid before this desk existed, rebuild them from the Agencies tab." />
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {q.data!.checklist.map((c) => (
                <li key={`${c.kind}|${c.jurisdiction}|${c.periodLabel}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{`${c.label} · ${c.agency}`}</p>
                    <p className="text-xs text-ink-muted">{`${c.periodLabel} · ${dueText(c.dueDate)}`}</p>
                  </div>
                  <DueBadge due={c.dueDate} done={c.status === 'FILED' || c.status === 'ACCEPTED'} />
                  <ReturnBadge status={c.status} />
                  {c.returnId ? (
                    <Button size="sm" variant="outline" onClick={() => setOpenId(c.returnId)}>
                      Open
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => generate.mutate(c)} loading={generate.isPending && generate.variables === c} aria-label={`Prepare ${c.label} for ${c.agency}`}>
                      Prepare
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* The prepared returns. With none yet, the checklist above already says what to prepare: one empty state, not two. */}
      {(q.isLoading || q.isError || visible.length > 0) && (
        <DataGrid<TaxReturn>
          id="payroll-taxes-returns"
          caption="Prepared returns"
          noun={{ one: 'return', many: 'returns' }}
          rows={visible}
          loading={q.isLoading}
          error={q.isError ? (q.error as Error).message : null}
          onRetry={() => void q.refetch()}
          columns={columns}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpenId(r.id)}
          rowActionLabel={(r) => `Open ${r.label} for ${r.agency}`}
        />
      )}

      {openId && <ReturnDrawer id={openId} provider={provider} onClose={() => setOpenId(null)} onOpen={setOpenId} />}

      <p className="text-sm text-ink-muted">
        W-2s, 1099s and the 941 and 940 builders are on the{' '}
        <Link to="/payroll/year-end?tab=forms" className="text-accent underline underline-offset-2">
          Year-end page
        </Link>
        .
      </p>
    </div>
  );
}

function figure(k: string, v: number) {
  if (isCountFigure(k)) return v.toLocaleString();
  if (k === 'rate') return `${(v * 100).toFixed(2)}%`;
  return fmtMoney(v);
}

function ReturnDrawer({ id, provider, onClose, onOpen }: { id: string; provider: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const canExportSsn = user ? hasCapability(user.role, 'export:payroll-pii') : false;
  const q = useQuery({ queryKey: ['payroll-taxes', 'return', id], queryFn: () => getReturn(id) });
  const [filing, setFiling] = useState(false);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });
  const outcome = useMutation({
    mutationFn: (v: { outcome: 'ACCEPTED' | 'REJECTED'; reason?: string }) => recordReturnOutcome(id, v.outcome, v.reason),
    onSuccess: () => { toast.success('Recorded.'); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const amend = useMutation({
    mutationFn: () => amendTaxReturn(id),
    onSuccess: (r) => { toast.success('Amendment drafted with the corrected figures.'); invalidate(); onOpen(r.return.id); },
    onError: (e: Error) => toast.error(e.message),
  });
  const r = q.data?.return;
  const rows = r?.rows ?? [];
  const cols = rows[0] ? Object.keys(rows[0]).sort(byColumnOrder) : [];
  const sent = r && (r.status === 'FILED' || r.status === 'ACCEPTED' || r.status === 'SUBMITTED');

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{r ? `${r.label} · ${r.agency}` : 'Return'}</DrawerTitle>
        <DrawerDescription>{r ? `${quarterName(r.periodLabel)} · ${r.status === 'FILED' || r.status === 'ACCEPTED' || r.status === 'SUBMITTED' ? `was due ${fmtDate(r.dueDate)}` : dueText(r.dueDate, localToday())}` : ' '}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {q.isError ? (
          <QueryError what="this return" query={q} />
        ) : !r ? (
          <SkeletonRows count={6} />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <ReturnBadge status={r.status} />
              {r.confirmationNumber && <span className="text-sm text-ink-muted">{`Confirmation ${r.confirmationNumber}`}</span>}
              {r.filedAt && <span className="text-sm text-ink-muted">{`Filed ${fmtDateTime(r.filedAt)}`}</span>}
            </div>
            {r.rejectionReason && <p className="rounded-md border border-alert/30 bg-alert/5 p-3 text-sm text-alert">{`Rejected: ${r.rejectionReason}`}</p>}
            {r.notes.length > 0 && (
              <ul className="list-disc space-y-1 rounded-md border border-warning/30 bg-warning/5 p-3 pl-7 text-sm text-ink">
                {r.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <section aria-label="Figures">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Figure</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    {r.delta && <TableHead className="text-right">Change</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(r.totals)
                    .sort(byFigureOrder)
                    .filter(([k]) => k !== 'taxDue' || !!r.delta)
                    .map(([k, v]) => (
                      <TableRow key={k}>
                        <TableCell>{FIGURE_LABEL[k] ?? k}</TableCell>
                        <TableCell className="text-right tabular-nums">{figure(k, v)}</TableCell>
                        {r.delta && <TableCell className="text-right tabular-nums">{r.delta[k] ? figure(k, r.delta[k]!) : '—'}</TableCell>}
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </section>
            {rows.length > 0 && (
              <section aria-label="People on the return" className="space-y-2">
                <p className="text-sm text-ink-muted">{`${r.rowCount} ${r.rowCount === 1 ? 'person' : 'people'}${rows.length < r.rowCount ? `, first ${rows.length} shown` : ''}. Full SSNs appear only in the export.`}</p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {cols.map((c) => (
                          <TableHead key={c}>{FIGURE_LABEL[c] ?? c.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, 50).map((row, i) => (
                        <TableRow key={i}>
                          {cols.map((c) => (
                            <TableCell key={c} className={typeof row[c] === 'number' ? 'text-right tabular-nums' : undefined}>
                              {typeof row[c] === 'number' && /wage|withheld|tax/i.test(c) ? fmtMoney(row[c] as number) : String(row[c] ?? '—')}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}
            {(q.data?.amendments ?? []).length > 0 && (
              <section aria-label="Amendments" className="space-y-1">
                <p className="text-sm font-medium text-ink">Amendments</p>
                {q.data!.amendments.map((a) => (
                  <button key={a.id} type="button" className="flex w-full items-center justify-between rounded-md border border-navy-secondary px-3 py-2 text-left text-sm hover:bg-navy-secondary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold" onClick={() => onOpen(a.id)}>
                    <span>{`${a.label} · ${fmtDate(a.createdAt)}`}</span>
                    <ReturnBadge status={a.status} />
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </DrawerBody>
      {r && (
        <DrawerFooter className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadReturnCsv(r.id, false).catch((e: Error) => toast.error(e.message))}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden /> Download
          </Button>
          {canExportSsn && rows.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (await confirm({ title: 'Download with full SSNs?', description: 'The file carries every person’s full Social Security number. The download is recorded. Store it securely and delete it after you upload it to the agency.', confirmLabel: 'Download with SSNs' }))
                  downloadReturnCsv(r.id, true).catch((e: Error) => toast.error(e.message));
              }}
            >
              Download with SSNs
            </Button>
          )}
          {(r.status === 'DRAFT' || r.status === 'REJECTED') && <Button size="sm" onClick={() => setFiling(true)}>File</Button>}
          {(r.status === 'SUBMITTED' || r.status === 'FILED') && (
            <>
              <Button size="sm" variant="outline" onClick={() => outcome.mutate({ outcome: 'ACCEPTED' })} loading={outcome.isPending}>Agency accepted it</Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const reason = await prompt({ title: 'The agency rejected it', reasonLabel: 'What the agency said', confirmLabel: 'Record rejection', reasonMaxLength: 500 });
                  if (reason) outcome.mutate({ outcome: 'REJECTED', reason });
                }}
              >
                Agency rejected it
              </Button>
            </>
          )}
          {sent && !r.amendsId && (
            <Button size="sm" variant="ghost" onClick={() => amend.mutate()} loading={amend.isPending}>
              <FilePlus2 className="mr-1.5 h-4 w-4" aria-hidden /> Amend
            </Button>
          )}
        </DrawerFooter>
      )}
      {filing && r && <FileReturnDialog ret={r} provider={provider} onClose={() => setFiling(false)} onDone={invalidate} />}
    </Drawer>
  );
}

function FileReturnDialog({ ret, provider, onClose, onDone }: { ret: TaxReturn; provider: boolean; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<'PROVIDER' | 'MANUAL'>(provider ? 'PROVIDER' : 'MANUAL');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const file = useMutation({
    mutationFn: () => fileTaxReturn(ret.id, method, method === 'MANUAL' ? confirmation.trim() : undefined),
    onSuccess: (r) => {
      toast[r.return.status === 'REJECTED' ? 'error' : 'success'](r.return.status === 'REJECTED' ? (r.return.rejectionReason ?? 'The provider rejected it.') : method === 'PROVIDER' ? 'Sent to your provider to file.' : 'Recorded as filed.');
      onDone();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`File ${ret.label}`}</DialogTitle>
          <DialogDescription>{`${ret.agency} · ${ret.periodLabel} · ${dueText(ret.dueDate)}`}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (method === 'MANUAL' && confirmation.trim().length < 3) {
              setError('Enter the confirmation number the agency gave you.');
              return;
            }
            file.mutate();
          }}
        >
          {provider && (
            <Field label="How">
              {(p) => (
                <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'PROVIDER' | 'MANUAL')}>
                  <option value="PROVIDER">Send it to my payroll tax provider</option>
                  <option value="MANUAL">I filed it myself</option>
                </Select>
              )}
            </Field>
          )}
          {method === 'MANUAL' && (
            <Field label="Confirmation number" required hint="Download the return, file it on the agency’s site, then enter the number it gives you." error={error}>
              {(p) => <Input {...p} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} maxLength={80} autoComplete="off" />}
            </Field>
          )}
          {method === 'PROVIDER' && error && <p className="text-sm text-alert" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
            <Button type="submit" loading={file.isPending}>{method === 'PROVIDER' ? 'Send to file' : 'Record as filed'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
