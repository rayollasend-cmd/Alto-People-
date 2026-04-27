import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, FileText, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { finishDocumentUpload } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TaskShell, inputCls, Field } from './ProfileInfoTask';
import { cn } from '@/lib/cn';

const ID_KIND_OPTIONS: Array<{ value: DocumentKind; label: string }> = [
  { value: 'ID', label: 'Government-issued photo ID (driver license / passport)' },
  { value: 'SSN_CARD', label: 'Social Security card' },
  { value: 'I9_SUPPORTING', label: 'Other I-9 supporting document' },
];

const MAX_BYTES = 10 * 1024 * 1024;

const ACCEPTED_MIMES = 'application/pdf,image/png,image/jpeg,image/webp';

const fmtSize = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const STATUS_LABEL: Record<string, string> = {
  UPLOADED: 'Awaiting review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

const STATUS_TONE: Record<string, string> = {
  UPLOADED: 'text-warning border-warning/40 bg-warning/[0.06]',
  VERIFIED: 'text-success border-success/40 bg-success/[0.06]',
  REJECTED: 'text-alert border-alert/40 bg-alert/[0.07]',
  EXPIRED: 'text-alert border-alert/40 bg-alert/[0.07]',
};

export function DocumentUploadTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [kind, setKind] = useState<DocumentKind>('ID');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  const refresh = useCallback(async () => {
    try {
      const r = await listMyDocuments();
      setDocs(r.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const idDocs = (docs ?? []).filter(
    (d) => d.kind === 'ID' || d.kind === 'SSN_CARD' || d.kind === 'I9_SUPPORTING'
  );
  const hasAtLeastOne = idDocs.length > 0;

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow same-file re-selection
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`File too large (max ${fmtSize(MAX_BYTES)}).`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      await uploadMyDocument(file, kind);
      toast.success(`Uploaded ${file.name}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (d: DocumentRecord) => {
    if (d.status === 'VERIFIED') return;
    if (!window.confirm(`Remove "${d.filename}"?`)) return;
    try {
      await deleteMyDocument(d.id);
      await refresh();
    } catch (err) {
      toast.error('Could not remove', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    }
  };

  const onFinish = async () => {
    if (!applicationId || finishing) return;
    if (!hasAtLeastOne) {
      setError('Upload at least one document before finishing.');
      return;
    }
    setError(null);
    setFinishing(true);
    try {
      await finishDocumentUpload(applicationId);
      toast.success('Documents submitted — HR will review them shortly.');
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not finish.');
    } finally {
      setFinishing(false);
    }
  };

  return (
    <TaskShell title="Identity documents" backTo={backTo}>
      <p className="text-silver text-sm mb-4">
        Upload a clear photo or scan of each document. PDF, PNG, JPG, or WebP
        — up to {fmtSize(MAX_BYTES)} per file. HR will review them; you'll see
        the status update on your checklist.
      </p>

      <div className="space-y-4">
        <Field label="Document type">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
            className={inputCls}
            disabled={uploading}
          >
            {ID_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MIMES}
          onChange={onFileChange}
          className="hidden"
        />
        <button
          type="button"
          onClick={onPickFile}
          disabled={uploading}
          className={cn(
            'w-full px-4 py-6 rounded-md border-2 border-dashed transition-colors',
            uploading
              ? 'border-navy-secondary text-silver/50 cursor-wait'
              : 'border-navy-secondary text-silver hover:border-gold/60 hover:text-gold'
          )}
        >
          <Upload className="h-5 w-5 inline-block mr-2 -mt-1" />
          {uploading ? 'Uploading…' : 'Click to choose a file'}
        </button>

        {/* Uploaded list ------------------------------------------------ */}
        <div>
          <div className="text-xs uppercase tracking-widest text-silver mb-2">
            Your uploaded documents{' '}
            <span className="ml-1 tabular-nums text-silver/60">
              {idDocs.length}
            </span>
          </div>
          {docs === null ? (
            <p className="text-silver text-sm">Loading…</p>
          ) : idDocs.length === 0 ? (
            <p className="text-silver text-sm">
              No documents yet — pick one above to start.
            </p>
          ) : (
            <ul className="space-y-2">
              {idDocs.map((d) => (
                <li
                  key={d.id}
                  className="flex items-start gap-3 p-3 rounded-md border border-navy-secondary bg-navy-secondary/30"
                >
                  <FileText className="h-4 w-4 mt-0.5 text-silver shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-sm font-medium truncate">
                      {d.filename}
                    </div>
                    <div className="text-xs text-silver/70 tabular-nums">
                      {d.kind.replace(/_/g, ' ')} · {fmtSize(d.size)}
                    </div>
                    {d.rejectionReason && (
                      <div className="text-xs text-alert mt-1">
                        Reason: {d.rejectionReason}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap',
                      STATUS_TONE[d.status] ?? STATUS_TONE.UPLOADED
                    )}
                    data-status={d.status}
                  >
                    {STATUS_LABEL[d.status] ?? d.status}
                  </span>
                  {d.status !== 'VERIFIED' && (
                    <button
                      type="button"
                      onClick={() => onDelete(d)}
                      className="text-alert hover:opacity-80"
                      aria-label="Remove document"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        {hasAtLeastOne && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-success/30 bg-success/[0.05] text-success text-xs">
            <CheckCircle2 className="h-3.5 w-3.5" />
            You have {idDocs.length} document{idDocs.length === 1 ? '' : 's'} ready
            to submit.
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onFinish}
            disabled={!hasAtLeastOne || finishing}
            className={cn(
              'px-5 py-2.5 rounded font-medium transition',
              !hasAtLeastOne || finishing
                ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                : 'bg-gold text-navy hover:bg-gold-bright'
            )}
          >
            {finishing
              ? 'Submitting…'
              : hasAtLeastOne
                ? "I'm done — submit for review"
                : 'Upload at least one'}
          </button>
          <Link to={backTo} className="text-sm text-silver hover:text-white">
            Cancel
          </Link>
        </div>
      </div>
    </TaskShell>
  );
}
