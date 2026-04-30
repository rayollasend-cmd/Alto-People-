import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileSignature } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  listEsignAgreements,
  signEsignAgreement,
  type EsignAgreement,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { Field, TaskShell, inputCls } from './ProfileInfoTask';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * E-sign task — the associate reads each HR-drafted agreement (the auto-issued
 * Alto HR Employment Agreement plus any housing addenda or NDAs HR added) in
 * full, types their full legal name, and signs. Mirrors the scroll-to-end gate
 * from PolicyAckTask so "I didn't see what I was signing" stops being a
 * defense — the typed-name field only enables after the body is read.
 */
export function EsignTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const [agreements, setAgreements] = useState<EsignAgreement[] | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const r = await listEsignAgreements(applicationId);
      setAgreements(r.agreements);
    } catch (err) {
      setTopError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [applicationId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!applicationId) return null;

  const allSigned =
    !!agreements && agreements.length > 0 && agreements.every((a) => a.signedAt);

  return (
    <TaskShell title="Document e-signatures" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Read each agreement in full, then type your full legal name to sign.
        Each signed copy is stored as a stamped PDF in your permanent
        employment record.
      </p>

      {topError && (
        <p role="alert" className="text-sm text-alert mb-4">
          {topError}
        </p>
      )}

      {!agreements && (
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/2" />
          <SkeletonRows count={2} rowHeight="h-40" />
        </div>
      )}

      {agreements && agreements.length === 0 && (
        <EmptyState
          icon={FileSignature}
          title="No agreements to sign"
          description="HR hasn't drafted any agreements for this onboarding yet."
        />
      )}

      {agreements && agreements.length > 0 && (
        <ul className="space-y-5">
          {agreements.map((a) => (
            <AgreementCard
              key={a.id}
              applicationId={applicationId}
              agreement={a}
              onSigned={refresh}
            />
          ))}
        </ul>
      )}

      {allSigned && (
        <div className="mt-6 flex items-center gap-2 px-3 py-2.5 rounded border border-success/40 bg-success/[0.06] text-sm text-silver">
          <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
          All agreements signed. You can close this page.
        </div>
      )}
    </TaskShell>
  );
}

function AgreementCard({
  applicationId,
  agreement,
  onSigned,
}: {
  applicationId: string;
  agreement: EsignAgreement;
  onSigned: () => void;
}) {
  const signed = agreement.signedAt !== null;
  const [typedName, setTypedName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [scrolledToEnd, setScrolledToEnd] = useState(signed);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Short bodies that don't scroll → treat as "read" immediately, otherwise
  // the Sign button can never enable.
  useEffect(() => {
    if (signed) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 4) {
      setScrolledToEnd(true);
    }
  }, [agreement.body, signed]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= 24) setScrolledToEnd(true);
  };

  const canSign = !signed && scrolledToEnd && typedName.trim().length >= 2;

  const handleSign = async () => {
    if (!canSign || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await signEsignAgreement(applicationId, agreement.id, {
        typedName: typedName.trim(),
      });
      onSigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Signature failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <li
      className={cn(
        'rounded-lg border bg-navy',
        signed ? 'border-gold/40' : 'border-navy-secondary'
      )}
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileSignature
            className={cn('h-4 w-4 shrink-0', signed ? 'text-gold' : 'text-silver')}
          />
          <h2 className="text-base font-medium text-white truncate">
            {agreement.title}
          </h2>
        </div>
        <span
          className={cn(
            'text-xs uppercase tracking-widest shrink-0',
            signed ? 'text-gold' : 'text-silver/60'
          )}
        >
          {signed ? 'Signed' : 'Required'}
        </span>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="mx-5 mt-1 max-h-96 overflow-y-auto px-3 py-2 text-sm text-silver whitespace-pre-wrap leading-relaxed bg-navy-secondary/20 rounded border border-navy-secondary"
      >
        {agreement.body}
      </div>

      {signed ? (
        <div className="px-5 pt-3 pb-4 text-sm text-silver">
          Signed {new Date(agreement.signedAt!).toLocaleString()}
          {' · '}
          <a
            href={`/api/onboarding/esign/signatures/${agreement.signatureId}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold hover:text-gold-bright"
          >
            Download signed PDF
          </a>
        </div>
      ) : (
        <div className="px-5 pt-3 pb-4 space-y-3">
          <div
            className={cn(
              'text-xs flex items-center gap-1.5',
              scrolledToEnd ? 'text-success' : 'text-silver/60'
            )}
          >
            {scrolledToEnd ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Read in full — type your name below to sign
              </>
            ) : (
              'Scroll to the bottom of the agreement to enable signing'
            )}
          </div>

          <Field label="Type your full legal name (acts as your signature)">
            <input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              className={inputCls}
              placeholder="First Last"
              autoComplete="name"
              disabled={!scrolledToEnd || submitting}
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={handleSign}
              loading={submitting}
              disabled={!canSign || submitting}
            >
              {submitting ? 'Signing…' : 'Sign agreement'}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
