import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Camera, CheckCircle2, FileText, Save, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { finishJ1Docs, getJ1Profile, saveJ1Profile } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TaskShell, inputCls, Field, useNextTask } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { fmtSize } from '@/lib/format';
import { statusTone } from '@/lib/status';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

const J1_KIND_OPTIONS: Array<{ value: DocumentKind; label: string }> = [
  { value: 'J1_DS2019', label: 'DS-2019 (Certificate of Eligibility)' },
  { value: 'J1_VISA', label: 'J-1 visa (passport visa page)' },
];

const MAX_BYTES = UPLOAD_MAX_BYTES;
const ACCEPTED_MIMES = 'application/pdf,image/png,image/jpeg,image/webp';


const STATUS_LABEL: Record<string, string> = {
  UPLOADED: 'Awaiting review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

const KIND_LABEL: Record<string, string> = {
  J1_DS2019: 'DS-2019',
  J1_VISA: 'J-1 visa',
};

export function J1DocsTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Two pickers, one handler: `capture` locks iOS to the camera, while a
  // plain input reaches Files/photo library — a DS-2019 is often a PDF.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // J1 profile fields
  const [programStartDate, setProgramStartDate] = useState('');
  const [programEndDate, setProgramEndDate] = useState('');
  const [ds2019Number, setDs2019Number] = useState('');
  const [sponsorAgency, setSponsorAgency] = useState('');
  const [country, setCountry] = useState('');
  const [visaNumber, setVisaNumber] = useState('');
  const [sevisId, setSevisId] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [kind, setKind] = useState<DocumentKind>('J1_DS2019');
  const [uploading, setUploading] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('J1_DOCS');

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

  // Hydrate the saved profile so a revisit (or the checklist's
  // "Review / edit") shows what's on file instead of a blank form with a
  // disabled Finish button — the DS-2019 number, SEVIS ID, and program
  // dates were being retyped from memory, typos overwriting good data.
  useEffect(() => {
    if (!applicationId) return;
    let cancelled = false;
    void getJ1Profile(applicationId)
      .then((r) => {
        if (cancelled || !r.profile) return;
        const p = r.profile;
        setProgramStartDate(p.programStartDate.slice(0, 10));
        setProgramEndDate(p.programEndDate.slice(0, 10));
        setDs2019Number(p.ds2019Number);
        setSponsorAgency(p.sponsorAgency);
        setCountry(p.country);
        setVisaNumber(p.visaNumber ?? '');
        setSevisId(p.sevisId ?? '');
        setProfileSaved(true);
      })
      .catch(() => {
        // Hydration is best-effort — the blank form still works for a
        // first visit; a revisit can re-save.
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  const j1Docs = (docs ?? []).filter(
    (d) => d.kind === 'J1_DS2019' || d.kind === 'J1_VISA'
  );
  const hasAtLeastOneDoc = j1Docs.length > 0;

  const onSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || savingProfile) return;
    if (
      !programStartDate ||
      !programEndDate ||
      !ds2019Number.trim() ||
      !sponsorAgency.trim() ||
      !country.trim()
    ) {
      setError('Fill out all required fields before saving the profile.');
      return;
    }
    setError(null);
    setSavingProfile(true);
    try {
      await saveJ1Profile(applicationId, {
        programStartDate,
        programEndDate,
        ds2019Number: ds2019Number.trim(),
        sponsorAgency: sponsorAgency.trim(),
        country: country.trim(),
        visaNumber: visaNumber.trim() || null,
        sevisId: sevisId.trim() || null,
      });
      setProfileSaved(true);
      toast.success('Program details saved.');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'bad_program_dates') {
        setError('Program end date must be after the start date.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Save failed.');
      }
    } finally {
      setSavingProfile(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`File too large (max ${fmtSize(MAX_BYTES)}).`);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      await uploadMyDocument(file, kind);
      toast.success(`Uploaded ${file.name}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
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
    if (!hasAtLeastOneDoc) {
      setError('Upload at least one DS-2019 or J-1 visa scan before finishing.');
      return;
    }
    setError(null);
    setFinishing(true);
    try {
      await finishJ1Docs(applicationId);
      toast.success('J-1 documents submitted — HR will review them shortly.');
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'no_profile') {
        setError('Save your program details first.');
      } else if (code === 'no_documents') {
        setError('Upload at least one DS-2019 or J-1 visa scan first.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not finish.');
      }
    } finally {
      setFinishing(false);
    }
  };

  return (
    <TaskShell title="J-1 documents" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Two parts: enter your program details, then upload your DS-2019 and
        visa scans. HR will verify everything before payroll setup.
      </p>

      {/* ---------------------------- Step 1: profile fields */}
      <form onSubmit={onSaveProfile} className="space-y-4 mb-6">
        <div className="text-xs uppercase tracking-widest text-silver">
          Step 1 — program details
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Program start date">
            <input
              type="date"
              value={programStartDate}
              onChange={(e) => setProgramStartDate(e.target.value)}
              className={inputCls}
              required
            />
          </Field>
          <Field label="Program end date">
            <input
              type="date"
              value={programEndDate}
              onChange={(e) => setProgramEndDate(e.target.value)}
              className={inputCls}
              required
            />
          </Field>
          <Field label="DS-2019 number">
            <input
              type="text"
              value={ds2019Number}
              onChange={(e) => setDs2019Number(e.target.value)}
              className={inputCls}
              maxLength={40}
              required
            />
          </Field>
          <Field label="Sponsor agency">
            <input
              type="text"
              value={sponsorAgency}
              onChange={(e) => setSponsorAgency(e.target.value)}
              className={inputCls}
              maxLength={120}
              placeholder="e.g. CIEE, InterExchange"
              required
            />
          </Field>
          <Field label="Country of citizenship">
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className={inputCls}
              maxLength={80}
              required
            />
          </Field>
          <Field label="SEVIS ID (optional)">
            <input
              type="text"
              value={sevisId}
              onChange={(e) => setSevisId(e.target.value)}
              className={inputCls}
              maxLength={40}
              placeholder="N#########"
            />
          </Field>
          <Field label="Visa number (optional)">
            <input
              type="text"
              value={visaNumber}
              onChange={(e) => setVisaNumber(e.target.value)}
              className={inputCls}
              maxLength={40}
            />
          </Field>
        </div>
        <Button
          type="submit"
          size="sm"
          loading={savingProfile}
          disabled={savingProfile}
          className={cn(
            profileSaved &&
              !savingProfile &&
              'bg-success/20 text-success border border-success/40 hover:bg-success/25 shadow-none'
          )}
        >
          {profileSaved && !savingProfile ? (
            <>
              <CheckCircle2 className="h-4 w-4" />
              Saved · save again
            </>
          ) : (
            <>
              {!savingProfile && <Save className="h-4 w-4" />}
              {savingProfile ? 'Saving…' : 'Save program details'}
            </>
          )}
        </Button>
      </form>

      {/* ---------------------------- Step 2: documents */}
      <div className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-silver">
          Step 2 — upload documents
        </div>

        <Field label="Document type">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
            disabled={uploading}
          >
            {J1_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

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

        <div>
          <div className="text-xs uppercase tracking-widest text-silver mb-2">
            Uploaded J-1 documents{' '}
            <span className="ml-1 tabular-nums text-silver/70">
              {j1Docs.length}
            </span>
          </div>
          {docs === null ? (
            <SkeletonRows count={2} rowHeight="h-12" />
          ) : j1Docs.length === 0 ? (
            <p className="text-silver text-sm">
              No J-1 documents yet — pick one above.
            </p>
          ) : (
            <ul className="space-y-2">
              {j1Docs.map((d) => (
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
                      {KIND_LABEL[d.kind] ?? d.kind.replace(/_/g, ' ')} ·{' '}
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

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="button"
            onClick={onFinish}
            loading={finishing}
            disabled={!hasAtLeastOneDoc || !profileSaved || finishing}
          >
            {finishing
              ? 'Submitting…'
              : !profileSaved
                ? 'Save program details first'
                : !hasAtLeastOneDoc
                  ? 'Upload at least one document'
                  : next
                    ? `Submit & continue → ${next.label}`
                    : "I'm done — submit for review"}
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
