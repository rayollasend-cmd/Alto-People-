import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bus,
  Camera,
  Clock,
  CreditCard,
  DollarSign,
  Eye,
  FileCheck,
  FileSignature,
  FileText,
  Home,
  Plane,
  RotateCw,
  ScanLine,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { toast } from 'sonner';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  previewDocumentUrl,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, fmtSize } from '@/lib/format';
import { enterStagger } from '@/lib/motion';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { DocumentPreview } from '@/components/DocumentPreview';
import { DocumentCropDialog, shapeForDocument } from '@/components/DocumentCropDialog';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';
import { usePersistentState } from '@/lib/usePersistentState';

const KIND_VALUES: DocumentKind[] = [
  'ID',
  'SSN_CARD',
  'I9_SUPPORTING',
  'OFFER_LETTER',
  'HOUSING_AGREEMENT',
  'TRANSPORT_AGREEMENT',
  'J1_DS2019',
  'J1_VISA',
  'OTHER',
];

const STATUS_VARIANT: Record<
  DocumentRecord['status'],
  'pending' | 'success' | 'destructive'
> = {
  UPLOADED: 'pending',
  VERIFIED: 'success',
  REJECTED: 'destructive',
  EXPIRED: 'destructive',
};

const kindLabel = (t: Translate, k: DocumentKind): string =>
  t(('docs.kind.' + k) as MessageKey);

// Every document kind gets a face — the wallet read. A driver's license
// and a visa should be recognizable before a single word is parsed.
const KIND_ICONS: Record<DocumentKind, typeof FileText> = {
  ID: CreditCard,
  SSN_CARD: ShieldCheck,
  I9_SUPPORTING: FileCheck,
  OFFER_LETTER: FileSignature,
  HOUSING_AGREEMENT: Home,
  TRANSPORT_AGREEMENT: Bus,
  J1_DS2019: Plane,
  J1_VISA: Plane,
  // System-generated kinds (not in the upload picker, but they render
  // in the list when HR or a flow files them for the associate).
  W4_PDF: FileText,
  POLICY: FileText,
  SIGNED_AGREEMENT: FileSignature,
  BACKGROUND_CHECK_RESULT: ShieldCheck,
  DRUG_TEST_RESULT: FileCheck,
  I9_VERIFICATION_RESULT: FileCheck,
  PAYSTUB: DollarSign,
  OTHER: FileText,
};


// Mirrors the server's upload cap so an oversized file fails instantly
// with a readable message instead of after a full (doomed) POST.
const MAX_UPLOAD_BYTES = UPLOAD_MAX_BYTES;

const DAY_MS = 86_400_000;
/** Days until an ACTIVE document lapses (null for expired/rejected/no
 *  expiry). Powers the proactive warning — the page used to react only
 *  AFTER the badge turned EXPIRED. */
function daysToExpiry(d: DocumentRecord): number | null {
  if (!d.expiresAt || d.status === 'EXPIRED' || d.status === 'REJECTED') {
    return null;
  }
  return Math.ceil((new Date(d.expiresAt).getTime() - Date.now()) / DAY_MS);
}
function isExpiringSoon(d: DocumentRecord): boolean {
  const days = daysToExpiry(d);
  return days !== null && days >= 0 && days <= 30;
}

export function AssociateDocumentsView() {
  const { t } = useI18n();
  // Legacy re-scan nudge: one-time dismissible banner announcing scan
  // standardization (documents uploaded before it keep their old look
  // until re-uploaded). Persisted per browser.
  const [rescanSeen, setRescanSeen] = usePersistentState<boolean>(
    'docs.rescanNudgeSeen',
    false,
  );
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [kind, setKind] = useState<DocumentKind>('ID');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  // Name of the file sitting in the (visually hidden) picker — the tap
  // zone displays it so "did my file attach?" is never a mystery.
  const [fileName, setFileName] = useState<string | null>(null);
  // Document being replaced via the renew flow — drives the "Replacing:"
  // chip on the upload form so the intent stays visible.
  const [renewTarget, setRenewTarget] = useState<DocumentRecord | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listMyDocuments();
      setDocs(res.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('docs.loadFailed'));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Web Share Target intake: the service worker stashes files shared from
  // the OS share sheet in the 'alto-shared-intake' cache and lands here
  // with ?shared=1. Pre-attach the file to the upload form so sharing a
  // photo of a document into Alto is: share → pick kind → Upload.
  useEffect(() => {
    if (!window.location.search.includes('shared=1')) return;
    if (!('caches' in window)) return;
    let cancelled = false;
    (async () => {
      try {
        const cache = await caches.open('alto-shared-intake');
        const keys = await cache.keys();
        if (keys.length === 0) return;
        const res = await cache.match(keys[0]);
        if (!res || cancelled) return;
        const blob = await res.blob();
        const name = decodeURIComponent(
          res.headers.get('x-shared-filename') ?? 'shared-document',
        );
        const file = new File([blob], name, { type: blob.type });
        const input = fileRef.current;
        if (input) {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          // Programmatic assignment fires no change event — mirror the
          // name into the tap zone by hand.
          setFileName(name);
        }
        // Consume the stash — a share is one intake, never a resurface.
        for (const key of keys) await cache.delete(key);
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast.success(t('docs.sharedAttached', { name }));
        if (keys.length > 1) {
          toast(t('docs.sharedOnlyFirst', { count: keys.length }));
        }
        // Strip the flag so a refresh doesn't re-run the intake.
        window.history.replaceState(null, '', window.location.pathname);
      } catch {
        /* best-effort — the manual picker still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Image uploads pause at the standardization crop (fixed ratio, rotate,
  // scan enhancement); PDFs skip it — they're already documents.
  const [cropPending, setCropPending] = useState<File | null>(null);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError(t('docs.chooseFirst'));
      return;
    }
    if (file.type.startsWith('image/') && file.size <= MAX_UPLOAD_BYTES) {
      setCropPending(file);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t('docs.tooBig', { name: file.name, size: fmtSize(file.size) }));
      return;
    }
    await performUpload(file);
  };

  const performUpload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await uploadMyDocument(file, kind);
      if (fileRef.current) fileRef.current.value = '';
      setFileName(null);
      setRenewTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('docs.uploadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMyDocument(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('docs.deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  // Renew an expired/rejected document: pre-select its kind in the upload
  // form and bring the form into view + focus the file picker, so
  // re-uploading is one intent instead of "scroll up, find the right kind,
  // attach".
  const startRenewal = (d: DocumentRecord) => {
    setKind(d.kind);
    setRenewTarget(d);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fileRef.current?.focus();
  };

  const pullState = usePullToRefresh(refresh);

  // The page's verdict — "are my papers in order?" — computed once so
  // the hero can answer before the associate reads a single row.
  const summary = useMemo(() => {
    if (!docs || docs.length === 0) return null;
    return {
      verified: docs.filter((d) => d.status === 'VERIFIED').length,
      pending: docs.filter((d) => d.status === 'UPLOADED').length,
      rejected: docs.filter((d) => d.status === 'REJECTED').length,
      expired: docs.filter((d) => d.status === 'EXPIRED').length,
      expiring: docs.filter(isExpiringSoon).length,
    };
  }, [docs]);
  const needsAction =
    summary !== null &&
    summary.rejected + summary.expired + summary.expiring > 0;
  const inReview = summary !== null && !needsAction && summary.pending > 0;

  const scrollToUpload = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fileRef.current?.focus();
  };

  return (
    <div className="mx-auto">
      <PullToRefreshIndicator state={pullState} />
      <PageHeader
        title={t('docs.title')}
        subtitle={t('docs.subtitle')}
        primaryAction={
          <Button onClick={scrollToUpload}>
            <Upload className="h-4 w-4" />
            {t('docs.upload')}
          </Button>
        }
      />

      {!rescanSeen && docs !== null && docs.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-gold/40 bg-gold/10 px-4 py-3">
          <ScanLine className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">
              {t('docs.rescanTitle')}
            </div>
            <div className="text-xs text-silver mt-0.5">{t('docs.rescanBody')}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setRescanSeen(true)}>
            {t('docs.rescanDismiss')}
          </Button>
        </div>
      )}

      {/* The verdict FIRST, in the house hero grammar — gradient face,
          inset radial glow (never an offset blur; e2e rect guard), the
          state word big in heavy sans, one HUMAN sentence of counts. */}
      {summary && (
        <div
          className={cn(
            'relative overflow-hidden mb-6 rounded-lg border p-5 animate-enter',
            needsAction
              ? 'border-alert/40 bg-gradient-to-br from-alert/[0.12] via-transparent to-transparent'
              : inReview
                ? 'border-warning/40 bg-gradient-to-br from-warning/[0.12] via-transparent to-transparent'
                : 'border-success/40 bg-gradient-to-br from-success/[0.12] via-transparent to-transparent',
          )}
        >
          <div
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0',
              needsAction
                ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-alert)/0.12),transparent_55%)]'
                : inReview
                  ? 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-warning)/0.12),transparent_55%)]'
                  : 'bg-[radial-gradient(circle_at_15%_0%,rgb(var(--color-success)/0.12),transparent_55%)]',
            )}
          />
          <div className="relative">
            <div className="flex items-center gap-2.5 text-3xl font-bold tracking-tight text-white">
              {needsAction ? (
                <AlertTriangle className="h-6 w-6 text-alert" aria-hidden="true" />
              ) : inReview ? (
                <Clock className="h-6 w-6 text-warning" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-6 w-6 text-success" aria-hidden="true" />
              )}
              {t(
                needsAction
                  ? 'docs.heroActionNeeded'
                  : inReview
                    ? 'docs.heroInReview'
                    : 'docs.heroAllSet',
              )}
            </div>
            <p className="mt-1.5 text-sm text-silver tabular-nums">
              {[
                [summary.verified, 'docs.heroVerifiedOne', 'docs.heroVerified'],
                [summary.pending, 'docs.heroPendingOne', 'docs.heroPending'],
                [summary.expiring, 'docs.heroExpiringOne', 'docs.heroExpiring'],
                [summary.expired, 'docs.heroExpiredOne', 'docs.heroExpired'],
                [summary.rejected, 'docs.heroRejectedOne', 'docs.heroRejected'],
              ]
                .filter(([count]) => (count as number) > 0)
                .map(([count, one, many]) =>
                  count === 1
                    ? t(one as MessageKey)
                    : t(many as MessageKey, { count: count as number }),
                )
                .join(' · ')}
            </p>
          </div>
        </div>
      )}

      <h2 className="text-xl text-white mb-3">{t('docs.yourDocs')}</h2>
      {/* Load failure surfaces HERE with a retry — with the form moved to
          the bottom, its banner would otherwise hide below the fold. */}
      {error && !docs && (
        <ErrorBanner
          className="mb-4"
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!docs && !error && <SkeletonRows count={4} rowHeight="h-14" />}
      {docs && docs.length === 0 && (
        <EmptyState
          icon={FileText}
          title={t('docs.emptyTitle')}
          description={t('docs.emptyDesc')}
        />
      )}
      {docs && docs.length > 0 && (
        <ul className="space-y-2">
          {docs.map((d, i) => {
            const badgeEl = (
              <Badge variant={STATUS_VARIANT[d.status]} className="shrink-0">
                {t(('docs.status.' + d.status) as MessageKey)}
              </Badge>
            );
            return (
              <li
                key={d.id}
                className="p-3 bg-navy border border-navy-secondary rounded-lg animate-enter"
                style={enterStagger(i)}
              >
                {/* md+: packed single-line row (mouse precision). */}
                <div className="hidden md:flex md:items-center md:gap-3">
                  <DocThumb d={d} onOpen={() => setPreviewDoc(d)} t={t} />
                  <div className="flex-1 min-w-0">
                    <DocInfo d={d} t={t} />
                  </div>
                  {/* Renew appears BEFORE the lapse too — an expiring
                      credential is a problem today, not on expiry day. */}
                  {(d.status === 'EXPIRED' || isExpiringSoon(d)) && (
                    <button
                      type="button"
                      onClick={() => startRenewal(d)}
                      className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
                      title={t('docs.renewHint')}
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      {t('docs.renew')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewDoc(d)}
                    className="text-xs text-silver hover:text-gold inline-flex items-center gap-1"
                    title={d.fileAvailable ? t('docs.viewHint') : t('docs.viewMissingHint')}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t('docs.view')}
                  </button>
                  {badgeEl}
                  {d.status !== 'VERIFIED' && (
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(d)}
                      className="text-xs text-silver/70 hover:text-alert"
                      aria-label={t('docs.deleteAria', { name: d.filename })}
                    >
                      {t('docs.delete')}
                    </button>
                  )}
                </div>

                {/* Below md: stacked card — label + status on top, then
                    full-width thumb-sized (≥44px) action buttons. */}
                <div className="md:hidden space-y-3">
                  <div className="flex items-start gap-3">
                    <DocThumb d={d} onOpen={() => setPreviewDoc(d)} t={t} />
                    <div className="min-w-0 flex-1">
                      <DocInfo d={d} t={t} />
                    </div>
                    {badgeEl}
                  </div>
                  <div className="space-y-2">
                    {(d.status === 'EXPIRED' || isExpiringSoon(d)) && (
                      <Button
                        type="button"
                        onClick={() => startRenewal(d)}
                        className="w-full min-h-11"
                      >
                        <RotateCw className="h-4 w-4" />
                        {t('docs.renew')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setPreviewDoc(d)}
                      className="w-full min-h-11"
                    >
                      <Eye className="h-4 w-4" />
                      {t('docs.view')}
                    </Button>
                    {d.status !== 'VERIFIED' && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDeleteTarget(d)}
                        className="w-full min-h-11 hover:border-alert hover:text-alert"
                      >
                        {t('docs.delete')}
                      </Button>
                    )}
                  </div>
                </div>

                {d.status === 'REJECTED' && (
                  <div className="mt-3 flex flex-col gap-2 rounded-md border border-alert/40 bg-alert/10 p-3 md:flex-row md:items-center md:gap-3">
                    <p role="alert" className="flex-1 text-xs text-alert">
                      {t('docs.rejected')}
                      {d.rejectionReason
                        ? `: ${d.rejectionReason}`
                        : t('docs.rejectedNoReason')}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => startRenewal(d)}
                      className="w-full min-h-11 md:w-auto md:min-h-0"
                    >
                      {t('docs.uploadReplacement')}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* The tool comes LAST — most visits are "check my status", not
          "upload"; the header's Upload button and every renew/replace
          CTA scroll down here. */}
      <form
        ref={formRef}
        onSubmit={handleUpload}
        className="bg-navy border border-navy-secondary rounded-lg p-5 mt-6 space-y-3"
      >
        <h2 className="text-lg font-medium text-white">{t('docs.upload')}</h2>
        {renewTarget && (
          <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-xs text-gold">
            <RotateCw className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('docs.replacing', { name: renewTarget.filename })}</span>
            <button
              type="button"
              onClick={() => setRenewTarget(null)}
              aria-label={t('docs.cancelReplacing', { name: renewTarget.filename })}
              className="shrink-0 text-gold hover:text-white"
            >
              ✕
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-silver mb-1">
              {t('docs.kindLabel')}
            </span>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
            >
              {KIND_VALUES.map((v) => (
                <option key={v} value={v}>
                  {kindLabel(t, v)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block cursor-pointer">
            <span className="block text-xs font-medium text-silver mb-1">
              {t('docs.fileLabel')}
            </span>
            {/* An invitation, not a form field: a camera-led tap zone in
                place of the native file input's browser chrome. */}
            <span className="flex items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-navy-secondary hover:border-gold/50 transition-colors px-4 py-5 text-center">
              <Camera className="h-5 w-5 shrink-0 text-gold" aria-hidden="true" />
              <span
                className={cn(
                  'text-sm min-w-0 break-words',
                  fileName ? 'text-white' : 'text-silver',
                )}
              >
                {fileName ?? t('docs.addHint')}
              </span>
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              capture="environment"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              className="sr-only"
            />
            <span className="block text-xs text-silver/70 mt-1">
              {t('docs.noWord')}
            </span>
          </label>
        </div>
        {error && docs && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? t('docs.uploading') : t('docs.upload')}
        </Button>
      </form>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={
          deleteTarget
            ? t('docs.deleteTitle', { name: deleteTarget.filename })
            : t('docs.deleteFallbackTitle')
        }
        description={t('docs.deleteDesc')}
        confirmLabel={t('docs.delete')}
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
      />
      {cropPending && (
        <DocumentCropDialog
          file={cropPending}
          initialShape={shapeForDocument({ kind })}
          onCancel={() => setCropPending(null)}
          onCropped={(standardized) => {
            setCropPending(null);
            void performUpload(standardized);
          }}
        />
      )}

      <DocumentPreview
        doc={previewDoc}
        onOpenChange={(o) => !o && setPreviewDoc(null)}
      />
    </div>
  );
}

/** The wallet chip: the document kind as a recognizable face, toned by
 *  what the document needs — green when solid, amber when waiting or
 *  running out, red when it needs replacing. */
function KindChip({ d }: { d: DocumentRecord }) {
  const Icon = KIND_ICONS[d.kind] ?? FileText;
  const tone =
    d.status === 'REJECTED' || d.status === 'EXPIRED'
      ? 'bg-alert/15 text-alert'
      : d.status === 'UPLOADED' || isExpiringSoon(d)
        ? 'bg-warning/15 text-warning'
        : 'bg-success/15 text-success';
  return (
    <div
      aria-hidden="true"
      className={cn(
        'grid h-14 w-14 shrink-0 place-items-center rounded-lg',
        tone,
      )}
    >
      <Icon className="h-6 w-6" />
    </div>
  );
}

/** The document ITSELF leads the row when it's an image — visible at a
 *  glance, no tap needed; tapping it opens the full viewer. PDFs and
 *  missing files keep the kind chip (a live PDF frame per row would be
 *  paint-cost for nothing). */
function DocThumb({
  d,
  onOpen,
  t,
}: {
  d: DocumentRecord;
  onOpen: () => void;
  t: Translate;
}) {
  if (!d.fileAvailable || !d.mimeType.startsWith('image/')) {
    return <KindChip d={d} />;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('docs.viewHint')}
      className="shrink-0 overflow-hidden rounded-lg border border-navy-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <img
        src={previewDocumentUrl(d.id)}
        alt=""
        loading="lazy"
        className="h-14 w-14 object-cover"
      />
    </button>
  );
}

/** KIND-led identity — "Driver's license", not "scan_final_2.jpg". The
 *  filename is metadata and lives on the quiet second line. Rejection
 *  reasons render in the dedicated callout instead of here. */
function DocInfo({ d, t }: { d: DocumentRecord; t: Translate }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-semibold text-white truncate">
        {kindLabel(t, d.kind)}
      </div>
      <div className="text-xs text-silver">
        {d.filename}{' '}
        <span className="text-silver/60">· {fmtSize(d.size)}</span>
        {d.status === 'EXPIRED' && (
          <span className="text-alert ml-2">
            {t('docs.expiredMeta', {
              date: d.expiresAt ? ` ${fmtDate(d.expiresAt)}` : '',
            })}
          </span>
        )}
        {d.status !== 'EXPIRED' &&
          d.expiresAt &&
          (isExpiringSoon(d) ? (
            <span className="text-warning ml-2 tabular-nums">
              {t('docs.expiringSoonMeta', {
                date: fmtDate(d.expiresAt),
                days: Math.max(0, daysToExpiry(d) ?? 0),
              })}
            </span>
          ) : (
            <span className="text-silver/70 ml-2">
              {t('docs.expiresMeta', { date: fmtDate(d.expiresAt) })}
            </span>
          ))}
        {!d.fileAvailable && (
          <span className="text-alert ml-2">
            {t('docs.fileMissingMeta')}
          </span>
        )}
      </div>
    </div>
  );
}
