import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileSignature } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { acceptOfferLetter, declineOfferLetter, getOfferLetter } from '@/lib/recruiting90Api';
import { fmtDate } from '@/lib/format';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * A candidate's offer, read and signed.
 *
 * An offer used to be a plain-text email, and "accepting" meant replying
 * and a recruiter clicking Accepted on their behalf — nothing was signed.
 * The offer email now carries this private link: the letter in full, and
 * acceptance by typed signature, which becomes a signed PDF with the time,
 * IP and browser on it. No login — the link is the key, and it retires
 * once used.
 */

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-midnight via-navy to-navy-secondary text-white">
      <div className="mx-auto max-w-2xl px-4 py-10 md:px-6 md:py-14">
        <div className="mb-8 flex items-center justify-center">
          <Logo size="lg" alt="Alto" />
        </div>
        {children}
      </div>
    </div>
  );
}

function Notice({ tone = 'neutral', title, children }: { tone?: 'good' | 'neutral'; title: string; children: ReactNode }) {
  return (
    <div
      role="status"
      className={
        tone === 'good'
          ? 'rounded-lg border border-success/40 bg-success/10 p-6'
          : 'rounded-lg border border-navy-secondary bg-navy/60 p-6'
      }
    >
      <div className="flex items-center gap-2 text-lg text-white">
        {tone === 'good' && <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />}
        {title}
      </div>
      <div className="mt-2 text-silver">{children}</div>
    </div>
  );
}

export function OfferLetterPage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['offer-letter', token],
    queryFn: () => getOfferLetter(token),
    // A 404 is an answer — used or not a real link — not a blip to retry.
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const [typedName, setTypedName] = useState('');
  const [agree, setAgree] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ kind: 'signed'; at: string } | { kind: 'declined' } | null>(null);

  useEffect(() => {
    document.title = 'Your offer from Alto';
  }, []);

  const offer = q.data;

  const sign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await acceptOfferLetter(token, typedName.trim());
      setDone({ kind: 'signed', at: r.signedAt });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your signature did not go through. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setError(null);
    setBusy(true);
    try {
      await declineOfferLetter(token, reason.trim() || null);
      setDone({ kind: 'declined' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not go through. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done?.kind === 'signed') {
    return (
      <Shell>
        <Notice tone="good" title="You've accepted — welcome to Alto">
          Signed by {typedName.trim()} on {fmtDate(done.at)}. We've emailed you a copy of the signed letter. Next,
          you'll get an email to set up your account and complete your paperwork.
        </Notice>
      </Shell>
    );
  }
  if (done?.kind === 'declined') {
    return (
      <Shell>
        <Notice title="You've declined the offer">
          Thanks for letting us know. Your recruiter has been told, and you're welcome to apply for other jobs with us
          anytime.
        </Notice>
      </Shell>
    );
  }

  if (q.error) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <Shell>
        {gone ? (
          <Notice title="This offer link can't be opened">
            It has already been used, or it isn't a real link. If you've signed your offer, you're all set — watch
            your email for next steps. Otherwise, contact your recruiter for a new link.
          </Notice>
        ) : (
          <ErrorBanner>{q.error instanceof ApiError ? q.error.message : 'Could not load your offer.'}</ErrorBanner>
        )}
      </Shell>
    );
  }

  if (!offer) {
    return (
      <Shell>
        <Skeleton className="mb-3 h-8 w-2/3" />
        <Skeleton className="mb-8 h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </Shell>
    );
  }

  if (offer.status !== 'SENT') {
    const why: Record<string, [string, string]> = {
      ACCEPTED: ['This offer is already accepted', `Signed${offer.signedName ? ` by ${offer.signedName}` : ''}${offer.signedAt ? ` on ${fmtDate(offer.signedAt)}` : ''}.`],
      DECLINED: ['This offer was declined', 'If that was a mistake, contact your recruiter.'],
      EXPIRED: ['This offer has expired', 'Contact your recruiter if you are still interested — they can send a new one.'],
      WITHDRAWN: ['This offer was withdrawn', 'Your recruiter will be in touch.'],
    };
    const [title, body] = why[offer.status] ?? ['This offer is not open', 'Contact your recruiter.'];
    return (
      <Shell>
        <Notice title={title}>{body}</Notice>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-sm uppercase tracking-widest text-gold">Your offer from Alto</p>
      <h1 className="mt-2 font-display text-3xl md:text-4xl text-white">{offer.jobTitle}</h1>
      <dl className="mt-4 grid grid-cols-1 gap-3 rounded-lg border border-navy-secondary bg-navy/60 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-2xs uppercase tracking-widest text-silver">Where</dt>
          <dd className="mt-0.5 text-white">{offer.clientName}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-widest text-silver">Starts</dt>
          <dd className="mt-0.5 text-white">{offer.startDate}</dd>
        </div>
        <div>
          <dt className="text-2xs uppercase tracking-widest text-silver">Pay</dt>
          <dd className="mt-0.5 text-white">{offer.pay}</dd>
        </div>
      </dl>

      {offer.letterBody && (
        <article aria-label="Offer letter" className="mt-6 whitespace-pre-wrap rounded-lg border border-navy-secondary bg-navy/40 p-5 leading-relaxed text-silver">
          {offer.letterBody}
        </article>
      )}

      {offer.expiresAt && (
        <p className="mt-3 text-sm text-silver">Please respond by {fmtDate(offer.expiresAt)}.</p>
      )}

      {!declining ? (
        <form onSubmit={(e) => void sign(e)} className="mt-8 space-y-4 rounded-lg border border-navy-secondary bg-navy/60 p-5 md:p-6">
          <h2 className="flex items-center gap-2 text-xl text-white">
            <FileSignature className="h-5 w-5 text-gold" aria-hidden="true" />
            Accept and sign
          </h2>
          <Field label="Type your full name to sign" required>
            {(p) => (
              <Input
                {...p}
                autoComplete="name"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder={offer.candidateName}
                maxLength={120}
              />
            )}
          </Field>
          <label className="flex items-start gap-2 text-sm text-silver">
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
            />
            <span>
              I have read this offer and accept it. Typing my name above is my electronic signature, and I agree to sign
              electronically.
            </span>
          </label>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="submit" loading={busy} disabled={busy || typedName.trim().length < 2 || !agree}>
              Accept and sign
            </Button>
            <button type="button" className="text-sm text-silver underline hover:text-white" onClick={() => setDeclining(true)}>
              Decline this offer
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-8 space-y-4 rounded-lg border border-navy-secondary bg-navy/60 p-5 md:p-6">
          <h2 className="text-xl text-white">Decline this offer?</h2>
          <Field label="Anything you'd like us to know?" hint="Optional — it helps us improve our offers.">
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <div className="flex flex-wrap gap-3">
            <Button variant="destructive" onClick={() => void decline()} loading={busy} disabled={busy}>
              Decline offer
            </Button>
            <Button variant="ghost" onClick={() => setDeclining(false)} disabled={busy}>
              Back to the offer
            </Button>
          </div>
        </div>
      )}
    </Shell>
  );
}
