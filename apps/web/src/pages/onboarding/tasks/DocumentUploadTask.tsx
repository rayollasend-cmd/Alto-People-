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
import { useI18n } from '@/lib/i18n';
import { TaskShell, Field, useNextTask } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { fmtSize } from '@/lib/format';
import { statusTone } from '@/lib/status';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  DocumentCropDialog,
  shapeForDocument,
  type DocShape,
} from '@/components/DocumentCropDialog';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

// The picker offers the FEDERAL document list, not generic buckets — "which
// document is this?" is knowledge only the associate has at upload time,
// and losing it forced HR to guess from thumbnails at Section 2. 'OTHER'
// stays as an escape hatch (receipts, unusual documents): it uploads
// unclassified, exactly like the pre-catalog behavior.
const OTHER_VALUE = '__other__';

type Translate = ReturnType<typeof useI18n>['t'];

function listHeading(t: Translate, list: 'A' | 'B' | 'C'): string {
  switch (list) {
    case 'A':
      return t('ob.docs.listA');
    case 'B':
      return t('ob.docs.listB');
    case 'C':
      return t('ob.docs.listC');
  }
}

const MAX_BYTES = UPLOAD_MAX_BYTES;

const ACCEPTED_MIMES = 'application/pdf,image/png,image/jpeg,image/webp';


function statusLabel(t: Translate, status: string): string {
  switch (status) {
    case 'UPLOADED':
      return t('ob.docs.status.uploaded');
    case 'VERIFIED':
      return t('ob.docs.status.verified');
    case 'REJECTED':
      return t('ob.docs.status.rejected');
    case 'EXPIRED':
      return t('ob.docs.status.expired');
    default:
      return status;
  }
}

function kindLabel(t: Translate, kind: string): string | null {
  switch (kind) {
    case 'ID':
      return t('ob.docs.kind.id');
    case 'SSN_CARD':
      return t('ob.docs.kind.ssnCard');
    case 'I9_SUPPORTING':
      return t('ob.docs.kind.i9Supporting');
    default:
      return null;
  }
}

// Display names for the FEDERAL catalog titles. The catalog title string is
// an API value (i9DocTitle) — it must be submitted verbatim; only the text
// shown to the associate is translated. Unknown titles fall back to the raw
// value so legacy/unlisted documents still render.
function catalogTitleLabel(t: Translate, title: string): string {
  switch (title) {
    case 'U.S. Passport or Passport Card':
      return t('ob.docs.cat.usPassport');
    case 'Permanent Resident Card (Green Card, Form I-551)':
      return t('ob.docs.cat.greenCard');
    case 'Foreign passport with I-551 stamp or work authorization':
      return t('ob.docs.cat.foreignPassport');
    case 'Employment Authorization Document (Form I-766)':
      return t('ob.docs.cat.ead');
    case "Driver's license":
      return t('ob.docs.cat.driversLicense');
    case 'State ID card':
      return t('ob.docs.cat.stateId');
    case 'School ID card with photo':
      return t('ob.docs.cat.schoolId');
    case 'U.S. Military card or draft record':
      return t('ob.docs.cat.militaryCard');
    case 'Social Security card (unrestricted)':
      return t('ob.docs.cat.ssnUnrestricted');
    case 'Birth certificate (original or certified copy)':
      return t('ob.docs.cat.birthCert');
    case 'Native American tribal document':
      return t('ob.docs.cat.tribalDoc');
    default:
      return title;
  }
}

export function DocumentUploadTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
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
      setError(err instanceof ApiError ? err.message : t('ob.docs.loadFailed'));
    }
  }, [t]);

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
        toast.success(
          t('ob.docs.replacedToast', { old: target.filename, new: file.name }),
        );
      } else {
        toast.success(t('ob.docs.uploadedToast', { name: file.name }));
      }
      setFailedUpload(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ob.docs.uploadFailed'));
      setFailedUpload({ file, target });
    } finally {
      setUploading(false);
    }
  };

  // Image picks/captures pause at the standardization step (fixed-ratio
  // crop + rotate + scan enhancement) before uploading; PDFs go straight
  // through — a PDF is already a document.
  const [cropPending, setCropPending] = useState<{
    file: File;
    target: DocumentRecord | null;
    shape: DocShape;
  } | null>(null);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow same-file re-selection
    const target = replaceTarget;
    setReplaceTarget(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(t('ob.docs.tooLarge', { max: fmtSize(MAX_BYTES) }));
      return;
    }
    if (file.type.startsWith('image/')) {
      const entry = target?.i9DocTitle
        ? i9CatalogEntry(target.i9DocTitle)
        : selectedEntry;
      setCropPending({
        file,
        target,
        shape: shapeForDocument({
          card: entry?.card,
          title: entry?.title ?? target?.i9DocTitle ?? docTitle,
          kind: target?.kind ?? entry?.kind ?? null,
        }),
      });
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
      toast.error(t('ob.docs.removeFailed'), {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  };

  const onFinish = async () => {
    if (!applicationId || finishing) return;
    if (!hasAtLeastOne) {
      setError(t('ob.docs.needOne'));
      return;
    }
    if (!combinationOk) {
      setError(t('ob.docs.comboError'));
      return;
    }
    setError(null);
    setFinishing(true);
    try {
      await finishDocumentUpload(applicationId);
      toast.success(t('ob.docs.submittedToast'));
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ob.docs.finishFailed'));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <TaskShell title={t('ob.docs.title')} backTo={backTo}>
      <p className="text-silver text-sm mb-4">
        {t('ob.docs.intro', { max: fmtSize(MAX_BYTES) })}
      </p>

      {/* Federal requirement meter — the associate sees what's still
          missing BEFORE submitting instead of HR discovering it at
          Section 2 with the 3-day clock running. */}
      <div className="mb-4 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm">
        <div className="mb-1.5 font-medium text-white">
          {t('ob.docs.meterTitle')}
        </div>
        <div className={cn('flex items-center gap-2', hasA ? 'text-success' : 'text-silver')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', !hasA && 'opacity-30')} />
          {t('ob.docs.meterA')}
        </div>
        <div className="my-0.5 pl-5 text-xs text-silver/60">{t('ob.docs.meterOr')}</div>
        <div className={cn('flex items-center gap-2', hasB ? 'text-success' : 'text-silver')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', !hasB && 'opacity-30')} />
          {t('ob.docs.meterB')}
        </div>
        <div className={cn('flex items-center gap-2', hasC ? 'text-success' : 'text-silver')}>
          <CheckCircle2 className={cn('h-3.5 w-3.5', !hasC && 'opacity-30')} />
          {t('ob.docs.meterC')}
        </div>
        {hasUnclassified && (
          <div className="mt-1.5 text-xs text-silver/70">
            {t('ob.docs.unclassifiedNote')}
          </div>
        )}
      </div>

      <div className="space-y-4">
        <Field label={t('ob.docs.whichDoc')}>
          <Select
            value={docTitle}
            onChange={(e) => {
              setDocTitle(e.target.value);
              setSide('');
            }}
            disabled={uploading}
          >
            {(['A', 'B', 'C'] as const).map((list) => (
              <optgroup key={list} label={listHeading(t, list)}>
                {I9_DOC_CATALOG.filter((c) => c.list === list).map((c) => (
                  <option key={c.title} value={c.title}>
                    {catalogTitleLabel(t, c.title)}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label={t('ob.docs.somethingElse')}>
              <option value={OTHER_VALUE}>{t('ob.docs.otherOption')}</option>
            </optgroup>
          </Select>
        </Field>
        {docTitle === 'Social Security card (unrestricted)' && (
          <p className="text-xs text-warning">
            {t('ob.docs.ssnRestrictedWarning')}
          </p>
        )}
        {selectedEntry?.card && (
          <Field label={t('ob.docs.whichSide')}>
            <Select
              value={side}
              onChange={(e) => setSide(e.target.value as '' | 'FRONT' | 'BACK')}
              disabled={uploading}
            >
              <option value="">{t('ob.docs.sideBoth')}</option>
              <option value="FRONT">{t('ob.docs.sideFront')}</option>
              <option value="BACK">{t('ob.docs.sideBack')}</option>
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
            {uploading ? t('ob.docs.uploading') : t('ob.docs.takePhoto')}
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
            {uploading ? t('ob.docs.uploading') : t('ob.docs.chooseFile')}
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
                {t('ob.docs.failedStillHere')}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => doUpload(failedUpload.file, failedUpload.target)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('ob.docs.retryUpload')}
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
              {t('ob.docs.chooseDifferent')}
            </button>
          </div>
        )}

        {/* Uploaded list ------------------------------------------------ */}
        <div>
          <div className="text-xs uppercase tracking-widest text-silver mb-2">
            {t('ob.docs.uploadedHeading')}{' '}
            <span className="ml-1 tabular-nums text-silver/70">
              {idDocs.length}
            </span>
          </div>
          {docs === null ? (
            <SkeletonRows count={2} rowHeight="h-12" />
          ) : idDocs.length === 0 ? (
            <p className="text-silver text-sm">
              {t('ob.docs.emptyList')}
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
                      {d.i9DocTitle
                        ? catalogTitleLabel(t, d.i9DocTitle)
                        : kindLabel(t, d.kind) ?? d.kind.replace(/_/g, ' ')}
                      {d.i9List ? ` · ${t('ob.docs.listTag', { list: d.i9List })}` : ''}
                      {d.side
                        ? ` · ${d.side === 'FRONT' ? t('ob.docs.frontLower') : t('ob.docs.backLower')}`
                        : ''}
                      {' · '}
                      {fmtSize(d.size)}
                    </div>
                    {d.rejectionReason && (
                      <div className="text-xs text-alert mt-1">
                        {t('ob.docs.rejectionReason', { reason: d.rejectionReason })}
                      </div>
                    )}
                  </div>
                  <Badge
                    size="sm"
                    variant={statusTone(d.status)}
                    data-status={d.status}
                  >
                    {statusLabel(t, d.status)}
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
                      aria-label={t('ob.docs.replaceAria')}
                      title={t('ob.docs.replaceTitle')}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {d.status !== 'VERIFIED' && (
                    <button
                      type="button"
                      onClick={() => onDelete(d)}
                      className="text-alert hover:opacity-80"
                      aria-label={t('ob.docs.removeAria')}
                      title={t('ob.docs.remove')}
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
            {idDocs.length === 1
              ? t('ob.docs.readyOne')
              : t('ob.docs.readyMany', { count: idDocs.length })}
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
              ? t('ob.docs.submitting')
              : canSubmit
                ? next
                  ? t('ob.docs.submitContinue', { label: next.label })
                  : t('ob.docs.submitDone')
                : hasAtLeastOne
                  ? t('ob.docs.stillNeeded')
                  : t('ob.docs.uploadAtLeastOne')}
          </Button>
          <Link to={backTo} className="text-sm text-silver hover:text-white">
            {t('ob.docs.cancel')}
          </Link>
        </div>
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={
          deleteTarget
            ? t('ob.docs.removeConfirmTitle', { name: deleteTarget.filename })
            : t('ob.docs.removeFile')
        }
        description={t('ob.docs.removeConfirmDesc')}
        confirmLabel={t('ob.docs.remove')}
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
      />
      {cropPending && (
        <DocumentCropDialog
          file={cropPending.file}
          initialShape={cropPending.shape}
          onCancel={() => setCropPending(null)}
          onCropped={(standardized) => {
            const target = cropPending.target;
            setCropPending(null);
            void doUpload(standardized, target);
          }}
        />
      )}
    </TaskShell>
  );
}
