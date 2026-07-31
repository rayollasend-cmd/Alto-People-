import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileCheck2, Plus, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import type {
  DrugTest,
  DrugTestDetail,
  DrugTestPendingResponse,
  DrugTestStatus,
} from '@alto-people/shared';
import {
  bulkInitiateDrugTests,
  getDrugTestDetail,
  initiateDrugTest,
  listDrugTests,
  listPendingDrugTests,
  updateDrugTest,
} from '@/lib/complianceApi';
import { uploadAdminDocument } from '@/lib/documentsApi';
import { DocumentThumbnails } from '@/components/DocumentViewer';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtDateTime } from '@/lib/format';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  Skeleton,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';

/**
 * Drug-test directorate — mirrors the Background checks tab. The structural
 * difference is recurrence: the Walmart SOW requires a result within 60
 * days, so the bulk-order roster is "no fresh result", not "never had a
 * row", and the dialog distinguishes never-tested from expired.
 */

const TRANSITION_OPTIONS: DrugTestStatus[] = [
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
  'FAILED',
];

function statusVariant(s: DrugTestStatus): 'default' | 'pending' | 'success' | 'destructive' | 'accent' {
  switch (s) {
    case 'PASSED':
      return 'success';
    case 'FAILED':
      return 'destructive';
    // In-flight work reads gold per the status contract.
    case 'IN_PROGRESS':
      return 'accent';
    case 'NEEDS_REVIEW':
      return 'pending';
    case 'INITIATED':
      return 'default';
  }
}

const STATUS_LABELS: Record<DrugTestStatus, string> = {
  INITIATED: 'Ordered',
  IN_PROGRESS: 'In progress',
  NEEDS_REVIEW: 'Needs review',
  PASSED: 'Passed',
  FAILED: 'Failed',
};

function transitionVariant(
  s: DrugTestStatus,
): 'primary' | 'outline' | 'destructive' {
  if (s === 'PASSED') return 'primary';
  if (s === 'FAILED') return 'destructive';
  return 'outline';
}

function isTerminal(s: DrugTestStatus): boolean {
  return s === 'PASSED' || s === 'FAILED';
}

function ageInDays(initiatedAt: string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(initiatedAt).getTime()) / 86_400_000),
  );
}

// Stuck-order tone: an open drug screen 7+ days is worth a look,
// 14+ days is a problem.
function ageTone(days: number): string {
  if (days >= 14) return 'text-alert';
  if (days >= 7) return 'text-warning';
  return 'text-silver';
}

export function DrugTestTab({ canManage }: { canManage: boolean }) {
  const [tests, setTests] = useState<DrugTest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInitiate, setShowInitiate] = useState(false);
  const [showBulkOrder, setShowBulkOrder] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<DrugTest | null>(null);
  // Results for the open drawer — fetched on open (each read is an audited
  // disclosure server-side), null while loading.
  const [detail, setDetail] = useState<DrugTestDetail | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listDrugTests();
      setTests(res.tests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await getDrugTestDetail(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the result list.');
    }
  }, []);

  const openDrawer = (t: DrugTest) => {
    setDrawerTarget(t);
    setDetail(null);
    void loadDetail(t.id);
  };

  const updateStatus = async (id: string, status: DrugTestStatus) => {
    setPendingId(id);
    try {
      await updateDrugTest(id, { status });
      const fresh = await listDrugTests();
      setTests(fresh.tests);
      setDrawerTarget((prev) =>
        prev ? fresh.tests.find((t) => t.id === prev.id) ?? null : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setPendingId(null);
    }
  };

  // Snapshot strip — same at-a-glance idiom as Background checks.
  const open = (tests ?? []).filter((t) => !isTerminal(t.status));
  const kpi = {
    inFlight: open.length,
    needsReview: (tests ?? []).filter((t) => t.status === 'NEEDS_REVIEW').length,
    stuck: open.filter((t) => ageInDays(t.initiatedAt) >= 7).length,
    passed: (tests ?? []).filter((t) => t.status === 'PASSED').length,
    failed: (tests ?? []).filter((t) => t.status === 'FAILED').length,
    // A finalized outcome with no lab result on file has no evidence.
    missingResult: (tests ?? []).filter(
      (t) => isTerminal(t.status) && (t.reportCount ?? 0) === 0,
    ).length,
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Drug tests</h2>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowBulkOrder(true)}>
              <Download className="h-4 w-4" />
              Bulk order CSV
            </Button>
            <Button onClick={() => setShowInitiate(true)} size="sm">
              <Plus className="h-4 w-4" />
              Order test
            </Button>
          </div>
        )}
      </div>

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {tests && tests.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-x-8 gap-y-3 rounded-lg border border-navy-secondary bg-navy/40 p-4">
          <Kpi label="In flight" value={kpi.inFlight} />
          <Kpi
            label="Needs review"
            value={kpi.needsReview}
            tone={kpi.needsReview > 0 ? 'text-warning' : undefined}
          />
          <Kpi
            label="Stuck 7d+"
            value={kpi.stuck}
            tone={kpi.stuck > 0 ? 'text-alert' : undefined}
          />
          <Kpi label="Passed" value={kpi.passed} tone="text-success" />
          <Kpi
            label="Failed"
            value={kpi.failed}
            tone={kpi.failed > 0 ? 'text-alert' : undefined}
          />
          <Kpi
            label="Finalized, no result"
            value={kpi.missingResult}
            tone={kpi.missingResult > 0 ? 'text-warning' : undefined}
          />
        </div>
      )}

      {!tests && <SkeletonRows count={4} rowHeight="h-12" />}
      {tests && tests.length === 0 && (
        <EmptyState
          icon={FlaskConical}
          title="No drug tests yet"
          description={
            canManage
              ? 'Order tests individually or download the bulk CSV for everyone whose result is missing or older than 60 days.'
              : 'Drug tests will appear here once they are ordered.'
          }
          action={
            canManage ? (
              <Button onClick={() => setShowInitiate(true)} size="sm">
                <Plus className="h-4 w-4" />
                Order test
              </Button>
            ) : undefined
          }
        />
      )}
      {tests && tests.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead className="hidden sm:table-cell">Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Result</TableHead>
              <TableHead className="hidden md:table-cell">Ordered</TableHead>
              <TableHead className="hidden lg:table-cell">Completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tests.map((t) => (
              <TableRow
                key={t.id}
                className="group cursor-pointer"
                onClick={(ev) => {
                  const target = ev.target as HTMLElement;
                  if (target.closest('button, a, input, [data-no-row-click]')) return;
                  if (window.getSelection()?.toString()) return;
                  openDrawer(t);
                }}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={t.associateName} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate">{t.associateName}</div>
                      {/* Phone-only secondary line replacing the hidden cells. */}
                      <div className="sm:hidden text-xs2 text-silver/70 truncate">
                        {t.provider}
                        {t.externalId ? ` · ${t.externalId}` : ''} · ordered{' '}
                        {fmtDate(t.initiatedAt)}
                        {!isTerminal(t.status) && (
                          <span className={ageTone(ageInDays(t.initiatedAt))}>
                            {' '}· {ageInDays(t.initiatedAt)}d
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-silver">
                  <div>{t.provider}</div>
                  {t.externalId && (
                    <div className="text-2xs font-mono text-silver/70 truncate max-w-[160px]">
                      {t.externalId}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(t.status)}>
                    {STATUS_LABELS[t.status]}
                  </Badge>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {(t.reportCount ?? 0) > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-success">
                      <FileCheck2 className="h-3.5 w-3.5" />
                      {t.reportCount === 1 ? 'On file' : `${t.reportCount} on file`}
                    </span>
                  ) : isTerminal(t.status) ? (
                    // Outcome recorded, evidence missing — the gap this
                    // column exists to surface.
                    <span className="text-xs text-warning">None</span>
                  ) : (
                    <span className="text-xs text-silver/40">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell text-silver tabular-nums">
                  {fmtDate(t.initiatedAt)}
                  {!isTerminal(t.status) && (
                    <span className={cn('ml-1.5', ageTone(ageInDays(t.initiatedAt)))}>
                      {ageInDays(t.initiatedAt)}d since ordered
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-silver tabular-nums">
                  {fmtDate(t.completedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <OrderTestDialog
        open={showInitiate}
        onOpenChange={setShowInitiate}
        onCreated={() => {
          setShowInitiate(false);
          refresh();
        }}
        onError={setError}
      />

      <BulkOrderDialog
        open={showBulkOrder}
        onOpenChange={setShowBulkOrder}
        onInitiated={() => {
          setShowBulkOrder(false);
          refresh();
        }}
      />

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-xl"
      >
        {drawerTarget && (
          <DrugTestDetailPanel
            test={drawerTarget}
            reports={detail ? detail.reports : null}
            canManage={canManage}
            pending={pendingId === drawerTarget.id}
            onTransition={(status) => updateStatus(drawerTarget.id, status)}
            onReportsChanged={() => {
              void loadDetail(drawerTarget.id);
              void refresh(); // result counts in the table + KPI strip
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function DrugTestDetailPanel({
  test,
  reports,
  canManage,
  pending,
  onTransition,
  onReportsChanged,
}: {
  test: DrugTest;
  /** null while the audited detail fetch is in flight. */
  reports: DrugTestDetail['reports'] | null;
  canManage: boolean;
  pending: boolean;
  onTransition: (status: DrugTestStatus) => void;
  onReportsChanged: () => void;
}) {
  const ageDays = ageInDays(test.initiatedAt);
  const finalized = isTerminal(test.status);
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar name={test.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{test.associateName}</DrawerTitle>
            <DrawerDescription>{test.provider}</DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex items-center gap-3 mb-5">
          <Badge variant={statusVariant(test.status)}>
            {STATUS_LABELS[test.status]}
          </Badge>
          {!finalized && (
            <span className={cn('text-xs tabular-nums', ageTone(ageDays))}>
              {ageDays}d open
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Ordered">
            {fmtDateTime(test.initiatedAt)}
          </DetailRow>
          <DetailRow label="Completed">
            {fmtDateTime(test.completedAt)}
          </DetailRow>
          <DetailRow label="Provider">{test.provider}</DetailRow>
          <DetailRow label="External ref">{test.externalId ?? '—'}</DetailRow>
        </dl>

        <div className="mt-6">
          <h3 className="mb-2 text-2xs uppercase tracking-widest text-silver/80">
            Lab result
          </h3>
          {reports === null ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ResultSection
              associateId={test.associateId}
              reports={reports}
              finalized={finalized}
              canManage={canManage}
              onUploaded={onReportsChanged}
            />
          )}
        </div>

        {finalized && (
          <p className="mt-5 text-xs text-silver">
            This test is finalized. Use a transition below if the result needs
            to be revised.
          </p>
        )}
      </DrawerBody>
      {canManage && (
        <DrawerFooter className="flex-wrap">
          {TRANSITION_OPTIONS.filter((s) => s !== test.status).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={transitionVariant(s)}
              onClick={() => onTransition(s)}
              disabled={pending}
              loading={pending}
            >
              {labelFor(s)}
            </Button>
          ))}
        </DrawerFooter>
      )}
    </>
  );
}

/**
 * The lab's result document. HR downloads it from the provider portal and
 * files it here so the evidence lives next to the recorded outcome. Stored
 * as DRUG_TEST_RESULT documents — the kind the compliance scorecard's
 * 60-day signal reads, so uploading here is also what turns that signal
 * green and resets the associate's 60-day clock.
 */
function ResultSection({
  associateId,
  reports,
  finalized,
  canManage,
  onUploaded,
}: {
  associateId: string;
  reports: DrugTestDetail['reports'];
  finalized: boolean;
  canManage: boolean;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setErr(null);
    const failures: string[] = [];
    let ok = 0;
    // Sequential, not Promise.all: each file is its own audited write, and a
    // partial failure should say which file rather than rejecting the batch.
    for (const file of Array.from(files)) {
      try {
        await uploadAdminDocument(file, 'DRUG_TEST_RESULT', associateId);
        ok += 1;
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (ok > 0) onUploaded();
    if (failures.length === 0) {
      toast.success(`Uploaded ${ok} file${ok === 1 ? '' : 's'}.`);
    } else {
      setErr(failures.join(' · '));
      if (ok > 0) toast.warning(`Uploaded ${ok}, ${failures.length} failed.`);
    }
  };

  return (
    <div>
      {err && <ErrorBanner className="mb-2">{err}</ErrorBanner>}

      {reports.length === 0 ? (
        <p className={cn('mb-2 text-xs', finalized ? 'text-warning' : 'text-silver')}>
          {finalized
            ? 'This test is finalized but no lab result is on file — upload it so the outcome has its evidence and the 60-day compliance clock resets.'
            : 'No result yet. When the lab completes the screen, download the result and file it here.'}
        </p>
      ) : (
        <div className="mb-3">
          <DocumentThumbnails
            documents={reports}
            bulkDownloadAssociateId={associateId}
            bulkDownloadKinds={['DRUG_TEST_RESULT']}
          />
        </div>
      )}

      {canManage && (
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.zip"
            onChange={(e) => void upload(e.target.files)}
            disabled={busy}
            aria-label="Upload drug test result files"
            className="block w-full text-xs text-silver file:mr-3 file:rounded file:border file:border-navy-secondary file:bg-navy-secondary/40 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:border-gold/60 disabled:opacity-50"
          />
          <p className="mt-1 text-2xs text-silver/60">
            PDF, image, or a .zip. Up to 10 MB per file — select several at
            once if the result arrived as multiple documents.
          </p>
          {busy && <p className="mt-1 text-2xs text-gold">Uploading…</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Bulk provider ordering. The roster is everyone whose newest result is
 * older than 60 days or absent — recurrence is the point, so "had a test
 * once" doesn't exempt anyone. Downloading marks NOTHING; the "mark
 * ordered" step is separate and gated behind the download.
 */
function BulkOrderDialog({
  open,
  onOpenChange,
  onInitiated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInitiated: () => void;
}) {
  const [pending, setPending] = useState<DrugTestPendingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Active + onboarding by default; inactive is opt-in — testing people who
  // don't work here is usually wasted spend.
  const [groups, setGroups] = useState({ ACTIVE: true, PENDING: true, INACTIVE: false });

  useEffect(() => {
    if (!open) return;
    setPending(null);
    setError(null);
    setDownloaded(false);
    setGroups({ ACTIVE: true, PENDING: true, INACTIVE: false });
    listPendingDrugTests()
      .then(setPending)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the pending list.'),
      );
  }, [open]);

  const all = pending?.rows ?? [];
  const countOf = (s: keyof typeof groups) => all.filter((r) => r.status === s).length;
  const rows = all.filter((r) => groups[r.status]);
  const expired = rows.filter((r) => r.lastResultAt !== null).length;

  const toggleGroup = (s: keyof typeof groups) => {
    setGroups((g) => ({ ...g, [s]: !g[s] }));
    // The CSV on disk no longer matches the selection — force a re-download
    // before "mark ordered" can fire.
    setDownloaded(false);
  };

  const download = () => {
    if (rows.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    // Header names exactly as the provider's template expects them.
    downloadCsv(`drug-test-bulk-order-${today}.csv`, [
      ['email', 'first name', 'phone number'],
      ...rows.map((r) => [r.email, r.firstName, r.phone ?? '']),
    ]);
    setDownloaded(true);
  };

  const markOrdered = async () => {
    if (rows.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await bulkInitiateDrugTests({
        associateIds: rows.map((r) => r.associateId),
        provider: 'checkr',
      });
      toast.success(
        res.skipped > 0
          ? `Marked ${res.created} ordered (${res.skipped} already had an open order).`
          : `Marked ${res.created} test${res.created === 1 ? '' : 's'} ordered.`,
      );
      onInitiated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark tests ordered.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk order drug tests</DialogTitle>
          <DialogDescription>
            Downloads everyone whose newest result is missing or older than 60
            days as a CSV ready for the provider&rsquo;s bulk-order upload.
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBanner className="mb-1">{error}</ErrorBanner>}

        {!pending && !error && <Skeleton className="h-16 w-full" />}

        {pending && all.length === 0 && (
          <p className="text-sm text-silver">
            Nobody is due — every associate has a result inside the 60-day
            window or an order already in flight.
          </p>
        )}

        {pending && all.length > 0 && (
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="sr-only">Employment groups to include</legend>
              {(
                [
                  { key: 'ACTIVE', label: 'Active', hint: 'currently working' },
                  { key: 'PENDING', label: 'Onboarding', hint: 'application in flight' },
                  { key: 'INACTIVE', label: 'Inactive', hint: 'ended, declined, or never applied' },
                ] as const
              ).map(({ key, label, hint }) => (
                <label
                  key={key}
                  className={cn(
                    'flex items-center gap-2.5 text-sm',
                    countOf(key) === 0 ? 'opacity-50' : 'cursor-pointer',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={groups[key]}
                    onChange={() => toggleGroup(key)}
                    disabled={countOf(key) === 0}
                    className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
                  />
                  <span className="text-white">{label}</span>
                  <span className="text-xs text-silver/70">{hint}</span>
                  <span className="ml-auto tabular-nums text-silver">{countOf(key)}</span>
                </label>
              ))}
            </fieldset>

            <p className="text-sm text-silver">
              <span className="font-semibold text-white tabular-nums">{rows.length}</span>{' '}
              associate{rows.length === 1 ? '' : 's'} selected
              {rows.length > 0 && (
                <span className="text-silver/70">
                  {' '}
                  — {rows.length - expired} never tested, {expired} expired
                </span>
              )}
              {pending.truncated && (
                <span className="text-warning">
                  {' '}
                  — list capped at 500; run again after this batch to catch the rest
                </span>
              )}
              .
            </p>
            {rows.length > 0 && (
              <p className="text-xs text-silver/70 truncate">
                {rows
                  .slice(0, 6)
                  .map((r) => `${r.lastName}, ${r.firstName}`)
                  .join(' · ')}
                {rows.length > 6 ? ` · +${rows.length - 6} more` : ''}
              </p>
            )}
            {downloaded && (
              <p className="text-xs text-gold">
                CSV downloaded. Once it&rsquo;s been uploaded to the provider,
                mark these tests as ordered so this queue reflects it.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {downloaded ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={downloaded ? 'secondary' : 'primary'}
            onClick={download}
            disabled={rows.length === 0}
          >
            <Download className="h-4 w-4" />
            {downloaded ? 'Download again' : 'Download CSV'}
          </Button>
          <Button
            type="button"
            onClick={() => void markOrdered()}
            loading={busy}
            disabled={!downloaded || rows.length === 0 || busy}
            title={
              downloaded
                ? 'Click after the CSV has been uploaded to the provider'
                : 'Download the CSV first'
            }
          >
            Mark {rows.length > 0 ? rows.length : ''} ordered
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function labelFor(s: DrugTestStatus): string {
  switch (s) {
    case 'IN_PROGRESS':
      return 'Mark in progress';
    case 'NEEDS_REVIEW':
      return 'Needs review';
    case 'PASSED':
      return 'Mark passed';
    case 'FAILED':
      return 'Mark failed';
    case 'INITIATED':
      return 'Reopen';
  }
}

// Same snapshot-stat idiom as the E-Verify directory strip.
function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
      <div className={cn('font-display text-xl tabular-nums', tone ?? 'text-white')}>
        {value}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 tabular-nums break-all">{children}</dd>
    </div>
  );
}

function OrderTestDialog({
  open,
  onOpenChange,
  onCreated,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [externalId, setExternalId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAssociate(null);
      setExternalId('');
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!associate || busy) return;
    setBusy(true);
    try {
      const ref = externalId.trim();
      await initiateDrugTest({
        associateId: associate.id,
        provider: 'checkr',
        ...(ref ? { externalId: ref } : {}),
      });
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Order failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Order drug test</DialogTitle>
          <DialogDescription>
            Records the order here; run it in the provider portal and upload
            the lab result when it comes back.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <label className="grid gap-1">
            <span className="text-xs2 uppercase tracking-wider text-silver">
              Associate
            </span>
            <AssociatePicker
              value={associate}
              onChange={setAssociate}
              placeholder="Search by name…"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs2 uppercase tracking-wider text-silver">
              Provider reference / external ID (optional)
            </span>
            <Input
              placeholder="e.g. Checkr screening id"
              maxLength={120}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={busy || !associate}
            >
              Order test
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
