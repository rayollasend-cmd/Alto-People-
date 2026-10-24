import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AtSign, ShieldCheck } from '@/components/ui/icons';
import { ApiError, NetworkError } from '@/lib/api';
import { confirmEmailChange } from '@/lib/settingsApi';
import { AuthCardTitle, AuthShell } from '@/components/ui/AuthHeading';
import { Button } from '@/components/ui/Button';
import { LinkProblem } from '@/components/LinkProblem';

/**
 * Public — completes the two-step email change. The token comes from the
 * URL (clicked from the new-address inbox). Confirms automatically on
 * mount; on success the server has already swapped the email and bumped
 * tokenVersion (so any other open session is now stale). The user is
 * pointed at /login to re-authenticate with the new address.
 *
 * Token is the authorization here — we deliberately don't gate on a
 * session, since the user may have clicked the link on a different
 * device than the one they were signed into.
 */
export function ConfirmEmailChange() {
  const { token = '' } = useParams<{ token: string }>();
  const [state, setState] = useState<'pending' | 'done' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);
  // 'link': the link itself can't be used (expired, used, cut off) — the next
  // step is the same either way: sign in and ask again from Settings.
  const [problem, setProblem] = useState<'link' | 'taken' | 'other'>('other');
  // The effect would otherwise fire twice under React 18 strict mode and
  // burn the token on the first call, surfacing an "expired" error to the
  // user even though the change actually succeeded.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (!token) {
      setState('error');
      setProblem('link');
      return;
    }
    confirmEmailChange({ token })
      .then(() => setState('done'))
      .catch((err) => {
        setState('error');
        if (err instanceof NetworkError) {
          setError('Network error — check your connection and try again.');
        } else if (err instanceof ApiError && err.code === 'invalid_token') {
          setProblem('link');
        } else if (err instanceof ApiError && err.code === 'email_in_use') {
          setProblem('taken');
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Couldn't confirm the email change. Try again in a minute.");
        }
      });
  }, [token]);

  return (
    <AuthShell>

      {state !== 'error' && (
      <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 animate-zoom-in text-center">
        {state === 'pending' && (
          <>
            <AtSign className="mx-auto h-12 w-12 text-gold mb-4 animate-pulse" />
            <AuthCardTitle size="md">Confirming your new email…</AuthCardTitle>
            <p className="text-silver text-sm">
              One moment.
            </p>
          </>
        )}
        {state === 'done' && (
          <>
            <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
            <AuthCardTitle size="md">Email updated</AuthCardTitle>
            <p className="text-silver text-sm mb-6">
              Your sign-in email has been changed. Every existing session
              has been signed out. Sign in again with your new email to
              continue.
            </p>
            {/* Signing in again IS this page's next step — full-width
                button, not an easy-to-miss text link (same complaint as
                the invite page's hidden "Go to sign in"). */}
            <Button asChild variant="secondary" className="w-full">
              <Link to="/login">Go to sign in</Link>
            </Button>
          </>
        )}
      </div>
      )}
      {state === 'error' && (
        <LinkProblem
          kind={problem === 'link' ? 'expired' : 'error'}
          title={problem === 'link' ? 'This confirmation link can’t be used' : problem === 'taken' ? 'That email is taken' : 'Couldn’t confirm the change'}
          reason={
            problem === 'link'
              ? 'It has expired or was already used. Sign in and request a new change in Settings.'
              : problem === 'taken'
                ? 'Another account claimed that email before you could confirm. Sign in and pick a different one in Settings.'
                : error
          }
          action={
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?next=/settings">Sign in</Link>
            </Button>
          }
        />
      )}

    </AuthShell>
  );
}

export default ConfirmEmailChange;
