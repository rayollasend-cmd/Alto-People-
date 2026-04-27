import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import {
  deleteMyDocument,
  downloadDocumentUrl,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';

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
      return { label: 'Verified', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' };
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

export function AssociateDocumentsView() {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [kind, setKind] = useState<DocumentKind>('ID');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    setBusy(true);
    setError(null);
    try {
      await uploadMyDocument(file, kind);
      if (fileRef.current) fileRef.current.value = '';
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

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="My documents"
        subtitle="Upload identity, tax, and onboarding documents. HR will verify."
      />

      <form
        onSubmit={handleUpload}
        className="bg-navy border border-navy-secondary rounded-lg p-5 mb-6 space-y-3"
      >
        <h2 className="font-display text-2xl text-white">Upload</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1">
              Kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              className={inputCls}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-widest text-silver mb-1">
              File (PDF / PNG / JPG / WEBP, max 10 MB)
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              className={cn(inputCls, 'file:text-silver file:bg-navy-secondary file:border-0 file:px-2 file:py-1 file:mr-3 file:rounded')}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className={cn(
            'px-5 py-2.5 rounded font-medium transition',
            busy
              ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
              : 'bg-gold text-navy hover:bg-gold-bright'
          )}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </form>

      <h2 className="font-display text-2xl text-white mb-3">Your documents</h2>
      {!docs && <p className="text-silver">Loading…</p>}
      {docs && docs.length === 0 && (
        <p className="text-silver">No documents yet.</p>
      )}
      {docs && docs.length > 0 && (
        <ul className="space-y-2">
          {docs.map((d) => {
            const badge = statusBadge(d.status);
            return (
              <li
                key={d.id}
                className="flex items-center gap-3 p-3 bg-navy border border-navy-secondary rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-white truncate">
                    {d.filename}{' '}
                    <span className="text-xs text-silver/70">
                      · {fmtSize(d.size)}
                    </span>
                  </div>
                  <div className="text-xs text-silver">
                    {d.kind.replace(/_/g, ' ')}
                    {d.rejectionReason && (
                      <span className="text-alert ml-2">{d.rejectionReason}</span>
                    )}
                  </div>
                </div>
                <a
                  href={downloadDocumentUrl(d.id)}
                  className="text-xs text-silver hover:text-gold underline"
                >
                  Download
                </a>
                <span
                  className={cn(
                    'shrink-0 text-xs uppercase tracking-widest px-2 py-1 rounded border',
                    badge.cls
                  )}
                >
                  {badge.label}
                </span>
                {d.status !== 'VERIFIED' && (
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(d)}
                    className="text-xs text-silver/60 hover:text-alert"
                    title="Delete"
                  >
                    ✕
                  </button>
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
    </div>
  );
}
