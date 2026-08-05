import { useRef, useState } from 'react';
import { CheckCircle2, Download, FileUp, Upload, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type {
  CsvImportCommitResponse,
  CsvImportMode,
  CsvImportPreviewResponse,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { commitCsvImport, previewCsvImport } from '@/lib/onboardingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { cn } from '@/lib/cn';

// Downloadable header template — header row + one example row, so admins
// can start from a file whose columns are guaranteed to match.
const TEMPLATE_CSV =
  'firstName,lastName,email,phone,hireDate,clientName,position\r\n' +
  'Alice,Hart,alice@example.com,555-0100,2026-08-01,Acme Grocery,Cashier\r\n';
const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

/** Rows rendered in the preview / results tables before collapsing into a
 *  "+N more" note — 2000 table rows in a dialog helps no one. */
const MAX_RENDERED_ROWS = 200;

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after commit created/invited at least one row so the parent refetches. */
  onImported: () => void;
}

/**
 * Bulk associate CSV import — the client-onboarding / migration path.
 * File pick → server-side dry-run preview (nothing written) → mode choice →
 * commit → per-row results. Commit is safely re-runnable: rows whose email
 * already exists are skipped, never duplicated.
 */
export function CsvImportDialog({ open, onOpenChange, onImported }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvImportPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [mode, setMode] = useState<CsvImportMode>('create');
  const [committing, setCommitting] = useState(false);
  const [results, setResults] = useState<CsvImportCommitResponse | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setPreviewing(false);
    setMode('create');
    setCommitting(false);
    setResults(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const pickFile = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setResults(null);
    if (!f) return;
    setPreviewing(true);
    try {
      setPreview(await previewCsvImport(f));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not read that file.';
      toast.error('Preview failed.', { description: msg });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setPreviewing(false);
    }
  };

  const commit = async () => {
    if (!file) return;
    setCommitting(true);
    try {
      const res = await commitCsvImport(file, mode);
      setResults(res);
      const done = res.summary.created + res.summary.invited;
      if (done > 0) onImported();
      if (res.summary.skipped === 0) {
        toast.success(
          mode === 'invite'
            ? `Invited ${res.summary.invited} associate${res.summary.invited === 1 ? '' : 's'}.`
            : `Created ${res.summary.created} associate${res.summary.created === 1 ? '' : 's'}.`,
        );
      } else if (done === 0) {
        toast.error(`All ${res.summary.skipped} rows were skipped.`, {
          description: 'Check the per-row reasons below.',
        });
      } else {
        toast.message(`Imported ${done}, skipped ${res.summary.skipped}.`, {
          description: 'Skipped rows are listed with their reasons below.',
        });
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Import failed.';
      toast.error('Could not import.', { description: msg });
    } finally {
      setCommitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import associates from CSV</DialogTitle>
          <DialogDescription>
            Upload a .csv with columns firstName, lastName, email (required), plus
            optional phone, hireDate (YYYY-MM-DD), clientName or clientId, and
            position. Up to 2000 rows. Nothing is written until you commit, and
            re-running the same file is safe — existing emails are skipped, not
            duplicated.
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <CommitResultsPanel results={results} />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="secondary"
                loading={previewing}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-4 w-4" />
                {file ? 'Choose a different file' : 'Choose CSV file'}
              </Button>
              {file && (
                <span className="text-sm text-silver font-mono truncate max-w-[16rem]">
                  {file.name}
                </span>
              )}
              <a
                href={TEMPLATE_HREF}
                download="associate-import-template.csv"
                className="ml-auto inline-flex items-center gap-1 text-sm text-silver/70 hover:text-silver underline underline-offset-2"
              >
                <Download className="h-3.5 w-3.5" />
                Download header template
              </a>
            </div>

            {preview && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <SummaryChip label={`${preview.summary.total} rows`} />
                  <SummaryChip
                    tone="success"
                    label={`${preview.summary.valid} valid`}
                    icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                  />
                  {preview.summary.invalid > 0 && (
                    <SummaryChip
                      tone="alert"
                      label={`${preview.summary.invalid} invalid`}
                      icon={<XIcon className="h-3.5 w-3.5" />}
                    />
                  )}
                  {preview.summary.duplicateEmails > 0 && (
                    <SummaryChip
                      tone="alert"
                      label={`${preview.summary.duplicateEmails} duplicate email${preview.summary.duplicateEmails === 1 ? '' : 's'}`}
                    />
                  )}
                </div>

                <div className="rounded-md border border-navy-secondary max-h-72 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-14">Line</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Client</TableHead>
                        <TableHead>Hire date</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.rows.slice(0, MAX_RENDERED_ROWS).map((r) => (
                        <TableRow
                          key={r.line}
                          className={cn(r.errors.length > 0 && 'bg-alert/[0.06]')}
                        >
                          <TableCell className="font-mono text-xs">{r.line}</TableCell>
                          <TableCell className="text-sm">
                            {r.data.firstName} {r.data.lastName}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.data.email}</TableCell>
                          <TableCell className="text-sm">
                            {r.data.clientName ?? (r.data.clientId ? 'by id' : '—')}
                          </TableCell>
                          <TableCell className="text-sm">{r.data.hireDate ?? '—'}</TableCell>
                          <TableCell className="text-xs">
                            {r.errors.length === 0 ? (
                              <span className="text-success inline-flex items-center gap-1">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Ready
                              </span>
                            ) : (
                              <span className="text-alert">{r.errors.join('; ')}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {preview.rows.length > MAX_RENDERED_ROWS && (
                    <div className="p-2 text-xs text-silver/70">
                      + {preview.rows.length - MAX_RENDERED_ROWS} more rows not shown
                    </div>
                  )}
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-silver">Import mode</legend>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="csv-import-mode"
                      className="mt-1"
                      checked={mode === 'create'}
                      onChange={() => setMode('create')}
                    />
                    <span>
                      <span className="font-medium">Create silently</span>
                      <span className="block text-xs text-silver/70">
                        Adds associates and their applications only. No user accounts,
                        no emails — for migrating an existing client&rsquo;s roster.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="csv-import-mode"
                      className="mt-1"
                      checked={mode === 'invite'}
                      onChange={() => setMode('invite')}
                    />
                    <span>
                      <span className="font-medium">Create + send invites</span>
                      <span className="block text-xs text-silver/70">
                        Also creates invited user accounts and emails each person the
                        standard onboarding invitation.
                      </span>
                    </span>
                  </label>
                </fieldset>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={commit}
                loading={committing}
                disabled={!file || !preview || preview.summary.valid === 0 || previewing}
              >
                <Upload className="h-4 w-4" />
                {preview
                  ? `Import ${preview.summary.valid} row${preview.summary.valid === 1 ? '' : 's'}`
                  : 'Import'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryChip({
  label,
  tone,
  icon,
}: {
  label: string;
  tone?: 'success' | 'alert';
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        tone === 'success' && 'border-success/40 text-success',
        tone === 'alert' && 'border-alert/40 text-alert',
        !tone && 'border-navy-secondary text-silver',
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function CommitResultsPanel({ results }: { results: CsvImportCommitResponse }) {
  const { summary } = results;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <SummaryChip label={`${summary.total} rows`} />
        {summary.created > 0 && (
          <SummaryChip
            tone="success"
            label={`${summary.created} created`}
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          />
        )}
        {summary.invited > 0 && (
          <SummaryChip
            tone="success"
            label={`${summary.invited} invited`}
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          />
        )}
        {summary.skipped > 0 && (
          <SummaryChip
            tone="alert"
            label={`${summary.skipped} skipped`}
            icon={<XIcon className="h-3.5 w-3.5" />}
          />
        )}
      </div>
      <div className="rounded-md border border-navy-secondary divide-y divide-navy-secondary max-h-72 overflow-auto">
        {results.results.slice(0, MAX_RENDERED_ROWS).map((r) => (
          <div
            key={r.line}
            className={cn(
              'p-2 text-xs flex items-start gap-2',
              r.status === 'skipped' ? 'bg-alert/[0.06]' : 'bg-success/[0.04]',
            )}
          >
            {r.status === 'skipped' ? (
              <XIcon className="h-3.5 w-3.5 text-alert mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-mono text-silver truncate">
                line {r.line}
                {r.email ? ` · ${r.email}` : ''}
              </div>
              <div className={cn('mt-0.5', r.status === 'skipped' ? 'text-alert' : 'text-success')}>
                {r.status}
                {r.reason ? `: ${r.reason}` : ''}
              </div>
            </div>
          </div>
        ))}
        {results.results.length > MAX_RENDERED_ROWS && (
          <div className="p-2 text-xs text-silver/70">
            + {results.results.length - MAX_RENDERED_ROWS} more rows not shown
          </div>
        )}
      </div>
      <p className="text-xs text-silver/70">
        Re-running the same file is safe: rows that already exist are reported as
        skipped instead of being duplicated.
      </p>
    </div>
  );
}
