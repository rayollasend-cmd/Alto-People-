import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, FileText, RotateCw } from 'lucide-react';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { DocumentPreview } from '@/components/DocumentPreview';

const KIND_OPTIONS: Array<{ value: DocumentKind; label: string }> = [
  { value: 'ID', label: 'Government ID' },
  { value: 'SSN_CARD', label: 'SSN card' },
  { value: 'I9_SUPPORTING', label: 'I-9 supporting document' },
  { value: 'OFFER_LETTER', label: 'Offer letter' },
  { value: 'HOUSING_AGREEMENT', label: 'Housing agreement' },
  { value: 'TRANSPORT_AGREEMENT', label: 'Transport agreement' },
  { value: 'J1_DS2019', label: 'J-1 DS-2019' },
  { value: 'J1_VISA', label: 'J-1 visa' },
  { value: 'OTHER', label: 'Other' },
];

function statusBadge(status: DocumentRecord['status']) {
  switch (status) {
    case 'UPLOADED':
      return { label: 'Awaiting review', cls: 'bg-silver/10 text-silver border-silver/30' };
    case 'VERIFIED':
      return { label: 'Verified', cls: 'bg-success/15 text-success border-success/30' };
    case 'REJECTED':
      return { label: 'Rejected', cls: 'bg-alert/15 text-alert border-alert/30' };
    case 'EXPIRED':
      return { label: 'Expired', cls: 'bg-gold/20 text-gold border-gold/40' };
  }
}

const fmtSize = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

// Mirrors the server's upload cap so an oversized file fails instantly
// with a readable message instead of after a full (doomed) POST.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function AssociateDocumentsView() {
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
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `"${file.name}" is ${fmtSize(file.size)} — over the 10 MB limit. ` +
          'Try a smaller scan or a compressed PDF.'
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadMyDocument(file, kind);
      if (fileRef.current) fileRef.current.value = '';
      setRenewTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
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
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
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

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  return (
    <div className="mx-auto">
      <PageHeader
        title="My documents"
        subtitle="Upload identity, tax, and onboarding documents. HR will verify."
      />

      <form
        ref={formRef}
        onSubmit={handleUpload}
        className="bg-navy border border-navy-secondary rounded-lg p-5 mb-6 space-y-3"
      >
        <h2 className="font-display text-2xl text-white">Upload</h2>
        {renewTarget && (
          <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-xs text-gold">
            <RotateCw className="h-3 w-3 shrink-0" />
            <span className="truncate">Replacing: {renewTarget.filename}</span>
            <button
              type="button"
              onClick={() => setRenewTarget(null)}
              aria-label={`Cancel replacing ${renewTarget.filename}`}
              className="shrink-0 text-gold hover:text-white"
            >
              ✕
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1">
              Kind
            </span>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1">
              File (PDF / PNG / JPG / WEBP, max 10 MB)
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              capture="environment"
              className={cn(inputCls, 'file:text-silver file:bg-navy-secondary file:border-0 file:px-2 file:py-1 file:mr-3 file:rounded')}
            />
            <span className="block text-xs text-silver/70 mt-1">
              Word documents aren't supported — export to PDF first.
            </span>
          </label>
        </div>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
      </form>

      <h2 className="font-display text-2xl text-white mb-3">Your documents</h2>
      {!docs && <SkeletonRows count={4} rowHeight="h-14" />}
      {docs && docs.length === 0 && (
        <EmptyState
          icon={FileText}
          title="No documents uploaded"
          description="Use the form above to share IDs, tax forms, or onboarding paperwork. HR will review each upload."
        />
      )}
      {docs && docs.length > 0 && (
        <ul className="space-y-2">
          {docs.map((d) => {
            const badge = statusBadge(d.status);
            const badgeEl = (
              <span
                className={cn(
                  'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
                  badge.cls
                )}
              >
                {badge.label}
              </span>
            );
            return (
              <li
                key={d.id}
                className="p-3 bg-navy border border-navy-secondary rounded-lg"
              >
                {/* md+: packed single-line row (mouse precision). */}
                <div className="hidden md:flex md:items-center md:gap-3">
                  <div className="flex-1 min-w-0">
                    <DocInfo d={d} />
                  </div>
                  {d.status === 'EXPIRED' && (
                    <button
                      type="button"
                      onClick={() => startRenewal(d)}
                      className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
                      title="Re-upload to replace this document"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                      Renew
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPreviewDoc(d)}
                    className="text-xs text-silver hover:text-gold inline-flex items-center gap-1"
                    title={d.fileAvailable ? 'View document' : 'File missing on server — open for details'}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    View
                  </button>
                  {badgeEl}
                  {d.status !== 'VERIFIED' && (
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(d)}
                      className="text-xs text-silver/70 hover:text-alert"
                      aria-label={`Delete ${d.filename}`}
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Below md: stacked card — label + status on top, then
                    full-width thumb-sized (≥44px) action buttons. */}
                <div className="md:hidden space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <DocInfo d={d} />
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
                        Renew
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setPreviewDoc(d)}
                      className="w-full min-h-11"
                    >
                      <Eye className="h-4 w-4" />
                      View
                    </Button>
                    {d.status !== 'VERIFIED' && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDeleteTarget(d)}
                        className="w-full min-h-11 hover:border-alert hover:text-alert"
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>

                {d.status === 'REJECTED' && (
                  <div className="mt-3 flex flex-col gap-2 rounded-md border border-alert/40 bg-alert/10 p-3 md:flex-row md:items-center md:gap-3">
                    <p role="alert" className="flex-1 text-xs text-alert">
                      Rejected
                      {d.rejectionReason
                        ? `: ${d.rejectionReason}`
                        : ' — no reason given. Ask HR if you’re unsure what to fix.'}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => startRenewal(d)}
                      className="w-full min-h-11 md:w-auto md:min-h-0"
                    >
                      Upload a replacement
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
            ? `Delete "${deleteTarget.filename}"?`
            : 'Delete document'
        }
        description="The document will be removed from your record. If HR hasn't reviewed it yet, you can re-upload."
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
      />

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
function DocInfo({ d }: { d: DocumentRecord }) {
  return (
    <div className="min-w-0">
      <div className="text-white truncate">
        {d.filename}{' '}
        <span className="text-xs text-silver/70">· {fmtSize(d.size)}</span>
      </div>
      <div className="text-xs text-silver">
        {d.kind.replace(/_/g, ' ')}
        {d.status === 'EXPIRED' && (
          <span className="text-gold ml-2">
            · expired{d.expiresAt ? ` ${fmtDate(d.expiresAt)}` : ''} —
            please upload a fresh copy
          </span>
        )}
        {d.status !== 'EXPIRED' && d.expiresAt && (
          <span className="text-silver/70 ml-2">
            · expires {fmtDate(d.expiresAt)}
          </span>
        )}
        {!d.fileAvailable && (
          <span className="text-alert ml-2">
            · file missing — please re-upload
          </span>
        )}
      </div>
    </div>
  );
}
