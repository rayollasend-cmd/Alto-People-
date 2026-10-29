import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileSearch, MailWarning, ShieldCheck, Upload, UserRoundCheck } from '@/components/ui/icons';
import {
  checkTin,
  createTinBatch,
  downloadBNoticeLetter,
  downloadSignedW9,
  downloadTinRequest,
  listBNotices,
  listContractors,
  listTinBatches,
  loadTinResults,
  logBNotice,
  markBNoticeSent,
  requestW9,
  resolveBNotice,
  setBackup,
  getYearEnd,
  type BNoticeRow,
  type ContractorRow,
  type TinBatch,
} from '@/lib/certifiedPayrollApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtDateTime, fmtMoneyWhole, ymdLocal } from '@/lib/format';
import { PaymentRunsTab, StateFilingTab } from './ContractorPayments';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useUrlParam } from '@/lib/useUrlState';

/**
 * Contractors (1099) — the W-9 each one signs, whether the IRS agrees
 * with their name and TIN, the B-notices a mismatch requires and the 24%
 * backup withholding that follows an unanswered one, contractor payment
 * runs and how each state gets its 1099s. The year-end 1099 summary lives
 * on the Year-end page's Forms tab (F500 G3: one home for year-end); the
 * old ?tab=year-end link redirects there.
 */

type Tab = 'contractors' | 'notices' | 'tin' | 'payments' | 'states';
const TABS: Tab[] = ['contractors', 'notices', 'tin', 'payments', 'states'];

/** The 1099 year being worked: last year until April (they're filed by Jan 31; corrections follow), then this one. */
export const contractorTaxYear = (now: Date = new Date()) => now.getFullYear() - (now.getMonth() < 3 ? 1 : 0);

export function ContractorsDesk() {
  const [tab, setTab] = useUrlParam<Tab>('tab', 'contractors', TABS, { history: 'push' });
  return (
    <ListTemplate
      title="Contractors"
      subtitle="People paid on a 1099: their W-9s, whether the IRS accepts their name and tax ID, and what they’re paid."
      related={[
        { label: '1099 forms', to: '/payroll/year-end?tab=forms' },
        { label: 'Payroll taxes', to: '/payroll/taxes' },
      ]}
      summary={tab === 'contractors' ? <ContractorNumbers /> : null}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="contractors">Contractors</TabsTrigger>
            <TabsTrigger value="notices">B-notices</TabsTrigger>
            <TabsTrigger value="tin">TIN matching</TabsTrigger>
            <TabsTrigger value="payments">Payment runs</TabsTrigger>
            <TabsTrigger value="states">State filing</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="contractors">
          <ContractorsTab />
        </TabsContent>
        <TabsContent value="notices">
          <NoticesTab />
        </TabsContent>
        <TabsContent value="tin">
          <TinTab />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentRunsTab />
        </TabsContent>
        <TabsContent value="states">
          <StateFilingTab />
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/* ----- The numbers on the main tab ------------------------------------------------- */

type Show = 'all' | 'missing-w9' | 'mismatch';
const SHOWS: readonly Show[] = ['all', 'missing-w9', 'mismatch'];
const missingW9 = (c: ContractorRow) => c.w9Status !== 'SIGNED';
const tinMismatch = (c: ContractorRow) => c.tinMatchStatus === 'MISMATCH' || c.tinMatchStatus === 'INVALID';

/**
 * What finance asks about contractors first: who has no signed W-9, whose
 * name and TIN the IRS doesn't match, what was paid this year and how many
 * 1099s are owed — counted from the contractor list and the 1099 summary
 * already on this desk. Each tile filters the list or opens the page behind it.
 */
function ContractorNumbers() {
  const year = new Date().getFullYear();
  const filingYear = contractorTaxYear();
  const list = useQuery({ queryKey: ['contractors', 'list'], queryFn: () => listContractors() });
  const paid = useQuery({ queryKey: ['contractors', 'year-end', year], queryFn: () => getYearEnd(year) });
  const owed = useQuery({ queryKey: ['contractors', 'year-end', filingYear], queryFn: () => getYearEnd(filingYear), enabled: filingYear !== year });
  const owedData = filingYear === year ? paid.data : owed.data;
  const [show, setShow] = useUrlParam<Show>('show', 'all', SHOWS);
  const rows = list.data?.contractors ?? null;
  if (!rows || rows.length === 0) return null;
  const noW9 = rows.filter(missingW9).length;
  const mismatched = rows.filter(tinMismatch).length;
  const paidThisYear = paid.data ? paid.data.rows.reduce((a, r) => a + r.necBox1 + r.miscTotal, 0) : null;
  const formsOwed = owedData ? owedData.totals.necForms + owedData.totals.miscForms : null;
  return (
    <MetricStrip label="Contractors at a glance">
      <MetricCard label="Missing a W-9" value={noW9} nothing={noW9 === 0 ? 'Every W-9 signed' : undefined} tone={noW9 > 0 ? 'warning' : 'default'} onClick={() => setShow(show === 'missing-w9' ? 'all' : 'missing-w9')} selected={show === 'missing-w9'} />
      <MetricCard label="IRS TIN mismatches" value={mismatched} nothing={mismatched === 0 ? 'No mismatches' : undefined} tone={mismatched > 0 ? 'alert' : 'default'} onClick={() => setShow(show === 'mismatch' ? 'all' : 'mismatch')} selected={show === 'mismatch'} />
      <MetricCard label={`Paid in ${year}`} value={paidThisYear === null ? '—' : fmtMoneyWhole(paidThisYear)} nothing={paidThisYear === 0 ? `Nothing paid in ${year}` : undefined} href="/payroll/contractors?tab=payments" />
      <MetricCard label={`1099s owed for ${filingYear}`} value={formsOwed === null ? '—' : formsOwed} nothing={formsOwed === 0 ? 'None owed' : undefined} hint={formsOwed ? 'Filed by January 31' : undefined} href="/payroll/year-end?tab=forms" />
    </MetricStrip>
  );
}

/* ----- Badges --------------------------------------------------------------------- */

function W9Badge({ c }: { c: ContractorRow }) {
  if (c.w9Status === 'SIGNED') return <Badge variant="success">W-9 signed</Badge>;
  if (c.w9Status === 'REQUESTED') return <Badge variant="pending">W-9 requested</Badge>;
  return <Badge variant="default">No W-9</Badge>;
}

function TinBadge({ status, label }: { status: ContractorRow['tinMatchStatus']; label?: string | null }) {
  const v = status === 'MATCHED' ? 'success' : status === 'MISMATCH' || status === 'INVALID' ? 'destructive' : status === 'PENDING' ? 'pending' : 'default';
  const text = { MATCHED: 'IRS match', MISMATCH: 'IRS mismatch', INVALID: 'TIN invalid', PENDING: 'Check pending', NOT_CHECKED: 'Not checked' }[status];
  return (
    <Badge variant={v} title={label ?? undefined}>
      {text}
    </Badge>
  );
}

const BACKUP_REASON: Record<string, string> = {
  NO_TIN: 'no TIN on file',
  NOT_CERTIFIED: 'W-9 not certified',
  B_NOTICE: 'B-notice unanswered',
  IRS_NOTIFIED: 'IRS told them',
};

/* ----- Contractors ----------------------------------------------------------------- */

function ContractorsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contractors', 'list'], queryFn: () => listContractors() });
  const [show, setShow] = useUrlParam<Show>('show', 'all', SHOWS);
  const shown = q.data ? q.data.contractors.filter((c) => (show === 'missing-w9' ? missingW9(c) : show === 'mismatch' ? tinMismatch(c) : true)) : null;
  const [noticeFor, setNoticeFor] = useState<ContractorRow | null>(null);
  const [backupFor, setBackupFor] = useState<ContractorRow | null>(null);
  const done = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: ['contractors'] });
  };
  const ask = useMutation({ mutationFn: (c: ContractorRow) => requestW9(c.associateId), onSuccess: () => done('W-9 request sent'), onError: (e: Error) => toast.error(e.message) });
  const check = useMutation({
    mutationFn: (c: ContractorRow) => checkTin(c.associateId),
    onSuccess: (r) => done(r.status === 'MATCHED' ? 'The IRS matched the name and TIN' : `IRS: ${r.label ?? r.status}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const columns: GridColumn<ContractorRow>[] = [
    {
      key: 'name',
      header: 'Contractor',
      primary: true,
      accessor: (c) => c.name,
      cell: (c) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{c.name}</p>
          <p className="truncate text-xs text-ink-muted">{`${c.employmentType === 'CONTRACTOR_1099_BUSINESS' ? 'Business' : 'Individual'}${c.tinLast4 ? ` · TIN ending ${c.tinLast4}` : ' · no TIN'}`}</p>
        </div>
      ),
    },
    { key: 'w9', header: 'W-9', accessor: (c) => c.w9Status, cell: (c) => <W9Badge c={c} />, cardMeta: true },
    { key: 'tin', header: 'IRS check', accessor: (c) => c.tinMatchStatus, cell: (c) => <TinBadge status={c.tinMatchStatus} label={c.tinMatchLabel} /> },
    {
      key: 'backup',
      header: 'Backup withholding',
      accessor: (c) => (c.backupWithholding ? 1 : 0),
      cell: (c) => (c.backupWithholding ? <Badge variant="destructive">{`24% · ${BACKUP_REASON[c.backupReason ?? ''] ?? 'on'}`}</Badge> : <span className="text-sm text-ink-muted">None</span>),
    },
    {
      key: 'notices',
      header: 'B-notice',
      accessor: (c) => c.openBNotices.length,
      cell: (c) => (c.openBNotices[0] ? <Badge variant="pending">{`${c.openBNotices[0].kind === 'FIRST' ? 'First' : 'Second'} · backup by ${fmtDate(c.openBNotices[0].backupBy)}`}</Badge> : null),
    },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (c) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`Actions for ${c.name}`}>
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => ask.mutate(c)}>{c.w9Status === 'SIGNED' ? 'Ask for a new W-9' : 'Request W-9'}</DropdownMenuItem>
            {c.w9Status === 'SIGNED' ? <DropdownMenuItem onSelect={() => void downloadSignedW9(c.associateId).catch((e: Error) => toast.error(e.message))}>Download signed W-9</DropdownMenuItem> : null}
            {c.hasTin ? <DropdownMenuItem onSelect={() => check.mutate(c)}>Check name and TIN with the IRS</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => setNoticeFor(c)}>Log an IRS mismatch notice</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBackupFor(c)}>{c.backupWithholding ? 'Stop backup withholding' : 'Start backup withholding'}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      {q.data?.truncated ? <p className="mb-2 text-sm text-warning">Showing the first 1,000 contractors. Search to narrow the list.</p> : null}
      <DataGrid
        id="contractors-list"
        caption="Contractors"
        noun={{ one: 'contractor', many: 'contractors' }}
        rows={shown}
        columns={columns}
        rowKey={(c) => c.associateId}
        loading={q.isLoading}
        error={q.isError ? 'The contractors could not be loaded.' : null}
        onRetry={() => void q.refetch()}
        search={{ placeholder: 'Search contractors' }}
        filters={
          <SegmentedControl<Show>
            ariaLabel="Show"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'Everyone' },
              { value: 'missing-w9', label: 'Missing a W-9' },
              { value: 'mismatch', label: 'IRS mismatch' },
            ]}
          />
        }
        activeFilters={show === 'all' ? 0 : 1}
        onClearFilters={() => setShow('all')}
        empty={{ icon: UserRoundCheck, title: 'No contractors', description: 'People hired as 1099 contractors appear here, with their W\u20119 and IRS status.' }}
      />
      <LogNoticeDialog c={noticeFor} onClose={() => setNoticeFor(null)} />
      <BackupDialog c={backupFor} onClose={() => setBackupFor(null)} />
    </>
  );
}

function LogNoticeDialog({ c, onClose }: { c: ContractorRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ irsNoticeKind: 'CP2100' as 'CP2100' | 'CP2100A' | '972CG', irsNoticeReceivedOn: ymdLocal(), tinLast4OnNotice: '' });
  const save = useMutation({
    mutationFn: () => logBNotice(c!.associateId, { ...f, tinLast4OnNotice: f.tinLast4OnNotice || null }),
    onSuccess: (r) => {
      toast.success(`${r.kind === 'FIRST' ? 'First' : 'Second'} B-notice due by ${fmtDate(r.sendBy)}`);
      void qc.invalidateQueries({ queryKey: ['contractors'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log an IRS mismatch notice</DialogTitle>
          <DialogDescription>{c ? `For ${c.name}. The B-notice goes out within 15 business days; backup withholding starts by the 30th unless they answer.` : ''}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="IRS notice">
            <Select value={f.irsNoticeKind} onChange={(e) => setF({ ...f, irsNoticeKind: e.target.value as typeof f.irsNoticeKind })}>
              <option value="CP2100">CP2100</option>
              <option value="CP2100A">CP2100A</option>
              <option value="972CG">Letter 972CG</option>
            </Select>
          </Field>
          <Field label="Date you received it" required>
            <Input type="date" value={f.irsNoticeReceivedOn} onChange={(e) => setF({ ...f, irsNoticeReceivedOn: e.target.value })} />
          </Field>
          <Field label="TIN on the notice, last four" hint="Optional">
            <Input inputMode="numeric" maxLength={4} value={f.tinLast4OnNotice} onChange={(e) => setF({ ...f, tinLast4OnNotice: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              Log notice
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BackupDialog({ c, onClose }: { c: ContractorRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const starting = c ? !c.backupWithholding : true;
  const save = useMutation({
    mutationFn: () => setBackup(c!.associateId, { action: starting ? 'start' : 'stop', reason: starting ? 'IRS_NOTIFIED' : undefined, note: note.trim() }),
    onSuccess: () => {
      toast.success(starting ? 'Backup withholding started' : 'Backup withholding stopped');
      void qc.invalidateQueries({ queryKey: ['contractors'] });
      setNote('');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{starting ? 'Start backup withholding' : 'Stop backup withholding'}</DialogTitle>
          <DialogDescription>
            {starting
              ? 'Withholds 24% of every payment to this contractor, reported in 1099 box 4. Use this when the IRS tells you to by letter.'
              : 'Only stop once they gave a correct, certified TIN. An open B-notice must be resolved instead.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 3) save.mutate();
          }}
        >
          <Field label="Why" required hint="Kept on the record">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={starting ? 'destructive' : 'primary'} disabled={note.trim().length < 3} loading={save.isPending}>
              {starting ? 'Start withholding' : 'Stop withholding'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ----- B-notices ------------------------------------------------------------------- */

function NoticesTab() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const q = useQuery({ queryKey: ['contractors', 'notices', show], queryFn: () => listBNotices(show) });
  // Today is the user's own day, not UTC's (CODE-14): in the evening UTC already reads tomorrow.
  const today = ymdLocal();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['contractors'] });
  const sent = useMutation({ mutationFn: (n: BNoticeRow) => markBNoticeSent(n.id), onSuccess: () => (toast.success('Marked sent'), refresh()), onError: (e: Error) => toast.error(e.message) });
  const resolve = useMutation({
    mutationFn: ({ n, r }: { n: BNoticeRow; r: 'W9_RECEIVED' | 'SSA_VALIDATION' | 'IRS_147C' }) => resolveBNotice(n.id, r),
    onSuccess: () => (toast.success('Notice resolved'), refresh()),
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: GridColumn<BNoticeRow>[] = [
    {
      key: 'name',
      header: 'Contractor',
      primary: true,
      accessor: (n) => n.name,
      cell: (n) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{n.name}</p>
          <p className="truncate text-xs text-ink-muted">{`${n.kind === 'FIRST' ? 'First' : 'Second'} B-notice · ${n.irsNoticeKind} received ${fmtDate(n.irsNoticeReceivedOn)}`}</p>
        </div>
      ),
    },
    {
      key: 'send',
      header: 'Send by',
      accessor: (n) => n.sendBy,
      cardMeta: true,
      cell: (n) => (n.sentAt ? <Badge variant="success">{`Sent ${fmtDate(n.sentAt)}`}</Badge> : <Badge variant={n.sendBy < today ? 'destructive' : 'pending'}>{`Send by ${fmtDate(n.sendBy)}`}</Badge>),
    },
    {
      key: 'backup',
      header: 'Backup withholding',
      accessor: (n) => n.backupBy,
      cell: (n) =>
        n.resolution === 'BACKUP_STARTED' ? <Badge variant="destructive">Started</Badge> : n.resolution ? <Badge variant="success">{`Resolved ${n.respondedAt ? fmtDate(n.respondedAt) : ''}`}</Badge> : <span className="text-sm text-ink-muted">{`Starts ${fmtDate(n.backupBy)} if unanswered`}</span>,
    },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (n) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`Actions for ${n.name}'s notice`}>
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void downloadBNoticeLetter(n.id).catch((e: Error) => toast.error(e.message))}>Download the letter</DropdownMenuItem>
            {!n.sentAt ? <DropdownMenuItem onSelect={() => sent.mutate(n)}>Mark sent</DropdownMenuItem> : null}
            {(!n.resolution || n.resolution === 'BACKUP_STARTED') && n.kind === 'FIRST' ? (
              <DropdownMenuItem onSelect={async () => (await confirm({ title: 'A corrected W-9 arrived?', description: 'This answers the notice and stops backup withholding it started.', confirmLabel: 'Resolve' })) && resolve.mutate({ n, r: 'W9_RECEIVED' })}>
                Resolve: new W-9 received
              </DropdownMenuItem>
            ) : null}
            {!n.resolution || n.resolution === 'BACKUP_STARTED' ? (
              <>
                <DropdownMenuItem onSelect={() => resolve.mutate({ n, r: 'SSA_VALIDATION' })}>Resolve: SSA validation received</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => resolve.mutate({ n, r: 'IRS_147C' })}>Resolve: IRS Letter 147C received</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">A second notice within three years needs SSA or IRS validation, not just a new W-9.</p>
        <Select className="w-auto" aria-label="Which notices" value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')}>
          <option value="open">Open</option>
          <option value="all">All</option>
        </Select>
      </div>
      <DataGrid
        id="contractors-b-notices"
        caption="B-notices"
        noun={{ one: 'notice', many: 'notices' }}
        rows={q.data?.notices ?? null}
        columns={columns}
        rowKey={(n) => n.id}
        loading={q.isLoading}
        error={q.isError ? 'The notices could not be loaded.' : null}
        onRetry={() => void q.refetch()}
        search={false}
        urlState={false}
        empty={{ icon: MailWarning, title: show === 'open' ? 'No open B-notices' : 'No B-notices', description: 'When the IRS sends a CP2100 or 972CG, log it from the contractor’s row to start the clock.' }}
      />
    </div>
  );
}

/* ----- TIN matching ------------------------------------------------------------------ */

function TinTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contractors', 'tin-batches'], queryFn: listTinBatches });
  const [loading, setLoading] = useState<TinBatch | null>(null);
  const create = useMutation({
    mutationFn: createTinBatch,
    onSuccess: (r) => {
      toast.success(`Request file ready for ${r.requestedCount} contractor${r.requestedCount === 1 ? '' : 's'}`);
      void qc.invalidateQueries({ queryKey: ['contractors'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: GridColumn<TinBatch>[] = [
    { key: 'at', header: 'Created', primary: true, accessor: (b) => b.createdAt, cell: (b) => <span className="font-medium text-ink">{fmtDateTime(b.createdAt)}</span> },
    { key: 'kind', header: 'Kind', accessor: (b) => b.kind, cell: (b) => (b.kind === 'BULK' ? 'IRS bulk file' : 'One at a time'), cardMeta: true },
    { key: 'count', header: 'Contractors', accessor: (b) => b.requestedCount, align: 'right', className: 'tabular-nums' },
    {
      key: 'result',
      header: 'Results',
      accessor: (b) => b.status,
      cell: (b) =>
        b.status === 'RESULTS_LOADED' && b.summary ? (
          <span className="flex flex-wrap gap-1">
            {Number(b.summary.MATCHED ?? 0) > 0 ? <Badge variant="success">{`${b.summary.MATCHED} matched`}</Badge> : null}
            {Number(b.summary.MISMATCH ?? 0) > 0 ? <Badge variant="destructive">{`${b.summary.MISMATCH} mismatched`}</Badge> : null}
            {Number(b.summary.INVALID ?? 0) > 0 ? <Badge variant="destructive">{`${b.summary.INVALID} invalid`}</Badge> : null}
          </span>
        ) : (
          <Badge variant="pending">Waiting for IRS results</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (b) =>
        b.kind === 'BULK' ? (
          <span className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => void downloadTinRequest(b.id).catch((e: Error) => toast.error(e.message))} aria-label="Download the request file">
              <Download className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLoading(b)}>
              <Upload className="mr-1 h-4 w-4" aria-hidden />
              Results
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Check names and TINs with the IRS</CardTitle>
          <CardDescription>
            Make a request file for every contractor not yet matched, upload it to IRS e-Services TIN Matching, then load the results file the IRS returns. A connected tax-filing provider can check one contractor at a time from the Contractors tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => create.mutate()} loading={create.isPending}>
            <FileSearch className="mr-1.5 h-4 w-4" aria-hidden />
            Make a request file
          </Button>
        </CardContent>
      </Card>
      <DataGrid
        id="contractors-tin-batches"
        caption="TIN matching requests"
        noun={{ one: 'request', many: 'requests' }}
        rows={q.data?.batches ?? null}
        columns={columns}
        rowKey={(b) => b.id}
        loading={q.isLoading}
        error={q.isError ? 'The requests could not be loaded.' : null}
        onRetry={() => void q.refetch()}
        search={false}
        urlState={false}
        empty={{ icon: ShieldCheck, title: 'No TIN checks yet', description: 'Check new contractors before their first payment to avoid B-notices later.' }}
      />
      <ResultsDialog batch={loading} onClose={() => setLoading(null)} />
    </div>
  );
}

function ResultsDialog({ batch, onClose }: { batch: TinBatch | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const save = useMutation({
    mutationFn: () => loadTinResults(batch!.id, text),
    onSuccess: (r) => {
      toast.success(`${r.summary.MATCHED ?? 0} matched, ${(r.summary.MISMATCH ?? 0) + (r.summary.INVALID ?? 0)} to follow up`);
      void qc.invalidateQueries({ queryKey: ['contractors'] });
      setText('');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={!!batch} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Load IRS results</DialogTitle>
          <DialogDescription>Choose the results file the IRS returned, or paste its contents.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) save.mutate();
          }}
        >
          <Field label="Results file">
            <Input type="file" accept=".txt,text/plain" onChange={async (e) => setText((await e.target.files?.[0]?.text()) ?? '')} />
          </Field>
          <Field label="Or paste it">
            <Textarea rows={5} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim()} loading={save.isPending}>
              Load results
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
