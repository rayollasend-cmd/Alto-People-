import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, FileText, RotateCw, ScanLine } from 'lucide-react';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { toast } from 'sonner';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, fmtSize } from '@/lib/format';
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


// Mirrors the server's upload cap so an oversized file fails instantly
// with a readable message instead of after a full (doomed) POST.
const MAX_UPLOAD_BYTES = UPLOAD_MAX_BYTES;

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
        }
        // Consume the stash — a share is one intake, never a resurface.
        for (const key of keys) await cache.delete(key);
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast.success(`"${name}" attached — pick the document kind and upload.`);
        if (keys.length > 1) {
          toast(`Only the first of ${keys.length} shared files was attached — share the others one at a time.`);
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

  // Touch parity with ui/Input — 44px target + 16px text on coarse
  // pointers so iOS never zooms on focus (mirrors the onboarding inputCls).
  const inputCls =
    'w-full h-10 coarse:h-11 px-3 py-2 text-sm coarse:text-base rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  const pullState = usePullToRefresh(refresh);

  return (
    <div className="mx-auto">
      <PullToRefreshIndicator state={pullState} />
      <PageHeader
        title={t('docs.title')}
        subtitle={t('docs.subtitle')}
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

      <form
        ref={formRef}
        onSubmit={handleUpload}
        className="bg-navy border border-navy-secondary rounded-lg p-5 mb-6 space-y-3"
      >
        <h2 className="text-2xl text-white">{t('docs.upload')}</h2>
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
            <span className="block text-xs uppercase tracking-widest text-silver mb-1">
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
          <label className="block">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1">
              {t('docs.fileLabel')}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              capture="environment"
              className={cn(inputCls, 'file:text-silver file:bg-navy-secondary file:border-0 file:px-2 file:py-1 file:mr-3 file:rounded')}
            />
            <span className="block text-xs text-silver/70 mt-1">
              {t('docs.noWord')}
            </span>
          </label>
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? t('docs.uploading') : t('docs.upload')}
        </Button>
      </form>

      <h2 className="text-2xl text-white mb-3">{t('docs.yourDocs')}</h2>
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
          {docs.map((d) => {
            const badgeEl = (
              <Badge variant={STATUS_VARIANT[d.status]} className="shrink-0">
                {t(('docs.status.' + d.status) as MessageKey)}
              </Badge>
            );
            return (
              <li
                key={d.id}
                className="p-3 bg-navy border border-navy-secondary rounded-lg"
              >
                {/* md+: packed single-line row (mouse precision). */}
                <div className="hidden md:flex md:items-center md:gap-3">
                  <div className="flex-1 min-w-0">
                    <DocInfo d={d} t={t} />
                  </div>
                  {d.status === 'EXPIRED' && (
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
                      ✕
                    </button>
                  )}
                </div>

                {/* Below md: stacked card — label + status on top, then
                    full-width thumb-sized (≥44px) action buttons. */}
                <div className="md:hidden space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <DocInfo d={d} t={t} />
                    {badgeEl}
                  </div>
                  <div className="space-y-2">
                    {d.status === 'EXPIRED' && (
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

/** Filename + size + kind/expiry meta — shared between the md+ row layout
 *  and the mobile stacked card. Rejection reasons render in the dedicated
 *  callout instead of here. */
function DocInfo({ d, t }: { d: DocumentRecord; t: Translate }) {
  return (
    <div className="min-w-0">
      <div className="text-white truncate">
        {d.filename}{' '}
        <span className="text-xs text-silver/70">· {fmtSize(d.size)}</span>
      </div>
      <div className="text-xs text-silver">
        {kindLabel(t, d.kind)}
        {d.status === 'EXPIRED' && (
          <span className="text-alert ml-2">
            {t('docs.expiredMeta', {
              date: d.expiresAt ? ` ${fmtDate(d.expiresAt)}` : '',
            })}
          </span>
        )}
        {d.status !== 'EXPIRED' && d.expiresAt && (
          <span className="text-silver/70 ml-2">
            {t('docs.expiresMeta', { date: fmtDate(d.expiresAt) })}
          </span>
        )}
        {!d.fileAvailable && (
          <span className="text-alert ml-2">
            {t('docs.fileMissingMeta')}
          </span>
        )}
      </div>
    </div>
  );
}
