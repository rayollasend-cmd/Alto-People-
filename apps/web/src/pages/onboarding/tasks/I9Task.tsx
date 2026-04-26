import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import {
  getI9Status,
  submitI9Section1,
  uploadI9Document,
  type CitizenshipStatus,
  type I9DocumentMeta,
  type I9Status,
} from '@/lib/i9Api';
import { Field, TaskShell, inputCls } from './ProfileInfoTask';
import { cn } from '@/lib/cn';

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
        <p className="text-silver">Loading…</p>
      </TaskShell>
    );
  }
  if (topError) {
    return (
      <TaskShell title="I-9 verification" backTo={backTo}>
        <p className="text-alert">{topError}</p>
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
      />
      <Section2Status status={status} />

      <div className="mt-6">
        <Link to={backTo} className="text-sm text-silver hover:text-white">
          ← Back to checklist
        </Link>
      </div>
    </TaskShell>
  );

  // Unused but keeps the navigate import alive when the component grows.
  void navigate;
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
            done ? 'text-gold' : 'text-silver/60'
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
              <span className="text-white">{status.section1.workAuthExpiresAt}</span>
            </div>
          )}
          {status.section1.typedName && (
            <div>
              Signed by:{' '}
              <span className="text-white italic">{status.section1.typedName}</span>
            </div>
          )}
          <div className="text-xs text-silver/60 mt-2">
            Signed at {new Date(status.section1.completedAt).toLocaleString()}.
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="I attest, under penalty of perjury, that I am:">
            <select
              className={inputCls}
              value={citizenshipStatus}
              onChange={(e) => setCitizenshipStatus(e.target.value as CitizenshipStatus)}
            >
              {CITIZENSHIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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

          {error && <p className="text-sm text-alert">{error}</p>}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className={cn(
                'px-5 py-2.5 rounded font-medium transition',
                submitting
                  ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
                  : 'bg-gold text-navy hover:bg-gold-bright'
              )}
            >
              {submitting ? 'Signing…' : 'Sign Section 1'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/* ===== Documents (mobile camera capture) ================================ */

interface UploadedDoc extends I9DocumentMeta {
  filename: string;
}

function DocumentsCard({
  applicationId,
  status,
  onChanged,
}: {
  applicationId: string;
  status: I9Status;
  onChanged: () => void;
}) {
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const section2Done = status.section2 !== null;

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const result = await uploadI9Document(applicationId, file, 'I9_SUPPORTING');
      setDocs((d) => [...d, { ...result, filename: file.name }]);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium text-white">Identification documents</h2>
        <span className="text-xs text-silver/60">
          {section2Done ? 'Verified by HR' : 'Optional until HR reviews'}
        </span>
      </header>
      <p className="text-sm text-silver mb-4">
        Take photos of your identification (driver's license, passport,
        Social Security card, etc.). On a phone, the camera opens directly.
        On a computer, choose the file. PDF / JPG / PNG / WEBP up to 10 MB.
      </p>

      {!section2Done && (
        <div className="mb-4">
          <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded bg-gold text-navy hover:bg-gold-bright cursor-pointer transition">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              className="hidden"
              onChange={handlePick}
              disabled={uploading}
            />
            <span className="font-medium">
              {uploading ? 'Uploading…' : 'Take or upload photo'}
            </span>
          </label>
          {error && <p className="text-sm text-alert mt-2">{error}</p>}
        </div>
      )}

      {docs.length > 0 ? (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li
              key={d.documentId}
              className="text-sm bg-navy-secondary/40 border border-navy-secondary rounded px-3 py-2"
            >
              <div className="text-white truncate">{d.filename}</div>
              <div className="text-xs text-silver/60 mt-0.5">
                {(d.size / 1024).toFixed(1)} KB · {d.mimeType} · sha256 {d.sha256.slice(0, 12)}…
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-silver/60">
          No documents uploaded yet from this device.
        </p>
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
            s2 ? 'text-gold' : 'text-silver/60'
          )}
        >
          {s2 ? 'Verified' : 'Pending HR'}
        </span>
      </header>
      {s2 ? (
        <div className="text-sm text-silver">
          Verified at {new Date(s2.completedAt).toLocaleString()}
          {s2.verifierEmail && (
            <>
              {' '}by <span className="text-white">{s2.verifierEmail}</span>
            </>
          )}
          .
          {s2.documentList && (
            <span className="block text-xs text-silver/60 mt-1">
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
