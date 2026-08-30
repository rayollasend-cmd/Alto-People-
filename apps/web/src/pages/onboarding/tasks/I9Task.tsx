import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import {
  getI9Status,
  listI9Documents,
  submitI9ForReview,
  submitI9Section1,
  uploadI9Document,
  type CitizenshipStatus,
  type I9DocumentListItem,
  type I9Status,
} from '@/lib/i9Api';
import {
  I9_DOC_CATALOG,
  UPLOAD_ACCEPT_ATTR,
  UPLOAD_MAX_BYTES,
  i9CatalogEntry,
  i9SetSatisfied,
} from '@alto-people/shared';
import { fmtDate, fmtDateTime, fmtSize, parseYmd } from '@/lib/format';
import { Field, TaskShell, inputCls, useNextTask } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';

type I9DocumentKind = 'ID' | 'SSN_CARD' | 'I9_SUPPORTING' | 'J1_VISA' | 'J1_DS2019';
type I9DocumentSide = 'FRONT' | 'BACK';

// Same federal picker as the Documents task — the associate names the exact
// document so HR isn't guessing from thumbnails at Section 2. The non-catalog
// values keep this flow's extra buckets (J-1 papers, unusual documents);
// those upload unclassified, exactly like the pre-catalog behavior.
const OTHER_VALUE = '__other__';
const J1_VISA_VALUE = '__j1_visa__';
const J1_DS2019_VALUE = '__j1_ds2019__';
const SPECIAL_KIND: Record<string, I9DocumentKind> = {
  [OTHER_VALUE]: 'I9_SUPPORTING',
  [J1_VISA_VALUE]: 'J1_VISA',
  [J1_DS2019_VALUE]: 'J1_DS2019',
};
const LIST_HEADING: Record<'A' | 'B' | 'C', string> = {
  A: 'List A — proves identity AND right to work (one is enough)',
  B: 'List B — proves identity only (also add one from List C)',
  C: 'List C — proves right to work only (also add one from List B)',
};

const KIND_LABEL: Record<string, string> = {
  ID: 'Driver license / passport / state ID',
  SSN_CARD: 'Social Security card',
  I9_SUPPORTING: 'Other I-9 supporting document',
  J1_VISA: 'J-1 visa',
  J1_DS2019: 'J-1 DS-2019',
};


const CITIZENSHIP_OPTIONS: { value: CitizenshipStatus; label: string }[] = [
  { value: 'US_CITIZEN', label: 'A citizen of the United States' },
  { value: 'NON_CITIZEN_NATIONAL', label: 'A non-citizen national of the United States' },
  { value: 'LAWFUL_PERMANENT_RESIDENT', label: 'A lawful permanent resident' },
  { value: 'ALIEN_AUTHORIZED_TO_WORK', label: 'An alien authorized to work' },
];

export function I9Task() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('I9_VERIFICATION');

  const [status, setStatus] = useState<I9Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [topError, setTopError] = useState<string | null>(null);

  const refresh = async () => {
    if (!applicationId) return;
    try {
      setStatus(await getI9Status(applicationId));
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message : 'Failed to load I-9 status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId]);

  if (loading) {
    return (
      <TaskShell title="I-9 verification" backTo={backTo}>
        <Skeleton className="h-4 w-3/4 mb-5" />
        <SkeletonRows count={3} rowHeight="h-24" />
      </TaskShell>
    );
  }
  if (topError) {
    return (
      <TaskShell title="I-9 verification" backTo={backTo}>
        <ErrorBanner>{topError}</ErrorBanner>
      </TaskShell>
    );
  }
  if (!applicationId || !status) return null;

  return (
    <TaskShell title="I-9 verification" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Federal Form I-9 verifies you can legally work in the United States.
        Section 1 below is your self-attestation; HR will verify your documents
        in Section 2 once you upload them.
      </p>

      <Section1Card
        applicationId={applicationId}
        status={status}
        onChanged={refresh}
      />
      <DocumentsCard
        applicationId={applicationId}
        status={status}
        onChanged={refresh}
        onSubmitted={() => navigate(next?.route ?? backTo, { replace: true })}
      />
      <Section2Status status={status} />

      <div className="mt-6">
        <Link to={backTo} className="text-sm text-silver hover:text-white">
          ← Back to checklist
        </Link>
      </div>
    </TaskShell>
  );
}

/* ===== Section 1 ======================================================== */

function Section1Card({
  applicationId,
  status,
  onChanged,
}: {
  applicationId: string;
  status: I9Status;
  onChanged: () => void;
}) {
  const done = status.section1 !== null;
  const [citizenshipStatus, setCitizenshipStatus] = useState<CitizenshipStatus>(
    status.section1?.citizenshipStatus ?? 'US_CITIZEN'
  );
  const [aNumber, setANumber] = useState('');
  const [workAuthExpiresAt, setWorkAuthExpiresAt] = useState(
    status.section1?.workAuthExpiresAt ?? ''
  );
  const [typedName, setTypedName] = useState(status.section1?.typedName ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsANumber =
    citizenshipStatus === 'LAWFUL_PERMANENT_RESIDENT' ||
    citizenshipStatus === 'ALIEN_AUTHORIZED_TO_WORK';
  const needsExpiry = citizenshipStatus === 'ALIEN_AUTHORIZED_TO_WORK';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (typedName.trim().length < 2) {
      setError('Type your full legal name to sign.');
      return;
    }
    if (needsANumber && !aNumber.trim()) {
      setError('Alien Registration Number (A-Number) is required for this status.');
      return;
    }
    if (needsExpiry && !workAuthExpiresAt) {
      setError('Work authorization expiration date is required.');
      return;
    }
    setSubmitting(true);
    try {
      await submitI9Section1(applicationId, {
        citizenshipStatus,
        typedName: typedName.trim(),
        ...(needsANumber && aNumber.trim() ? { alienRegistrationNumber: aNumber.trim() } : {}),
        ...(needsExpiry && workAuthExpiresAt ? { workAuthExpiresAt } : {}),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-white">Section 1 — your attestation</h2>
        <span
          className={cn(
            'text-xs uppercase tracking-widest',
            done ? 'text-gold' : 'text-silver/70'
          )}
        >
          {done ? 'Signed' : 'Required'}
        </span>
      </header>

      {done && status.section1 ? (
        <div className="text-sm text-silver space-y-1">
          <div>
            Status:{' '}
            <span className="text-white">
              {labelForCitizenship(status.section1.citizenshipStatus)}
            </span>
          </div>
          {status.section1.workAuthExpiresAt && (
            <div>
              Work auth expires:{' '}
              <span className="text-white">
                {fmtDate(parseYmd(status.section1.workAuthExpiresAt))}
              </span>
            </div>
          )}
          {status.section1.typedName && (
            <div>
              Signed by:{' '}
              <span className="text-white italic">{status.section1.typedName}</span>
            </div>
          )}
          <div className="text-xs text-silver/70 mt-2">
            Signed at {fmtDateTime(status.section1.completedAt)}.
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="I attest, under penalty of perjury, that I am:">
            <Select
              value={citizenshipStatus}
              onChange={(e) => setCitizenshipStatus(e.target.value as CitizenshipStatus)}
            >
              {CITIZENSHIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {needsANumber && (
            <Field label="Alien Registration / USCIS Number" hint="Begins with the letter A.">
              <input
                className={inputCls}
                value={aNumber}
                onChange={(e) => setANumber(e.target.value)}
                placeholder="A123456789"
                autoComplete="off"
                aria-label="Alien Registration Number"
              />
            </Field>
          )}

          {needsExpiry && (
            <Field label="Work authorization expires">
              <input
                type="date"
                className={inputCls}
                value={workAuthExpiresAt}
                onChange={(e) => setWorkAuthExpiresAt(e.target.value)}
              />
            </Field>
          )}

          <Field label="Type your full legal name to sign">
            <input
              className={inputCls}
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              autoComplete="name"
            />
          </Field>

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" loading={submitting} disabled={submitting}>
              {submitting ? 'Signing…' : 'Sign Section 1'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/* ===== Documents (mobile camera capture) ================================ */

function DocumentsCard({
  applicationId,
  status,
  onChanged,
  onSubmitted,
}: {
  applicationId: string;
  status: I9Status;
  onChanged: () => void;
  /** Fires after submit-for-review succeeds — the task's final action. */
  onSubmitted: () => void;
}) {
  const [docs, setDocs] = useState<I9DocumentListItem[] | null>(null);
  // Doc count from the FIRST fetch this session — i.e. before any upload
  // made here. Non-zero means identity documents already exist in the shared
  // vault (same records as the Documents task), so tell the associate they
  // can just submit those.
  const [preexistingCount, setPreexistingCount] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two pickers, one handler: `capture` locks iOS to the camera, so a
  // camera-only input made a passport PDF sitting in email unselectable.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // A failed upload keeps its File (and the classification chosen at pick
  // time) so "Retry" needs no trip back into the camera roll.
  const [failedUpload, setFailedUpload] = useState<{
    file: File;
    kind: I9DocumentKind;
    side: I9DocumentSide | undefined;
    title: string | undefined;
  } | null>(null);
  const [docTitle, setDocTitle] = useState<string>(I9_DOC_CATALOG[0].title);
  const [docSide, setDocSide] = useState<I9DocumentSide | ''>('');
  const section2Done = status.section2 !== null;
  const section1Done = status.section1 !== null;
  const submitted = status.documentsSubmittedAt !== null;
  const docCount = docs?.length ?? 0;

  const selectedEntry = i9CatalogEntry(docTitle);
  const selectedKind: I9DocumentKind =
    selectedEntry?.kind ?? SPECIAL_KIND[docTitle] ?? 'I9_SUPPORTING';

  // Live federal-requirement meter, mirroring the server's submit gate:
  // List A alone, or B + C. Unclassified uploads (legacy, "Other", J-1
  // papers) keep submit open — HR classifies those at review.
  const usable = (docs ?? []).filter((d) => d.status !== 'REJECTED');
  const hasA = usable.some((d) => d.i9List === 'A');
  const hasB = usable.some((d) => d.i9List === 'B');
  const hasC = usable.some((d) => d.i9List === 'C');
  const hasUnclassified = usable.some((d) => d.i9List == null);
  const combinationOk =
    i9SetSatisfied(usable.map((d) => d.i9List)) || hasUnclassified;
  const canSubmit =
    section1Done && docCount > 0 && combinationOk && !submitted && !section2Done;

  // Hydrate from the server so the list survives a page reload — fixes the
  // "where did my upload go?" gap from the prior version that only kept
  // uploads in local React state.
  const refresh = useCallback(async () => {
    try {
      const r = await listI9Documents(applicationId);
      setDocs(r.documents);
      setPreexistingCount((cur) => cur ?? r.documents.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load documents.');
    }
  }, [applicationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doUpload = async (
    file: File,
    kind: I9DocumentKind,
    side: I9DocumentSide | undefined,
    title: string | undefined,
  ) => {
    setError(null);
    setUploading(true);
    try {
      await uploadI9Document(applicationId, file, kind, side, title);
      setFailedUpload(null);
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
      setFailedUpload({ file, kind, side, title });
    } finally {
      setUploading(false);
    }
  };

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    // Size checked here, like every sibling upload task: without it an
    // oversized phone photo hit multer's limit and surfaced as a 500.
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(
        `That file is ${fmtSize(file.size)} — the limit is ${fmtSize(UPLOAD_MAX_BYTES)}. Try a smaller photo or a compressed PDF.`,
      );
      return;
    }
    await doUpload(
      file,
      selectedKind,
      selectedEntry?.card && docSide !== '' ? docSide : undefined,
      selectedEntry?.title,
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitI9ForReview(applicationId);
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submit failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium text-white">Identification documents</h2>
        <span
          className={cn(
            'text-xs uppercase tracking-widest',
            section2Done
              ? 'text-gold'
              : submitted
                ? 'text-success'
                : 'text-silver/70'
          )}
        >
          {section2Done
            ? 'Verified by HR'
            : submitted
              ? 'Submitted — awaiting HR'
              : 'Required'}
        </span>
      </header>
      <p className="text-sm text-silver mb-4">
        Add your identification (driver's license, passport, Social Security
        card, etc.) — "Take photo" opens the camera, "Choose file" picks a
        saved scan or PDF. Pick the document type and front/back before
        uploading so HR can verify quickly. PDF / JPG / PNG / WEBP up to
        10 MB.
      </p>

      {!section2Done && !submitted && (
        <>
          {preexistingCount !== null && preexistingCount > 0 && (
            <div className="mb-4 px-3 py-2.5 rounded border border-gold/40 bg-gold/[0.06] text-sm text-silver">
              {preexistingCount} identity document
              {preexistingCount === 1 ? '' : 's'} already on file from your
              Documents step — you can submit these for review or add more.
            </div>
          )}
          <div className="mb-4 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm">
            <div className="mb-1.5 font-medium text-white">
              What the I-9 form needs
            </div>
            <div className={cn('flex items-center gap-2', hasA ? 'text-success' : 'text-silver')}>
              <span aria-hidden>{hasA ? '✓' : '○'}</span>
              ONE List A document (passport, Green Card…)
            </div>
            <div className="my-0.5 pl-5 text-xs text-silver/60">— or both of —</div>
            <div className={cn('flex items-center gap-2', hasB ? 'text-success' : 'text-silver')}>
              <span aria-hidden>{hasB ? '✓' : '○'}</span>
              One List B document (driver&apos;s license, state ID…)
            </div>
            <div className={cn('flex items-center gap-2', hasC ? 'text-success' : 'text-silver')}>
              <span aria-hidden>{hasC ? '✓' : '○'}</span>
              One List C document (unrestricted Social Security card, birth certificate…)
            </div>
            {hasUnclassified && (
              <div className="mt-1.5 text-xs text-silver/70">
                Some documents have no type — HR will classify them at
                review, so you can still submit.
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Field label="Which document is this?">
              <Select
                value={docTitle}
                onChange={(e) => {
                  setDocTitle(e.target.value);
                  setDocSide('');
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
                  <option value={J1_VISA_VALUE}>J-1 visa</option>
                  <option value={J1_DS2019_VALUE}>J-1 DS-2019</option>
                </optgroup>
              </Select>
            </Field>
            {selectedEntry?.card && (
              <Field
                label="Which side of the card?"
                hint="Leave blank if one photo shows everything."
              >
                <Select
                  value={docSide}
                  onChange={(e) => setDocSide(e.target.value as I9DocumentSide | '')}
                  disabled={uploading}
                >
                  <option value="">— One photo shows everything —</option>
                  <option value="FRONT">Front</option>
                  <option value="BACK">Back</option>
                </Select>
              </Field>
            )}
          </div>
          {docTitle === 'Social Security card (unrestricted)' && (
            <p className="-mt-1 mb-3 text-xs text-warning">
              If your card is printed with a restriction like &ldquo;VALID FOR
              WORK ONLY WITH DHS AUTHORIZATION&rdquo;, it does NOT count as a
              List C document — pick &ldquo;Other I-9 supporting
              document&rdquo; instead and add a different List C document.
            </p>
          )}
          <div className="mb-4">
            {/* The server's exact allowlist, not `image/*`: iPhones shoot
                HEIC by default, which passed this picker and was then
                rejected on upload. Every sibling task already offers
                precisely what the server accepts. */}
            <input
              ref={cameraInputRef}
              type="file"
              accept={UPLOAD_ACCEPT_ATTR}
              capture="environment"
              className="hidden"
              onChange={handlePick}
              disabled={uploading}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOAD_ACCEPT_ATTR}
              className="hidden"
              onChange={handlePick}
              disabled={uploading}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading…' : 'Take photo'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading…' : 'Choose file'}
              </Button>
            </div>
            {failedUpload && !uploading && (
              <div
                role="alert"
                className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded border border-alert/40 bg-alert/[0.06] text-sm"
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
                  onClick={() =>
                    doUpload(
                      failedUpload.file,
                      failedUpload.kind,
                      failedUpload.side,
                      failedUpload.title,
                    )
                  }
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry upload
                </Button>
                <button
                  type="button"
                  onClick={() => {
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
            {error && <ErrorBanner className="mt-2">{error}</ErrorBanner>}
          </div>
        </>
      )}

      {submitted && !section2Done && (
        <div className="mb-4 px-3 py-2.5 rounded border border-success/40 bg-success/[0.06] text-sm text-silver">
          Submitted on{' '}
          <span className="text-white">
            {fmtDateTime(status.documentsSubmittedAt)}
          </span>
          . HR will verify your documents and complete Section 2. You can close this page — you'll be notified when verification is complete.
        </div>
      )}

      {docs === null ? (
        <SkeletonRows count={2} rowHeight="h-10" />
      ) : docs.length > 0 ? (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li
              key={d.id}
              className="text-sm bg-navy-secondary/40 border border-navy-secondary rounded px-3 py-2 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-white truncate">{d.filename}</div>
                <div className="text-xs text-silver/70 mt-0.5">
                  {d.i9DocTitle ?? KIND_LABEL[d.kind] ?? d.kind}
                  {d.i9List ? ` · List ${d.i9List}` : ''}
                  {d.side ? ` · ${d.side === 'FRONT' ? 'Front' : 'Back'}` : ''}
                  {' · '}
                  {fmtSize(d.size)}
                  {!d.fileAvailable && (
                    <span className="text-alert"> · file missing — please re-upload</span>
                  )}
                </div>
              </div>
              <Badge
                size="sm"
                variant={
                  d.status === 'VERIFIED'
                    ? 'success'
                    : d.status === 'REJECTED'
                      ? 'destructive'
                      : 'pending'
                }
              >
                {d.status === 'VERIFIED'
                  ? 'Verified'
                  : d.status === 'REJECTED'
                    ? 'Rejected'
                    : 'Awaiting review'}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-silver/70">
          No documents uploaded yet.
        </p>
      )}

      {!section2Done && !submitted && (
        <div className="mt-5 pt-4 border-t border-navy-secondary flex items-center gap-3">
          <Button
            type="button"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!canSubmit || submitting}
          >
            {submitting ? 'Submitting…' : 'Submit for HR review'}
          </Button>
          {!canSubmit && (
            <span className="text-xs text-silver/70">
              {!section1Done
                ? 'Sign Section 1 first.'
                : docCount === 0
                  ? 'Upload at least one document first.'
                  : !combinationOk
                    ? 'Add ONE List A document, or one from List B plus one from List C.'
                    : ''}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/* ===== Section 2 status (read-only on the associate side) =============== */

function Section2Status({ status }: { status: I9Status }) {
  const s2 = status.section2;
  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5">
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-medium text-white">Section 2 — HR verification</h2>
        <span
          className={cn(
            'text-xs uppercase tracking-widest',
            s2 ? 'text-gold' : 'text-silver/70'
          )}
        >
          {s2 ? 'Verified' : 'Pending HR'}
        </span>
      </header>
      {s2 ? (
        <div className="text-sm text-silver">
          Verified at {fmtDateTime(s2.completedAt)}
          {s2.verifierEmail && (
            <>
              {' '}by <span className="text-white">{s2.verifierEmail}</span>
            </>
          )}
          .
          {s2.documentList && (
            <span className="block text-xs text-silver/70 mt-1">
              List: {s2.documentList === 'LIST_A' ? 'List A (single document)' : 'Lists B + C'}
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-silver">
          HR will review your documents and complete Section 2. You can close
          this page after Section 1 is signed and your photos are uploaded.
        </p>
      )}
    </section>
  );
}

function labelForCitizenship(c: CitizenshipStatus): string {
  return CITIZENSHIP_OPTIONS.find((o) => o.value === c)?.label ?? c;
}
