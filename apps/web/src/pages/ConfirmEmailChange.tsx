import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AtSign, ShieldCheck } from '@/components/ui/icons';
import { ApiError, NetworkError } from '@/lib/api';
import { confirmEmailChange } from '@/lib/settingsApi';
import { AuthCardTitle, AuthShell } from '@/components/ui/AuthHeading';
import { Button } from '@/components/ui/Button';
import { LinkProblem } from '@/components/LinkProblem';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/pw';

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
  const { t } = useI18n();
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
          setError(t('login.errNetwork'));
        } else if (err instanceof ApiError && err.code === 'invalid_token') {
          setProblem('link');
        } else if (err instanceof ApiError && err.code === 'email_in_use') {
          setProblem('taken');
        } else if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError(t('pw.confirmFailed'));
        }
      });
    // The words are read when the answer lands; the confirm runs once per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <AuthShell>

      {state !== 'error' && (
      <div className="bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 animate-zoom-in text-center">
        {state === 'pending' && (
          <>
            <AtSign className="mx-auto h-12 w-12 text-gold mb-4 animate-pulse" />
            <AuthCardTitle size="md">{t('pw.confirming')}</AuthCardTitle>
            <p className="text-silver text-sm">
              {t('pw.oneMoment')}
            </p>
          </>
        )}
        {state === 'done' && (
          <>
            <ShieldCheck className="mx-auto h-12 w-12 text-success mb-4" />
            <AuthCardTitle size="md">{t('pw.emailUpdated')}</AuthCardTitle>
            <p className="text-silver text-sm mb-6">
              {t('pw.emailUpdatedBody')}
            </p>
            {/* Signing in again IS this page's next step — full-width
                button, not an easy-to-miss text link (same complaint as
                the invite page's hidden "Go to sign in"). */}
            <Button asChild variant="secondary" className="w-full">
              <Link to="/login">{t('pw.goToSignIn')}</Link>
            </Button>
          </>
        )}
      </div>
      )}
      {state === 'error' && (
        <LinkProblem
          kind={problem === 'link' ? 'expired' : 'error'}
          title={problem === 'link' ? t('pw.confirmLinkBad') : problem === 'taken' ? t('pw.emailTaken') : t('pw.confirmCouldnt')}
          reason={problem === 'link' ? t('pw.confirmLinkBadWhy') : problem === 'taken' ? t('pw.emailTakenWhy') : error}
          action={
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link to="/login?next=/settings">{t('login.signIn')}</Link>
            </Button>
          }
        />
      )}

    </AuthShell>
  );
}

export default ConfirmEmailChange;
