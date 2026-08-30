import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Camera, CheckCircle2, FileText, RotateCcw, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import { I9_DOC_CATALOG, i9CatalogEntry, i9SetSatisfied } from '@alto-people/shared';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { finishDocumentUpload } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TaskShell, Field, useNextTask } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { fmtSize } from '@/lib/format';
import { statusTone } from '@/lib/status';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

// The picker offers the FEDERAL document list, not generic buckets — "which
// document is this?" is knowledge only the associate has at upload time,
// and losing it forced HR to guess from thumbnails at Section 2. 'OTHER'
// stays as an escape hatch (receipts, unusual documents): it uploads
// unclassified, exactly like the pre-catalog behavior.
const OTHER_VALUE = '__other__';
const LIST_HEADING: Record<'A' | 'B' | 'C', string> = {
  A: 'List A — proves identity AND right to work (one is enough)',
  B: 'List B — proves identity only (also add one from List C)',
  C: 'List C — proves right to work only (also add one from List B)',
};

const MAX_BYTES = UPLOAD_MAX_BYTES;

const ACCEPTED_MIMES = 'application/pdf,image/png,image/jpeg,image/webp';


const STATUS_LABEL: Record<string, string> = {
  UPLOADED: 'Awaiting review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

const KIND_LABEL: Record<string, string> = {
  ID: 'Photo ID',
  SSN_CARD: 'Social Security card',
  I9_SUPPORTING: 'I-9 supporting document',
};

export function DocumentUploadTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Two pickers, one handler: `capture` locks iOS to the camera, so a
  // camera-only input made a passport PDF sitting in email unselectable.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [docTitle, setDocTitle] = useState<string>(I9_DOC_CATALOG[0].title);
  const [side, setSide] = useState<'' | 'FRONT' | 'BACK'>('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('DOCUMENT_UPLOAD');

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

  // Live federal-requirement meter over the non-rejected uploads. Legacy /
  // "Other" uploads are unclassified — they don't count toward the meter,
  // but their presence keeps submit open (HR sorts them at review), which
  // is exactly the server's rule.
  const usable = idDocs.filter((d) => d.status !== 'REJECTED');
  const hasA = usable.some((d) => d.i9List === 'A');
  const hasB = usable.some((d) => d.i9List === 'B');
  const hasC = usable.some((d) => d.i9List === 'C');
  const hasUnclassified = usable.some((d) => d.i9List == null);
  const combinationOk =
    i9SetSatisfied(usable.map((d) => d.i9List)) || hasUnclassified;
  const canSubmit = hasAtLeastOne && combinationOk;

  const selectedEntry = docTitle === OTHER_VALUE ? undefined : i9CatalogEntry(docTitle);

  // When set, the next file picked is treated as a replacement: we upload
  // it under the SAME kind, then delete the rejected original. One click
  // for the associate instead of delete + re-upload.
  const [replaceTarget, setReplaceTarget] = useState<DocumentRecord | null>(null);
  // A failed upload keeps its File in memory so "Retry" needs no re-pick —
  // on flaky signal, re-opening the camera roll was where associates gave up.
  const [failedUpload, setFailedUpload] = useState<{
    file: File;
    target: DocumentRecord | null;
  } | null>(null);
  const doUpload = async (file: File, target: DocumentRecord | null) => {
    setError(null);
    setUploading(true);
    try {
      // Replacement: upload fresh under the same kind + classification,
      // THEN delete the old doc. If the upload fails we keep the original
      // around so HR can still see the history.
      const uploadKind: DocumentKind = target
        ? target.kind
        : selectedEntry?.kind ?? 'I9_SUPPORTING';
      await uploadMyDocument(file, uploadKind, {
        ...(target
          ? {
              ...(target.i9DocTitle ? { i9DocTitle: target.i9DocTitle } : {}),
              ...(target.side ? { side: target.side } : {}),
            }
          : {
              ...(selectedEntry ? { i9DocTitle: selectedEntry.title } : {}),
              ...(selectedEntry?.card && side ? { side } : {}),
            }),
      });
      if (target) {
        try {
          await deleteMyDocument(target.id);
        } catch {
          /* best-effort — the new upload is what matters */
        }
        toast.success(`Replaced ${target.filename} with ${file.name}.`);
      } else {
        toast.success(`Uploaded ${file.name}.`);
      }
      setFailedUpload(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setFailedUpload({ file, target });
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow same-file re-selection
    const target = replaceTarget;
    setReplaceTarget(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`File too large (max ${fmtSize(MAX_BYTES)}).`);
      return;
    }
    await doUpload(file, target);
  };

  const onDelete = (d: DocumentRecord) => {
    if (d.status === 'VERIFIED') return;
    setDeleteTarget(d);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMyDocument(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      toast.error('Could not remove the document.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  };

  const onFinish = async () => {
    if (!applicationId || finishing) return;
    if (!hasAtLeastOne) {
      setError('Upload at least one document before finishing.');
      return;
    }
    if (!combinationOk) {
      setError(
        'Your documents don’t yet satisfy the I-9: add ONE List A document, or one from List B plus one from List C.',
      );
      return;
    }
    setError(null);
    setFinishing(true);
    try {
      await finishDocumentUpload(applicationId);
      toast.success('Documents submitted — HR will review them shortly.');
      navigate(next?.route ?? backTo, { replace: true });
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
        only — up to {fmtSize(MAX_BYTES)} per file. Word documents aren't
        supported; export or print to PDF first. HR will review each upload;
        you'll see the status update on your checklist.
      </p>

      {/* Federal requirement meter — the associate sees what's still
          missing BEFORE submitting instead of HR discovering it at
          Section 2 with the 3-day clock running. */}
      <div className="mb-4 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm">
        <div className="mb-1.5 font-medium text-white">
          What the I-9 form needs
        </div>
        <div className={cn('flex items-center gap-2', hasA ? 'text-success' : 'text-silver')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', !hasA && 'opacity-30')} />
          ONE List A document (passport, Green Card…)
        </div>
        <div className="my-0.5 pl-5 text-xs text-silver/60">— or both of —</div>
        <div className={cn('flex items-center gap-2', hasB ? 'text-success' : 'text-silver')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', !hasB && 'opacity-30')} />
          One List B document (driver&apos;s license, state ID…)
        </div>
        <div className={cn('flex items-center gap-2', hasC ? 'text-success' : 'text-silver')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', !hasC && 'opacity-30')} />
          One List C document (unrestricted Social Security card, birth certificate…)
        </div>
        {hasUnclassified && (
          <div className="mt-1.5 text-xs text-silver/70">
            Some of your documents were uploaded without a type — HR will
            classify them at review, so you can still submit.
          </div>
        )}
      </div>

      <div className="space-y-4">
        <Field label="Which document is this?">
          <Select
            value={docTitle}
            onChange={(e) => {
              setDocTitle(e.target.value);
              setSide('');
            }}
            disabled={uploading}
          >
            {(['A', 'B', 'C'] as const).map((list) => (
              <optgroup key={list} label={LIST_HEADING[list]}>
                {I9_DOC_CATALOG.filter((c) => c.list === list).map((c) => (
                  <option key={c.title} value={c.title}>
                    {c.title}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Something else">
              <option value={OTHER_VALUE}>Other I-9 supporting document</option>
            </optgroup>
          </Select>
        </Field>
        {docTitle === 'Social Security card (unrestricted)' && (
          <p className="text-xs text-warning">
            If your card is printed with a restriction like &ldquo;VALID FOR
            WORK ONLY WITH DHS AUTHORIZATION&rdquo;, it does NOT count as a
            List C document — pick &ldquo;Other I-9 supporting
            document&rdquo; instead and add a different List C document.
          </p>
        )}
        {selectedEntry?.card && (
          <Field label="Which side of the card? (optional)">
            <Select
              value={side}
              onChange={(e) => setSide(e.target.value as '' | 'FRONT' | 'BACK')}
              disabled={uploading}
            >
              <option value="">One photo shows everything</option>
              <option value="FRONT">Front</option>
              <option value="BACK">Back</option>
            </Select>
          </Field>
        )}

        <input
          ref={cameraInputRef}
          type="file"
          accept={ACCEPTED_MIMES}
          capture="environment"
          onChange={onFileChange}
          className="hidden"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MIMES}
          onChange={onFileChange}
          className="hidden"
        />
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={uploading}
            className={cn(
              'px-4 py-6 rounded-md border-2 border-dashed transition-colors',
              uploading
                ? 'border-navy-secondary text-silver/70 cursor-wait'
                : 'border-navy-secondary text-silver hover:border-gold/60 hover:text-gold'
            )}
          >
            <Camera className="h-5 w-5 inline-block mr-2 -mt-1" />
            {uploading ? 'Uploading…' : 'Take photo'}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className={cn(
              'px-4 py-6 rounded-md border-2 border-dashed transition-colors',
              uploading
                ? 'border-navy-secondary text-silver/70 cursor-wait'
                : 'border-navy-secondary text-silver hover:border-gold/60 hover:text-gold'
            )}
          >
            <Upload className="h-5 w-5 inline-block mr-2 -mt-1" />
            {uploading ? 'Uploading…' : 'Choose file'}
          </button>
        </div>

        {failedUpload && !uploading && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded-md border border-alert/40 bg-alert/[0.06] text-sm"
          >
            <span className="min-w-0 flex-1 basis-48 truncate text-white">
              {failedUpload.file.name}
              <span className="block text-xs text-alert">
                Upload failed — your file is still here.
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => doUpload(failedUpload.file, failedUpload.target)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry upload
            </Button>
            <button
              type="button"
              onClick={() => {
                // Keep the replace intent (if any) armed for the fresh pick.
                setReplaceTarget(failedUpload.target);
                setFailedUpload(null);
                setError(null);
                fileInputRef.current?.click();
              }}
              className="text-sm text-silver hover:text-white coarse:min-h-11 inline-flex items-center"
            >
              Choose different file
            </button>
          </div>
        )}

        {/* Uploaded list ------------------------------------------------ */}
        <div>
          <div className="text-xs uppercase tracking-widest text-silver mb-2">
            Your uploaded documents{' '}
            <span className="ml-1 tabular-nums text-silver/70">
              {idDocs.length}
            </span>
          </div>
          {docs === null ? (
            <SkeletonRows count={2} rowHeight="h-12" />
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
                      {d.i9DocTitle ?? KIND_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ')}
                      {d.i9List ? ` · List ${d.i9List}` : ''}
                      {d.side ? ` · ${d.side === 'FRONT' ? 'front' : 'back'}` : ''}
                      {' · '}
                      {fmtSize(d.size)}
                    </div>
                    {d.rejectionReason && (
                      <div className="text-xs text-alert mt-1">
                        Reason: {d.rejectionReason}
                      </div>
                    )}
                  </div>
                  <Badge
                    size="sm"
                    variant={statusTone(d.status)}
                    data-status={d.status}
                  >
                    {STATUS_LABEL[d.status] ?? d.status}
                  </Badge>
                  {d.status !== 'VERIFIED' && (
                    <button
                      type="button"
                      onClick={() => {
                        setReplaceTarget(d);
                        // Re-trigger the hidden file input. The handler
                        // sees replaceTarget and does upload + delete-old
                        // in one go. Allowed for any not-yet-verified doc —
                        // an applicant who uploaded the wrong/blurry file can
                        // swap it without waiting for HR to reject it first.
                        fileInputRef.current?.click();
                      }}
                      className="text-warning hover:opacity-80"
                      aria-label="Replace this document"
                      title="Re-upload to replace"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
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

        {canSubmit && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-success/30 bg-success/[0.05] text-success text-xs">
            <CheckCircle2 className="h-3.5 w-3.5" />
            You have {idDocs.length} document{idDocs.length === 1 ? '' : 's'} ready
            to submit.
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="button"
            onClick={onFinish}
            loading={finishing}
            disabled={!canSubmit || finishing}
          >
            {finishing
              ? 'Submitting…'
              : canSubmit
                ? next
                  ? `Submit & continue → ${next.label}`
                  : "I'm done — submit for review"
                : hasAtLeastOne
                  ? 'List A, or List B + C, still needed'
                  : 'Upload at least one'}
          </Button>
          <Link to={backTo} className="text-sm text-silver hover:text-white">
            Cancel
          </Link>
        </div>
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={deleteTarget ? `Remove "${deleteTarget.filename}"?` : 'Remove file'}
        description="The upload will be removed from your record. You can re-upload before submitting for review."
        confirmLabel="Remove"
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
      />
    </TaskShell>
  );
}
