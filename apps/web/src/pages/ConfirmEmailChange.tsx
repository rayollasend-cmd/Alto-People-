import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AtSign, ChevronLeft, ShieldCheck, ShieldX } from 'lucide-react';
import { ApiError, NetworkError } from '@/lib/api';
import { confirmEmailChange } from '@/lib/settingsApi';

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
  // The effect would otherwise fire twice under React 18 strict mode and
  // burn the token on the first call, surfacing an "expired" error to the
  // user even though the change actually succeeded.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (!token) {
      setState('error');
      setError('No confirmation token in the link.');
      return;
    }
    confirmEmailChange({ token })
      .then(() => setState('done'))
      .catch((err) => {
        setState('error');
        if (err instanceof NetworkError) {
          setError('Network error — check your connection and try again.');
        } else if (err instanceof ApiError && err.code === 'invalid_token') {
          setError(
            'This confirmation link is invalid or expired. Request a new email change from /settings.',
          );
        } else if (err instanceof ApiError && err.code === 'email_in_use') {
          setError(
            'That email was claimed by another account before you could confirm. Pick a different one in /settings.',
          );
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Couldn't confirm the email change. Try again in a minute.");
        }
      });
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in">
          <h1 className="font-display text-4xl md:text-5xl text-gold mb-2 leading-none">
            Confirm email change
          </h1>
          <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">
            Alto People
          </p>
        </div>

        <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 shadow-2xl animate-zoom-in text-center">
          {state === 'pending' && (
            <>
              <AtSign className="mx-auto h-12 w-12 text-gold mb-4 animate-pulse" />
              <h2 className="font-display text-xl md:text-2xl text-white mb-2">
                Confirming your new email…
              </h2>
              <p className="text-silver text-sm">
                One moment.
              </p>
            </>
          )}
          {state === 'done' && (
            <>
              <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
              <h2 className="font-display text-xl md:text-2xl text-white mb-2">
                Email updated
              </h2>
              <p className="text-silver text-sm mb-6">
                Your sign-in email has been changed. Every existing session
                has been signed out. Sign in again with your new email to
                continue.
              </p>
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 text-gold hover:text-gold/80 text-sm"
              >
                Go to sign in
              </Link>
            </>
          )}
          {state === 'error' && (
            <>
              <ShieldX className="mx-auto h-12 w-12 text-alert mb-4" />
              <h2 className="font-display text-xl md:text-2xl text-white mb-2">
                Couldn't confirm
              </h2>
              <p className="text-silver text-sm mb-6">{error}</p>
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 text-silver hover:text-white text-sm"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Back to sign in
              </Link>
            </>
          )}
        </div>

        <p className="text-center text-xs text-silver/60 mt-6">
          Alto Etho LLC d/b/a Alto HR · v0.1.0
        </p>
      </div>
    </div>
  );
}

export default ConfirmEmailChange;
