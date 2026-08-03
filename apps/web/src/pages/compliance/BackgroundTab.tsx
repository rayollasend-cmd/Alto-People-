import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, FileCheck2, FileSearch, Plus, ShieldCheck } from 'lucide-react';
import { DirectorateHeader, Kpi, KpiStrip, TableShell } from './DirectorateShell';
import { toast } from 'sonner';
import type {
  BackgroundCheck,
  BackgroundCheckDetail,
  BackgroundPendingResponse,
  BgCheckStatus,
} from '@alto-people/shared';
import {
  bulkInitiateBackgroundChecks,
  getBackgroundCheckDetail,
  initiateBackgroundCheck,
  listBackgroundChecks,
  listPendingBackgroundChecks,
  updateBackgroundCheck,
} from '@/lib/complianceApi';
import { downloadCsv } from '@/lib/csv';
import { uploadAdminDocument } from '@/lib/documentsApi';
import { DocumentThumbnails } from '@/components/DocumentViewer';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
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
  Field,
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

const TRANSITION_OPTIONS: BgCheckStatus[] = [
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
  'FAILED',
];

function statusVariant(s: BgCheckStatus): 'default' | 'pending' | 'success' | 'destructive' | 'accent' {
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

const STATUS_LABELS: Record<BgCheckStatus, string> = {
  INITIATED: 'Initiated',
  IN_PROGRESS: 'In progress',
  NEEDS_REVIEW: 'Needs review',
  PASSED: 'Passed',
  FAILED: 'Failed',
};

function transitionVariant(
  s: BgCheckStatus,
): 'primary' | 'outline' | 'destructive' {
  if (s === 'PASSED') return 'primary';
  if (s === 'FAILED') return 'destructive';
  return 'outline';
}

function isTerminal(s: BgCheckStatus): boolean {
  return s === 'PASSED' || s === 'FAILED';
}

function ageInDays(initiatedAt: string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(initiatedAt).getTime()) / 86_400_000),
  );
}

// Stuck-check tone: a background check open 7+ days is worth a look,
// 14+ days is a problem.
function ageTone(days: number): string {
  if (days >= 14) return 'text-alert';
  if (days >= 7) return 'text-warning';
  return 'text-silver';
}

export function BackgroundTab({ canManage }: { canManage: boolean }) {
  const [checks, setChecks] = useState<BackgroundCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInitiate, setShowInitiate] = useState(false);
  const [showBulkOrder, setShowBulkOrder] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<BackgroundCheck | null>(null);
  // Reports for the open drawer — fetched on open (each read is an audited
  // FCRA disclosure server-side), null while loading.
  const [detail, setDetail] = useState<BackgroundCheckDetail | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listBackgroundChecks();
      setChecks(res.checks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await getBackgroundCheckDetail(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the report list.');
    }
  }, []);

  const openDrawer = (c: BackgroundCheck) => {
    setDrawerTarget(c);
    setDetail(null);
    void loadDetail(c.id);
  };

  const updateStatus = async (id: string, status: BgCheckStatus) => {
    setPendingId(id);
    try {
      await updateBackgroundCheck(id, { status });
      const fresh = await listBackgroundChecks();
      setChecks(fresh.checks);
      setDrawerTarget((prev) =>
        prev ? fresh.checks.find((c) => c.id === prev.id) ?? null : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setPendingId(null);
    }
  };

  // Snapshot strip — same at-a-glance idiom as the E-Verify directory.
  const open = (checks ?? []).filter((c) => !isTerminal(c.status));
  const kpi = {
    inFlight: open.length,
    needsReview: (checks ?? []).filter((c) => c.status === 'NEEDS_REVIEW').length,
    stuck: open.filter((c) => ageInDays(c.initiatedAt) >= 7).length,
    passed: (checks ?? []).filter((c) => c.status === 'PASSED').length,
    failed: (checks ?? []).filter((c) => c.status === 'FAILED').length,
    // A finalized decision with no report on file has no evidence behind it.
    missingReport: (checks ?? []).filter(
      (c) => isTerminal(c.status) && (c.reportCount ?? 0) === 0,
    ).length,
  };

  return (
    <section>
      <DirectorateHeader
        icon={FileSearch}
        title="Background checks"
        blurb="FCRA screening ledger — order, track, and file each provider report next to its decision"
        actions={
          canManage && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setShowBulkOrder(true)}>
                <Download className="h-4 w-4" />
                Bulk order CSV
              </Button>
              <Button onClick={() => setShowInitiate(true)} size="sm">
                <Plus className="h-4 w-4" />
                Initiate check
              </Button>
            </>
          )
        }
      />

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

      {checks && checks.length > 0 && (
        <KpiStrip>
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
            label="Finalized, no report"
            value={kpi.missingReport}
            tone={kpi.missingReport > 0 ? 'text-warning' : undefined}
          />
        </KpiStrip>
      )}

      {!checks && <SkeletonRows count={4} rowHeight="h-12" />}
      {checks && checks.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="No background checks yet"
          description={
            canManage
              ? 'New hires should run through onboarding, which initiates a check automatically. Manual initiation is here for back-fills.'
              : 'Background checks will appear here once they are initiated.'
          }
          action={
            canManage ? (
              <Button onClick={() => setShowInitiate(true)} size="sm">
                <Plus className="h-4 w-4" />
                Initiate check
              </Button>
            ) : undefined
          }
        />
      )}
      {checks && checks.length > 0 && (
        <TableShell>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead className="hidden sm:table-cell">Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Report</TableHead>
              <TableHead className="hidden md:table-cell">Initiated</TableHead>
              <TableHead className="hidden lg:table-cell">Completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((c) => (
              <TableRow
                key={c.id}
                className="group cursor-pointer"
                onClick={(ev) => {
                  const target = ev.target as HTMLElement;
                  if (target.closest('button, a, input, [data-no-row-click]')) return;
                  if (window.getSelection()?.toString()) return;
                  openDrawer(c);
                }}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={c.associateName} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate">{c.associateName}</div>
                      {/* Phone-only secondary line replacing the hidden cells. */}
                      <div className="sm:hidden text-xs2 text-silver/70 truncate">
                        {c.provider}
                        {c.externalId ? ` · ${c.externalId}` : ''} · initiated{' '}
                        {fmtDate(c.initiatedAt)}
                        {!isTerminal(c.status) && (
                          <span className={ageTone(ageInDays(c.initiatedAt))}>
                            {' '}· {ageInDays(c.initiatedAt)}d
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-silver">
                  <div>{c.provider}</div>
                  {c.externalId && (
                    <div className="text-2xs font-mono text-silver/70 truncate max-w-[160px]">
                      {c.externalId}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(c.status)}>
                    {STATUS_LABELS[c.status]}
                  </Badge>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {(c.reportCount ?? 0) > 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs text-success">
                      <FileCheck2 className="h-3.5 w-3.5" />
                      {c.reportCount === 1 ? 'On file' : `${c.reportCount} on file`}
                    </span>
                  ) : isTerminal(c.status) ? (
                    // Decision recorded, evidence missing — the gap this
                    // column exists to surface.
                    <span className="text-xs text-warning">None</span>
                  ) : (
                    <span className="text-xs text-silver/40">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell text-silver tabular-nums">
                  {fmtDate(c.initiatedAt)}
                  {!isTerminal(c.status) && (
                    <span className={cn('ml-1.5', ageTone(ageInDays(c.initiatedAt)))}>
                      {ageInDays(c.initiatedAt)}d since initiated
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-silver tabular-nums">
                  {fmtDate(c.completedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </TableShell>
      )}

      <InitiateCheckDialog
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
          <BackgroundCheckDetailPanel
            check={drawerTarget}
            reports={detail ? detail.reports : null}
            canManage={canManage}
            pending={pendingId === drawerTarget.id}
            onTransition={(status) => updateStatus(drawerTarget.id, status)}
            onReportsChanged={() => {
              void loadDetail(drawerTarget.id);
              void refresh(); // report counts in the table + KPI strip
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function BackgroundCheckDetailPanel({
  check,
  reports,
  canManage,
  pending,
  onTransition,
  onReportsChanged,
}: {
  check: BackgroundCheck;
  /** null while the audited detail fetch is in flight. */
  reports: BackgroundCheckDetail['reports'] | null;
  canManage: boolean;
  pending: boolean;
  onTransition: (status: BgCheckStatus) => void;
  onReportsChanged: () => void;
}) {
  const ageDays = ageInDays(check.initiatedAt);
  const finalized = isTerminal(check.status);
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar name={check.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{check.associateName}</DrawerTitle>
            <DrawerDescription>{check.provider}</DrawerDescription>
          </div>
          <Link
            to={`/people?associateId=${check.associateId}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
          >
            View profile
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex items-center gap-3 mb-5">
          <Badge variant={statusVariant(check.status)}>
            {STATUS_LABELS[check.status]}
          </Badge>
          {!finalized && (
            <span className={cn('text-xs tabular-nums', ageTone(ageDays))}>
              {ageDays}d open
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Initiated">
            {fmtDateTime(check.initiatedAt)}
          </DetailRow>
          <DetailRow label="Completed">
            {fmtDateTime(check.completedAt)}
          </DetailRow>
          <DetailRow label="Provider">{check.provider}</DetailRow>
          <DetailRow label="External ref">{check.externalId ?? '—'}</DetailRow>
        </dl>

        <div className="mt-6">
          <h3 className="mb-2 text-2xs uppercase tracking-widest text-silver/80">
            Provider report
          </h3>
          {reports === null ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ReportSection
              associateId={check.associateId}
              reports={reports}
              finalized={finalized}
              canManage={canManage}
              onUploaded={onReportsChanged}
            />
          )}
        </div>

        {finalized && (
          <p className="mt-5 text-xs text-silver">
            This check is finalized. Use a transition below if the result needs
            to be revised.
          </p>
        )}
      </DrawerBody>
      {canManage && (
        <DrawerFooter className="flex-wrap">
          {TRANSITION_OPTIONS.filter((s) => s !== check.status).map((s) => (
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
 * The report the provider hands back when the screen completes.
 *
 * HR downloads it from the Checkr/Sterling portal and files it here, against
 * the associate, so the evidence lives next to the recorded decision instead
 * of in someone's Downloads folder — the same treatment E-Verify closure
 * packets get. Stored as BACKGROUND_CHECK_RESULT documents (the kind that
 * was always meant for this), which also feeds the compliance scorecard's
 * background signal and the profile's Documents tab.
 */
function ReportSection({
  associateId,
  reports,
  finalized,
  canManage,
  onUploaded,
}: {
  associateId: string;
  reports: BackgroundCheckDetail['reports'];
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
        await uploadAdminDocument(file, 'BACKGROUND_CHECK_RESULT', associateId);
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
            ? 'This check is finalized but no report is on file — upload the provider report so the decision has its evidence.'
            : 'No report yet. When the provider completes the screen, download the report and file it here.'}
        </p>
      ) : (
        <div className="mb-3">
          <DocumentThumbnails
            documents={reports}
            bulkDownloadAssociateId={associateId}
            bulkDownloadKinds={['BACKGROUND_CHECK_RESULT']}
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
            aria-label="Upload background report files"
            className="block w-full text-xs text-silver file:mr-3 file:rounded file:border file:border-navy-secondary file:bg-navy-secondary/40 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:border-gold/60 disabled:opacity-50"
          />
          <p className="mt-1 text-2xs text-silver/60">
            PDF, image, or a .zip of the whole report folder. Up to 10 MB per
            file — select several at once if it arrived as multiple documents.
          </p>
          {busy && <p className="mt-1 text-2xs text-gold">Uploading…</p>}
        </div>
      )}
    </div>
  );
}

function labelFor(s: BgCheckStatus): string {
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

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 tabular-nums break-all">{children}</dd>
    </div>
  );
}

/**
 * Bulk Checkr ordering. Downloads the never-screened roster as the
 * provider's bulk-invitation CSV (email / first name / phone number — the
 * provider collects DOB/SSN from the candidate, so no heavy PII leaves).
 *
 * Downloading marks NOTHING — a file on disk isn't an order, and the
 * provider might reject it. The "Mark as initiated" step is separate,
 * enabled only after a download, and worded to be clicked after the
 * upload to the provider actually succeeded.
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
  const [pending, setPending] = useState<BackgroundPendingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which employment groups go in the order. Active + onboarding by default;
  // inactive (ended, declined, or never applied) is opt-in — screening
  // people who don't work here is usually wasted spend.
  const [groups, setGroups] = useState({ ACTIVE: true, PENDING: true, INACTIVE: false });

  useEffect(() => {
    if (!open) return;
    setPending(null);
    setError(null);
    setDownloaded(false);
    setGroups({ ACTIVE: true, PENDING: true, INACTIVE: false });
    listPendingBackgroundChecks()
      .then(setPending)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the pending list.'),
      );
  }, [open]);

  const all = pending?.rows ?? [];
  const countOf = (s: keyof typeof groups) => all.filter((r) => r.status === s).length;
  const rows = all.filter((r) => groups[r.status]);

  const toggleGroup = (s: keyof typeof groups) => {
    setGroups((g) => ({ ...g, [s]: !g[s] }));
    // The CSV on disk no longer matches the selection — force a re-download
    // before "mark initiated" can fire.
    setDownloaded(false);
  };

  const download = () => {
    if (rows.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    // Header names exactly as the provider's template expects them.
    downloadCsv(`background-bulk-order-${today}.csv`, [
      ['email', 'first name', 'phone number'],
      ...rows.map((r) => [r.email, r.firstName, r.phone ?? '']),
    ]);
    setDownloaded(true);
  };

  const markInitiated = async () => {
    if (rows.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await bulkInitiateBackgroundChecks({
        associateIds: rows.map((r) => r.associateId),
        provider: 'checkr',
      });
      toast.success(
        res.skipped > 0
          ? `Marked ${res.created} initiated (${res.skipped} already had a check).`
          : `Marked ${res.created} check${res.created === 1 ? '' : 's'} initiated.`,
      );
      onInitiated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark checks initiated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk order background checks</DialogTitle>
          <DialogDescription>
            Downloads everyone who has never been screened as a CSV ready for
            the provider&rsquo;s bulk-order upload.
          </DialogDescription>
        </DialogHeader>

        {error && <ErrorBanner className="mb-1">{error}</ErrorBanner>}

        {!pending && !error && <Skeleton className="h-16 w-full" />}

        {pending && all.length === 0 && (
          <p className="text-sm text-silver">
            Nobody is waiting — every associate already has a check on record.
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
              never-screened associate{rows.length === 1 ? '' : 's'} selected
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
                mark these associates as initiated so this queue reflects the
                order.
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
            onClick={() => void markInitiated()}
            loading={busy}
            disabled={!downloaded || rows.length === 0 || busy}
            title={
              downloaded
                ? 'Click after the CSV has been uploaded to the provider'
                : 'Download the CSV first'
            }
          >
            Mark {rows.length > 0 ? rows.length : ''} initiated
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface InitiateCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}

function InitiateCheckDialog({
  open,
  onOpenChange,
  onCreated,
  onError,
}: InitiateCheckDialogProps) {
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
      await initiateBackgroundCheck({
        associateId: associate.id,
        provider: 'alto-stub',
        ...(ref ? { externalId: ref } : {}),
      });
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Initiate failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Initiate background check</DialogTitle>
          <DialogDescription>
            Manual initiation is reserved for back-fills. New hires get a check
            automatically when they reach the BACKGROUND_CHECK onboarding task.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Associate" required>
            <AssociatePicker
              value={associate}
              onChange={setAssociate}
              placeholder="Search by name…"
            />
          </Field>
          <Field label="Provider reference / external ID (optional)">
            <Input
              placeholder="e.g. Checkr report id"
              maxLength={120}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
            />
          </Field>
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
              Initiate check
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
