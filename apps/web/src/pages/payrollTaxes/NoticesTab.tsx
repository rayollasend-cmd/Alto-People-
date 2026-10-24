import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Inbox, Paperclip, Plus } from '@/components/ui/icons';
import {
  createNotice,
  getNotice,
  listNotices,
  listTaxAccounts,
  listTaxAssignees,
  noticeFileUrl,
  updateNotice,
  type NoticeDetail,
  type NoticeInput,
  type NoticeListItem,
  type NoticeStatus,
} from '@/lib/payrollTaxesApi';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { DueBadge, NoticeBadge, localToday } from './taxShared';

/** Letters from tax agencies: log, assign, respond with the ledger's evidence, resolve. */

type Filter = 'ACTIVE' | 'RESOLVED' | 'ALL';
const NOTICE_TYPES = ['Balance due', 'Late deposit penalty', 'Late filing penalty', 'Missing return', 'Rate notice', 'Account change', 'Wage report mismatch', 'Other'];

export function NoticesTab() {
  const [filter, setFilter] = useState<Filter>('ACTIVE');
  const [openId, setOpenId] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);
  const q = useQuery({ queryKey: ['payroll-taxes', 'notices', filter], queryFn: () => listNotices(filter === 'ALL' ? undefined : filter) });
  const d = q.data?.dashboard;
  const today = localToday();
  const columns: GridColumn<NoticeListItem>[] = [
    { key: 'agency', header: 'Agency', primary: true, accessor: (n) => n.agencyName, cell: (n) => <span className="font-medium text-ink">{n.agencyName}</span>, sortable: true },
    { key: 'type', header: 'Notice', accessor: (n) => `${n.noticeType}${n.noticeNumber ? ` ${n.noticeNumber}` : ''}`, cardMeta: true },
    { key: 'date', header: 'Dated', accessor: (n) => n.noticeDate, cell: (n) => fmtDate(n.noticeDate), sortable: true },
    { key: 'respond', header: 'Respond by', accessor: (n) => n.responseDueAt ?? '', cell: (n) => (n.responseDueAt ? <span className="flex flex-wrap items-center gap-2">{fmtDate(n.responseDueAt)}<DueBadge due={n.responseDueAt} today={today} done={n.status === 'RESPONDED' || n.status === 'RESOLVED'} /></span> : <span className="text-ink-muted">—</span>), sortable: true },
    { key: 'amount', header: 'Amount', accessor: (n) => n.amountDue ?? 0, cell: (n) => (n.amountDue === null ? <span className="text-ink-muted">—</span> : fmtMoney(n.amountDue)), align: 'right', className: 'tabular-nums' },
    { key: 'status', header: 'Status', accessor: (n) => n.status, cell: (n) => <NoticeBadge status={n.status} />, searchable: false },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Open" value={String(d?.open ?? 0)} hint="Not resolved yet" />
        <MetricCard label="Responses late" value={String(d?.overdueResponses ?? 0)} hint="Past the agency’s deadline" accent={(d?.overdueResponses ?? 0) > 0} />
        <MetricCard label="In question" value={fmtMoney(d?.amountInDispute ?? 0)} hint="Across open notices" />
        <MetricCard label="Penalties abated" value={fmtMoney(d?.abated ?? 0)} hint={`Of ${fmtMoney(d?.penalties ?? 0)} assessed`} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<Filter>
          ariaLabel="Which notices"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'ACTIVE', label: 'Open' },
            { value: 'RESOLVED', label: 'Resolved' },
            { value: 'ALL', label: 'All' },
          ]}
        />
        <Button size="sm" onClick={() => setLogging(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Log a notice
        </Button>
      </div>
      <DataGrid<NoticeListItem>
        id="payroll-taxes-notices"
        caption="Agency notices"
        noun={{ one: 'notice', many: 'notices' }}
        rows={q.data?.notices}
        loading={q.isLoading}
        error={q.isError ? (q.error as Error).message : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(n) => n.id}
        onRowClick={(n) => setOpenId(n.id)}
        rowActionLabel={(n) => `Open the ${n.agencyName} notice`}
        empty={{ icon: Inbox, title: filter === 'RESOLVED' ? 'No resolved notices' : 'No open notices', description: 'When an agency writes, log the letter here to track its deadline and your response.' }}
      />
      {logging && <LogNoticeDialog onClose={() => setLogging(false)} onCreated={(id) => setOpenId(id)} />}
      {openId && <NoticeDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function LogNoticeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['payroll-taxes', 'accounts'], queryFn: listTaxAccounts });
  const [f, setF] = useState<NoticeInput>({ agencyName: '', noticeType: NOTICE_TYPES[0]!, noticeDate: localToday() });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof NoticeInput, v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => createNotice(f, file),
    onSuccess: (r) => {
      toast.success('Notice logged.');
      void qc.invalidateQueries({ queryKey: ['payroll-taxes'] });
      onClose();
      onCreated(r.notice.id);
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log a notice</DialogTitle>
          <DialogDescription>Attach the letter and note its deadline. You can assign it and respond from the notice.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (f.agencyName.trim().length < 2) {
              setError('Name the agency that sent it.');
              return;
            }
            save.mutate();
          }}
        >
          <Field label="Agency account" className="sm:col-span-2" hint="Pick the account it’s about, or type the agency below.">
            {(p) => (
              <Select
                {...p}
                value={f.accountId ?? ''}
                onChange={(e) => {
                  const a = accounts.data?.accounts.find((x) => x.id === e.target.value);
                  setF((x) => ({ ...x, accountId: e.target.value || undefined, ...(a ? { agencyName: a.agencyName, jurisdiction: a.jurisdiction } : {}) }));
                }}
              >
                <option value="">Not linked to an account</option>
                {(accounts.data?.accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{`${a.agencyName}${a.accountNumber ? ` · ${a.accountNumber}` : ''}`}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Agency" required className="sm:col-span-2" error={error}>
            {(p) => <Input {...p} value={f.agencyName} onChange={(e) => set('agencyName', e.target.value)} maxLength={160} placeholder="Internal Revenue Service" />}
          </Field>
          <Field label="Kind of notice" required>
            {(p) => (
              <Select {...p} value={f.noticeType} onChange={(e) => set('noticeType', e.target.value)}>
                {NOTICE_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Notice number" hint="For example CP136 or the letter ID.">
            {(p) => <Input {...p} value={f.noticeNumber ?? ''} onChange={(e) => set('noticeNumber', e.target.value)} maxLength={60} />}
          </Field>
          <Field label="Dated" required>
            {(p) => <Input {...p} type="date" value={f.noticeDate} max={localToday()} onChange={(e) => set('noticeDate', e.target.value)} />}
          </Field>
          <Field label="Respond by" hint="The deadline on the letter.">
            {(p) => <Input {...p} type="date" value={f.responseDueAt ?? ''} onChange={(e) => set('responseDueAt', e.target.value)} />}
          </Field>
          <Field label="Tax period" hint="Like 2026-Q2, or a year.">
            {(p) => <Input {...p} value={f.periodLabel ?? ''} onChange={(e) => set('periodLabel', e.target.value.toUpperCase())} maxLength={7} placeholder="2026-Q2" />}
          </Field>
          <Field label="Amount the agency says is due">
            {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="0.01" value={f.amountDue ?? ''} onChange={(e) => set('amountDue', e.target.value)} />}
          </Field>
          <Field label="What it says" className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={f.summary ?? ''} onChange={(e) => set('summary', e.target.value)} />}
          </Field>
          <Field label="The letter" className="sm:col-span-2" hint="A PDF or a photo.">
            {(p) => <Input {...p} type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>Not now</Button>
            <Button type="submit" loading={save.isPending}>Log notice</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const NEXT_STEP: Record<NoticeStatus, { to: NoticeStatus; label: string } | null> = {
  NEW: { to: 'IN_REVIEW', label: 'Start review' },
  IN_REVIEW: { to: 'RESPONDED', label: 'Mark responded' },
  RESPONDED: { to: 'RESOLVED', label: 'Mark resolved' },
  RESOLVED: null,
};

function NoticeDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-taxes', 'notice', id], queryFn: () => getNotice(id) });
  const assignees = useQuery({ queryKey: ['payroll-taxes', 'assignees'], queryFn: listTaxAssignees });
  const n = q.data?.notice;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>{n ? `${n.agencyName} · ${n.noticeType}` : 'Notice'}</DrawerTitle>
        <DrawerDescription>{n ? `Dated ${fmtDate(n.noticeDate)}${n.noticeNumber ? ` · ${n.noticeNumber}` : ''}${n.periodLabel ? ` · for ${n.periodLabel}` : ''}` : ' '}</DrawerDescription>
      </DrawerHeader>
      {q.isError ? (
        <DrawerBody>
          <QueryError what="this notice" query={q} />
        </DrawerBody>
      ) : !n ? (
        <DrawerBody>
          <SkeletonRows count={6} />
        </DrawerBody>
      ) : (
        <NoticeEditor key={n.id + n.status} notice={n} assignees={assignees.data?.assignees ?? []} onSaved={() => void qc.invalidateQueries({ queryKey: ['payroll-taxes'] })} />
      )}
    </Drawer>
  );
}

function NoticeEditor({ notice: n, assignees, onSaved }: { notice: NoticeDetail; assignees: Array<{ id: string; name: string }>; onSaved: () => void }) {
  const [response, setResponse] = useState(n.response ?? '');
  const [resolution, setResolution] = useState(n.resolution ?? '');
  const [penalty, setPenalty] = useState(n.penaltyAmount === null ? '' : String(n.penaltyAmount));
  const [abated, setAbated] = useState(n.abatedAmount === null ? '' : String(n.abatedAmount));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = useMutation({
    mutationFn: (extra: { status?: NoticeStatus; assignedToId?: string | null }) =>
      updateNotice(n.id, {
        ...extra,
        response: response.trim() || null,
        resolution: resolution.trim() || null,
        penaltyAmount: num(penalty),
        abatedAmount: num(abated),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      toast.success('Saved.');
      setNote('');
      setError(null);
      onSaved();
    },
    onError: (e: Error) => setError(e.message),
  });
  const step = NEXT_STEP[n.status];
  return (
    <>
      <DrawerBody>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <NoticeBadge status={n.status} />
            {n.responseDueAt && <span className="text-sm text-ink-muted">{`Respond by ${fmtDate(n.responseDueAt)}`}</span>}
            <DueBadge due={n.responseDueAt} done={n.status === 'RESPONDED' || n.status === 'RESOLVED'} />
            {n.amountDue !== null && <span className="text-sm text-ink-muted">{`${fmtMoney(n.amountDue)} in question`}</span>}
          </div>
          {n.summary && <p className="text-sm text-ink">{n.summary}</p>}
          {n.hasFile ? (
            <a href={noticeFileUrl(n.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-gold underline-offset-2 hover:underline">
              <Paperclip className="h-4 w-4" aria-hidden /> {n.fileName ?? 'The letter'}
            </a>
          ) : (
            <p className="text-sm text-ink-muted">No letter attached.</p>
          )}

          <Field label="Assigned to">
            {(p) => (
              <Select {...p} value={n.assignedToId ?? ''} onChange={(e) => save.mutate({ assignedToId: e.target.value || null })} disabled={save.isPending}>
                <option value="">Nobody yet</option>
                {assignees.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
            )}
          </Field>

          {n.evidence && (
            <section aria-label="What the ledger shows" className="rounded-md border border-navy-secondary p-3">
              <p className="text-sm font-medium text-ink">What payroll’s records show</p>
              <p className="mt-1 text-sm text-ink-muted">{`Posted for ${n.periodLabel}: ${fmtMoney(n.evidence.liabilities)} · paid: ${fmtMoney(n.evidence.paid)}`}</p>
              {n.evidence.payments.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {n.evidence.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2">
                      <span>{`${fmtMoney(p.amount)} paid ${fmtDate(p.paidAt)}${p.late ? ' (late)' : ''}`}</span>
                      <span className="text-ink-muted">{p.confirmationNumber ?? 'No confirmation'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-muted">No payment to this agency is recorded for the period.</p>
              )}
            </section>
          )}

          <Field label="Your response" hint="What you sent the agency, with the confirmation numbers above as proof.">
            {(p) => <Textarea {...p} rows={4} maxLength={4000} value={response} onChange={(e) => setResponse(e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Penalty assessed">
              {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="0.01" value={penalty} onChange={(e) => setPenalty(e.target.value)} />}
            </Field>
            <Field label="Penalty abated" hint="What the agency removed.">
              {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="0.01" value={abated} onChange={(e) => setAbated(e.target.value)} />}
            </Field>
          </div>
          <Field label="How it was resolved">
            {(p) => <Textarea {...p} rows={2} maxLength={2000} value={resolution} onChange={(e) => setResolution(e.target.value)} />}
          </Field>
          <Field label="Add a note to the timeline">
            {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {error && <p className="text-sm text-alert" role="alert">{error}</p>}

          <section aria-label="Timeline">
            <p className="mb-2 text-sm font-medium text-ink">Timeline</p>
            {n.events.length === 0 ? (
              <EmptyState size="sm" icon={FileText} title="No history" />
            ) : (
              <ol className="space-y-2 border-l border-navy-secondary pl-4">
                {[...n.events].reverse().map((e, i) => (
                  <li key={`${e.at}-${i}`} className="text-sm">
                    <p className="text-ink">{e.what}</p>
                    <p className="text-xs text-ink-muted">{`${fmtDateTime(e.at)}${e.byName ? ` · ${e.byName}` : ''}`}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </DrawerBody>
      <DrawerFooter className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => save.mutate({})} loading={save.isPending && !save.variables?.status}>
          Save
        </Button>
        {step && (
          <Button onClick={() => save.mutate({ status: step.to })} loading={save.isPending && save.variables?.status === step.to}>
            {step.label}
          </Button>
        )}
        {n.status === 'RESOLVED' && (
          <Button variant="ghost" onClick={() => save.mutate({ status: 'IN_REVIEW' })}>
            Reopen
          </Button>
        )}
      </DrawerFooter>
    </>
  );
}
