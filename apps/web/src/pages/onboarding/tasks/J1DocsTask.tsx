import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, FileText, Save, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentKind, DocumentRecord } from '@alto-people/shared';
import {
  deleteMyDocument,
  listMyDocuments,
  uploadMyDocument,
} from '@/lib/documentsApi';
import { finishJ1Docs, saveJ1Profile } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { TaskShell, inputCls, Field } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

const J1_KIND_OPTIONS: Array<{ value: DocumentKind; label: string }> = [
  { value: 'J1_DS2019', label: 'DS-2019 (Certificate of Eligibility)' },
  { value: 'J1_VISA', label: 'J-1 visa (passport visa page)' },
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

export function J1DocsTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
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
      toast.success('Program details saved');
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

  const onPickFile = () => fileInputRef.current?.click();

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
      toast.success(`Uploaded ${file.name}`);
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
      toast.error('Could not remove', {
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
      navigate(backTo, { replace: true });
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
        <button
          type="submit"
          disabled={savingProfile}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded font-medium transition text-sm',
            savingProfile
              ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
              : profileSaved
                ? 'bg-success/20 text-success border border-success/40'
                : 'bg-gold text-navy hover:bg-gold-bright'
          )}
        >
          {profileSaved ? (
            <>
              <CheckCircle2 className="h-4 w-4" />
              Saved · save again
            </>
          ) : (
            <>
              <Save className="h-4 w-4" />
              {savingProfile ? 'Saving…' : 'Save program details'}
            </>
          )}
        </button>
      </form>

      {/* ---------------------------- Step 2: documents */}
      <div className="space-y-4">
        <div className="text-xs uppercase tracking-widest text-silver">
          Step 2 — upload documents
        </div>

        <Field label="Document type">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
            className={inputCls}
            disabled={uploading}
          >
            {J1_KIND_OPTIONS.map((o) => (
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

        <div>
          <div className="text-xs uppercase tracking-widest text-silver mb-2">
            Uploaded J-1 documents{' '}
            <span className="ml-1 tabular-nums text-silver/60">
              {j1Docs.length}
            </span>
          </div>
          {docs === null ? (
            <p className="text-silver text-sm">Loading…</p>
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

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onFinish}
            disabled={!hasAtLeastOneDoc || !profileSaved || finishing}
            className={cn(
              'px-5 py-2.5 rounded font-medium transition',
              !hasAtLeastOneDoc || !profileSaved || finishing
                ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                : 'bg-gold text-navy hover:bg-gold-bright'
            )}
          >
            {finishing
              ? 'Submitting…'
              : !profileSaved
                ? 'Save program details first'
                : !hasAtLeastOneDoc
                  ? 'Upload at least one document'
                  : "I'm done — submit for review"}
          </button>
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
