import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileStack, RotateCcw, Upload } from 'lucide-react';
import { centsToMoney, downloadAchFile, listAchEntries, listAchFiles, uploadReturnFile, type AchEntryRow, type AchFileRow } from '@/lib/bankingApi';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { fmtDate, fmtDateTime } from '@/lib/format';

/** Every NACHA file sent, with download, and what banks sent back. */

const PURPOSE: Record<AchFileRow['purpose'], string> = {
  FUNDING: 'Funding debit',
  DIRECT_DEPOSIT: 'Paychecks',
  PRENOTE: 'Bank tests',
  MICRODEPOSIT: 'Account check',
  GARNISHMENT: 'Garnishment payments',
};
/** A purpose this screen doesn't know yet reads as a file, never a crash. */
const purposeLabel = (p: string) => PURPOSE[p as AchFileRow['purpose']] ?? 'ACH file';

const FILE_STATUS: Record<string, { label: string; tone: NonNullable<BadgeProps['variant']> }> = {
  CREATED: { label: 'Ready to upload', tone: 'pending' },
  DOWNLOADED: { label: 'Downloaded', tone: 'info' },
  SUBMITTED: { label: 'Sent', tone: 'info' },
  SETTLED: { label: 'Settled', tone: 'success' },
  REJECTED: { label: 'Refused', tone: 'destructive' },
};

/** What a return code means, in a few words. */
const RETURN_WORDS: Record<string, string> = {
  R01: 'Not enough money',
  R02: 'Account closed',
  R03: 'No such account',
  R04: 'Bad account number',
  R05: 'Debit not authorized',
  R07: 'Authorization revoked',
  R08: 'Payment stopped',
  R10: 'Not authorized',
  R16: 'Account frozen',
  R20: 'Not a transaction account',
  R29: 'Business didn’t authorize',
};

type View = 'files' | 'returns';

export function FilesTab({ inHouse }: { inHouse: boolean }) {
  const qc = useQueryClient();
  const [view, setView] = useState<View>('files');
  const files = useQuery({ queryKey: ['payroll-banking', 'files'], queryFn: listAchFiles, enabled: view === 'files' });
  const entries = useQuery({ queryKey: ['payroll-banking', 'entries'], queryFn: listAchEntries, enabled: view === 'returns' });
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => uploadReturnFile(await file.text()),
    onSuccess: (r) => {
      toast.success(`${r.returned} return${r.returned === 1 ? '' : 's'} and ${r.corrected} correction${r.corrected === 1 ? '' : 's'} applied${r.unknown ? `; ${r.unknown} didn’t match a file we sent` : ''}.`);
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
      setView('returns');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fileCols: GridColumn<AchFileRow>[] = [
    { key: 'created', header: 'Made', primary: true, accessor: (f) => f.createdAt, cell: (f) => <span className="font-medium text-ink">{fmtDateTime(f.createdAt)}</span>, sortable: true },
    { key: 'purpose', header: 'What', accessor: (f) => purposeLabel(f.purpose), cardMeta: true },
    {
      key: 'effective',
      header: 'Settles',
      accessor: (f) => f.effectiveDate,
      cell: (f) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {fmtDate(f.effectiveDate)}
          {f.sameDay && <Badge variant="accent" size="sm">Same day</Badge>}
        </span>
      ),
      sortable: true,
    },
    { key: 'entries', header: 'Entries', accessor: (f) => f.entryCount, align: 'right', className: 'tabular-nums' },
    { key: 'amount', header: 'Amount', accessor: (f) => f.totalCreditCents + f.totalDebitCents, cell: (f) => (f.totalDebitCents ? `${centsToMoney(f.totalDebitCents)} in` : f.totalCreditCents ? `${centsToMoney(f.totalCreditCents)} out` : 'No money moves'), align: 'right', className: 'tabular-nums', sortable: true },
    {
      key: 'status',
      header: 'Status',
      accessor: (f) => f.status,
      searchable: false,
      cell: (f) => {
        const s = FILE_STATUS[f.status] ?? { label: f.status, tone: 'default' as const };
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={s.tone}>{s.label}</Badge>
            {f.returns > 0 && <Badge variant="destructive">{`${f.returns} back`}</Badge>}
            {f.error && <span className="text-xs text-alert">{f.error}</span>}
          </span>
        );
      },
    },
    {
      key: 'download',
      header: 'File',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      cell: (f) => (
        <Button size="xs" variant="outline" onClick={() => downloadAchFile(f.id).then(() => void qc.invalidateQueries({ queryKey: ['payroll-banking', 'files'] })).catch((e: Error) => toast.error(e.message))} aria-label={`Download the ${purposeLabel(f.purpose).toLowerCase()} file made ${fmtDateTime(f.createdAt)}`}>
          <Download className="mr-1 h-3.5 w-3.5" aria-hidden /> Download
        </Button>
      ),
    },
  ];

  const entryCols: GridColumn<AchEntryRow>[] = [
    { key: 'name', header: 'Who', primary: true, accessor: (e) => e.name, cell: (e) => <span className="font-medium text-ink">{e.name}</span>, sortable: true },
    { key: 'what', header: 'What', accessor: (e) => (e.kind === 'DEBIT' ? 'Funding debit' : e.kind === 'PRENOTE' ? 'Bank test' : e.kind === 'MICRODEPOSIT' ? 'Account check' : 'Paycheck'), cardMeta: true },
    { key: 'account', header: 'Account', accessor: (e) => `····${e.accountLast4}` },
    { key: 'amount', header: 'Amount', accessor: (e) => e.amountCents, cell: (e) => centsToMoney(e.amountCents), align: 'right', className: 'tabular-nums' },
    {
      key: 'result',
      header: 'Came back as',
      accessor: (e) => e.returnCode ?? e.nocCode ?? '',
      cell: (e) =>
        e.status === 'RETURNED' ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="destructive">{e.returnCode ?? 'Returned'}</Badge>
            <span className="text-sm text-ink">{e.returnCode ? (RETURN_WORDS[e.returnCode] ?? 'Returned') : 'Refused'}</span>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="info">{e.nocCode ?? 'Change'}</Badge>
            <span className="text-sm text-ink">{e.nocAppliedAt ? 'Account details corrected' : 'Correction not applied'}</span>
          </span>
        ),
    },
    { key: 'when', header: 'When', accessor: (e) => e.returnedAt ?? e.nocAppliedAt ?? e.effectiveDate, cell: (e) => fmtDate(e.returnedAt ?? e.nocAppliedAt ?? e.effectiveDate), sortable: true },
    { key: 'trace', header: 'Trace', accessor: (e) => e.traceNumber, cell: (e) => <span className="font-mono text-xs">{e.traceNumber}</span>, defaultHidden: true },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl<View>
          ariaLabel="ACH files view"
          value={view}
          onChange={setView}
          options={[
            { value: 'files', label: 'Files' },
            { value: 'returns', label: 'Returns and corrections' },
          ]}
        />
        {inHouse && (
          <>
            <input
              ref={input}
              type="file"
              accept=".txt,.ach,.nacha,text/plain"
              className="sr-only"
              aria-label="Return file from your bank"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
            <Button size="sm" variant="outline" onClick={() => input.current?.click()} loading={upload.isPending}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden /> Upload return file
            </Button>
          </>
        )}
      </div>
      {view === 'files' ? (
        <DataGrid<AchFileRow>
          id="payroll-banking-files"
          caption="ACH files"
          noun={{ one: 'file', many: 'files' }}
          rows={files.data?.files}
          loading={files.isLoading}
          error={files.isError ? (files.error as Error).message : null}
          onRetry={() => void files.refetch()}
          columns={fileCols}
          rowKey={(f) => f.id}
          defaultSort={{ key: 'created', direction: 'desc' }}
          empty={{ icon: FileStack, title: 'No files yet', description: 'A file is made when funding is pulled, pay goes out, or an account is tested.' }}
        />
      ) : (
        <DataGrid<AchEntryRow>
          id="payroll-banking-returns"
          caption="Returns and corrections"
          noun={{ one: 'entry', many: 'entries' }}
          rows={entries.data?.entries}
          loading={entries.isLoading}
          error={entries.isError ? (entries.error as Error).message : null}
          onRetry={() => void entries.refetch()}
          columns={entryCols}
          rowKey={(e) => e.id}
          defaultSort={{ key: 'when', direction: 'desc' }}
          empty={{ icon: RotateCcw, title: 'Nothing has come back', description: 'Returned entries and banks’ account corrections appear here.' }}
        />
      )}
    </div>
  );
}
