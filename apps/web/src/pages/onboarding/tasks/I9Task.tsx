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
import { useI18n, type MessageKey } from '@/lib/i18n';
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
const LIST_HEADING: Record<'A' | 'B' | 'C', MessageKey> = {
  A: 'ob.i9.listAHeading',
  B: 'ob.i9.listBHeading',
  C: 'ob.i9.listCHeading',
};

const KIND_LABEL: Record<string, MessageKey> = {
  ID: 'ob.i9.kindId',
  SSN_CARD: 'ob.i9.kindSsnCard',
  I9_SUPPORTING: 'ob.i9.kindSupporting',
  J1_VISA: 'ob.i9.kindJ1Visa',
  J1_DS2019: 'ob.i9.kindJ1Ds2019',
};


const CITIZENSHIP_OPTIONS: { value: CitizenshipStatus; labelKey: MessageKey }[] = [
  { value: 'US_CITIZEN', labelKey: 'ob.i9.citUsCitizen' },
  { value: 'NON_CITIZEN_NATIONAL', labelKey: 'ob.i9.citNonCitizenNational' },
  { value: 'LAWFUL_PERMANENT_RESIDENT', labelKey: 'ob.i9.citLpr' },
  { value: 'ALIEN_AUTHORIZED_TO_WORK', labelKey: 'ob.i9.citAlienAuthorized' },
];

export function I9Task() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useI18n();

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
      setTopError(err instanceof ApiError ? err.message : t('ob.i9.loadFailed'));
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
      <TaskShell title={t('ob.i9.title')} backTo={backTo}>
        <Skeleton className="h-4 w-3/4 mb-5" />
        <SkeletonRows count={3} rowHeight="h-24" />
      </TaskShell>
    );
  }
  if (topError) {
    return (
      <TaskShell title={t('ob.i9.title')} backTo={backTo}>
        <ErrorBanner>{topError}</ErrorBanner>
      </TaskShell>
    );
  }
  if (!applicationId || !status) return null;

  return (
    <TaskShell title={t('ob.i9.title')} backTo={backTo}>
      <p className="text-silver text-sm mb-5">{t('ob.i9.intro')}</p>

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
          {t('ob.i9.backToChecklist')}
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
  const { t } = useI18n();
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
      setError(t('ob.i9.signNameError'));
      return;
    }
    if (needsANumber && !aNumber.trim()) {
      setError(t('ob.i9.aNumberError'));
      return;
    }
    if (needsExpiry && !workAuthExpiresAt) {
      setError(t('ob.i9.expiryError'));
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
      setError(err instanceof ApiError ? err.message : t('ob.i9.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-white">{t('ob.i9.s1Heading')}</h2>
        <span
          className={cn(
            'text-xs uppercase tracking-widest',
            done ? 'text-gold' : 'text-silver/70'
          )}
        >
          {done ? t('ob.i9.signed') : t('ob.i9.required')}
        </span>
      </header>

      {done && status.section1 ? (
        <div className="text-sm text-silver space-y-1">
          <div>
            {t('ob.i9.statusLabel')}{' '}
            <span className="text-white">
              {labelForCitizenship(status.section1.citizenshipStatus, t)}
            </span>
          </div>
          {status.section1.workAuthExpiresAt && (
            <div>
              {t('ob.i9.workAuthExpiresLabel')}{' '}
              <span className="text-white">
                {fmtDate(parseYmd(status.section1.workAuthExpiresAt))}
              </span>
            </div>
          )}
          {status.section1.typedName && (
            <div>
              {t('ob.i9.signedByLabel')}{' '}
              <span className="text-white italic">{status.section1.typedName}</span>
            </div>
          )}
          <div className="text-xs text-silver/70 mt-2">
            {t('ob.i9.signedAt', { time: fmtDateTime(status.section1.completedAt) })}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            label={
              <>
                {t('ob.i9.attest')}
                {document.documentElement.lang === 'es' && (
                  <p className="text-2xs text-silver/60 italic">
                    I attest, under penalty of perjury, that I am:
                  </p>
                )}
              </>
            }
          >
            <Select
              value={citizenshipStatus}
              onChange={(e) => setCitizenshipStatus(e.target.value as CitizenshipStatus)}
            >
              {CITIZENSHIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </option>
              ))}
            </Select>
          </Field>

          {needsANumber && (
            <Field label={t('ob.i9.aNumberLabel')} hint={t('ob.i9.aNumberHint')}>
              <input
                className={inputCls}
                value={aNumber}
                onChange={(e) => setANumber(e.target.value)}
                placeholder={t('ob.i9.aNumberPlaceholder')}
                autoComplete="off"
                aria-label={t('ob.i9.aNumberAria')}
              />
            </Field>
          )}

          {needsExpiry && (
            <Field label={t('ob.i9.workAuthExpiresField')}>
              <input
                type="date"
                className={inputCls}
                value={workAuthExpiresAt}
                onChange={(e) => setWorkAuthExpiresAt(e.target.value)}
              />
            </Field>
          )}

          <Field label={t('ob.i9.signLabel')}>
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
              {submitting ? t('ob.i9.signing') : t('ob.i9.signButton')}
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
  const { t } = useI18n();
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
      setError(err instanceof ApiError ? err.message : t('ob.i9.loadDocsFailed'));
    }
  }, [applicationId, t]);

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
      setError(err instanceof ApiError ? err.message : t('ob.i9.uploadError'));
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
        t('ob.i9.fileTooLarge', {
          size: fmtSize(file.size),
          limit: fmtSize(UPLOAD_MAX_BYTES),
        }),
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
      setError(err instanceof ApiError ? err.message : t('ob.i9.submitError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium text-white">{t('ob.i9.docsHeading')}</h2>
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
            ? t('ob.i9.verifiedByHr')
            : submitted
              ? t('ob.i9.submittedAwaiting')
              : t('ob.i9.required')}
        </span>
      </header>
      <p className="text-sm text-silver mb-4">{t('ob.i9.docsIntro')}</p>

      {!section2Done && !submitted && (
        <>
          {preexistingCount !== null && preexistingCount > 0 && (
            <div className="mb-4 px-3 py-2.5 rounded border border-gold/40 bg-gold/[0.06] text-sm text-silver">
              {preexistingCount === 1
                ? t('ob.i9.preexistingOne', { count: preexistingCount })
                : t('ob.i9.preexistingMany', { count: preexistingCount })}
            </div>
          )}
          <div className="mb-4 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-sm">
            <div className="mb-1.5 font-medium text-white">
              {t('ob.i9.needsHeading')}
            </div>
            <div className={cn('flex items-center gap-2', hasA ? 'text-success' : 'text-silver')}>
              <span aria-hidden>{hasA ? '✓' : '○'}</span>
              {t('ob.i9.needA')}
            </div>
            <div className="my-0.5 pl-5 text-xs text-silver/60">{t('ob.i9.orBoth')}</div>
            <div className={cn('flex items-center gap-2', hasB ? 'text-success' : 'text-silver')}>
              <span aria-hidden>{hasB ? '✓' : '○'}</span>
              {t('ob.i9.needB')}
            </div>
            <div className={cn('flex items-center gap-2', hasC ? 'text-success' : 'text-silver')}>
              <span aria-hidden>{hasC ? '✓' : '○'}</span>
              {t('ob.i9.needC')}
            </div>
            {hasUnclassified && (
              <div className="mt-1.5 text-xs text-silver/70">
                {t('ob.i9.unclassifiedNote')}
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <Field label={t('ob.i9.whichDoc')}>
              <Select
                value={docTitle}
                onChange={(e) => {
                  setDocTitle(e.target.value);
                  setDocSide('');
                }}
                disabled={uploading}
              >
                {(['A', 'B', 'C'] as const).map((list) => (
                  <optgroup key={list} label={t(LIST_HEADING[list])}>
                    {I9_DOC_CATALOG.filter((c) => c.list === list).map((c) => (
                      <option key={c.title} value={c.title}>
                        {c.title}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <optgroup label={t('ob.i9.somethingElse')}>
                  <option value={OTHER_VALUE}>{t('ob.i9.kindSupporting')}</option>
                  <option value={J1_VISA_VALUE}>{t('ob.i9.kindJ1Visa')}</option>
                  <option value={J1_DS2019_VALUE}>{t('ob.i9.kindJ1Ds2019')}</option>
                </optgroup>
              </Select>
            </Field>
            {selectedEntry?.card && (
              <Field
                label={t('ob.i9.whichSide')}
                hint={t('ob.i9.sideHint')}
              >
                <Select
                  value={docSide}
                  onChange={(e) => setDocSide(e.target.value as I9DocumentSide | '')}
                  disabled={uploading}
                >
                  <option value="">{t('ob.i9.sideNone')}</option>
                  <option value="FRONT">{t('ob.i9.front')}</option>
                  <option value="BACK">{t('ob.i9.back')}</option>
                </Select>
              </Field>
            )}
          </div>
          {docTitle === 'Social Security card (unrestricted)' && (
            <p className="-mt-1 mb-3 text-xs text-warning">
              {t('ob.i9.ssnRestriction')}
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
                {uploading ? t('ob.i9.uploading') : t('ob.i9.takePhoto')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? t('ob.i9.uploading') : t('ob.i9.chooseFile')}
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
                    {t('ob.i9.uploadFailedKept')}
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
                  {t('ob.i9.retryUpload')}
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
                  {t('ob.i9.chooseDifferent')}
                </button>
              </div>
            )}
            {error && <ErrorBanner className="mt-2">{error}</ErrorBanner>}
          </div>
        </>
      )}

      {submitted && !section2Done && (
        <div className="mb-4 px-3 py-2.5 rounded border border-success/40 bg-success/[0.06] text-sm text-silver">
          {t('ob.i9.submittedOn')}{' '}
          <span className="text-white">
            {fmtDateTime(status.documentsSubmittedAt)}
          </span>
          .{' '}
          {t('ob.i9.submittedTail')}
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
                  {d.i9DocTitle ?? (KIND_LABEL[d.kind] ? t(KIND_LABEL[d.kind]) : d.kind)}
                  {d.i9List ? ` · ${t('ob.i9.listN', { list: d.i9List })}` : ''}
                  {d.side ? ` · ${d.side === 'FRONT' ? t('ob.i9.front') : t('ob.i9.back')}` : ''}
                  {' · '}
                  {fmtSize(d.size)}
                  {!d.fileAvailable && (
                    <span className="text-alert"> · {t('ob.i9.fileMissing')}</span>
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
                  ? t('ob.i9.statusVerified')
                  : d.status === 'REJECTED'
                    ? t('ob.i9.statusRejected')
                    : t('ob.i9.statusAwaiting')}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-silver/70">
          {t('ob.i9.noDocs')}
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
            {submitting ? t('ob.i9.submitting') : t('ob.i9.submitForReview')}
          </Button>
          {!canSubmit && (
            <span className="text-xs text-silver/70">
              {!section1Done
                ? t('ob.i9.gateSign1')
                : docCount === 0
                  ? t('ob.i9.gateUpload')
                  : !combinationOk
                    ? t('ob.i9.gateCombo')
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
  const { t } = useI18n();
  const s2 = status.section2;
  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5">
      <header className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-medium text-white">{t('ob.i9.s2Heading')}</h2>
        <span
          className={cn(
            'text-xs uppercase tracking-widest',
            s2 ? 'text-gold' : 'text-silver/70'
          )}
        >
          {s2 ? t('ob.i9.statusVerified') : t('ob.i9.pendingHr')}
        </span>
      </header>
      {s2 ? (
        <div className="text-sm text-silver">
          {t('ob.i9.verifiedAt', { time: fmtDateTime(s2.completedAt) })}
          {s2.verifierEmail && (
            <>
              {' '}{t('ob.i9.by')} <span className="text-white">{s2.verifierEmail}</span>
            </>
          )}
          .
          {s2.documentList && (
            <span className="block text-xs text-silver/70 mt-1">
              {s2.documentList === 'LIST_A' ? t('ob.i9.s2ListA') : t('ob.i9.s2ListBC')}
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-silver">
          {t('ob.i9.s2Pending')}
        </p>
      )}
    </section>
  );
}

function labelForCitizenship(
  c: CitizenshipStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const key = CITIZENSHIP_OPTIONS.find((o) => o.value === c)?.labelKey;
  return key ? t(key) : c;
}
