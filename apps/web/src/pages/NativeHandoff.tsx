import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';

/**
 * Where the system browser lands after a sign-in the app's web view can't
 * do itself (SSO, passkeys). Signed in here → a two-minute code → back into
 * the app (altopeople://auth/complete?code=…), which trades it for its own
 * session. Not signed in → the sign-in page, which returns here.
 */
export function NativeHandoff() {
  const { t } = useI18n();
  // One code per visit: no retries, nothing cached (a code is single-use).
  const handoff = useQuery({
    queryKey: ['auth', 'native-handoff'],
    queryFn: () => apiFetch<{ code: string; returnUrl: string }>('/auth/native-handoff', { method: 'POST' }),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const returnUrl = handoff.data?.returnUrl ?? null;
  const unauthenticated = handoff.error instanceof ApiError && handoff.error.status === 401;
  const failed = handoff.isError && !unauthenticated;

  useEffect(() => {
    if (returnUrl) window.location.href = returnUrl;
  }, [returnUrl]);
  useEffect(() => {
    if (unauthenticated) window.location.replace('/login?next=/native-handoff');
  }, [unauthenticated]);

  return (
    <main aria-labelledby="handoff-title" className="flex min-h-[100dvh] flex-col items-center justify-center bg-surface-sunken px-6 text-center">
      <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-lg" />
      <h1 id="handoff-title" className="mt-6 font-display text-3xl text-ink">{failed ? t('handoff.failedTitle') : t('handoff.title')}</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-muted" aria-live="polite">
        {failed ? t('handoff.failedBody') : t('handoff.body')}
      </p>
      <div className="mt-8 w-full max-w-xs">
        {failed ? (
          <Button size="lg" className="w-full" onClick={() => window.location.replace('/login?next=/native-handoff')}>
            {t('handoff.signInAgain')}
          </Button>
        ) : returnUrl ? (
          <Button asChild size="lg" className="w-full">
            <a href={returnUrl}>
              {t('handoff.open')}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        ) : (
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-ink-muted" aria-label={t('handoff.title')} />
        )}
      </div>
    </main>
  );
}
