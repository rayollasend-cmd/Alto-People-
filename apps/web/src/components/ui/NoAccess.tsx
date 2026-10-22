import { Link } from 'react-router-dom';
import { Home, Lock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Button } from './Button';
import { useAccessAskKey } from './QueryError';

/**
 * The page someone sees when a link takes them somewhere their role doesn't
 * reach (RequireCapability). Friendly and plain: what happened, who can
 * change it, and the way home — never the server's "Missing capability:
 * view:org", and never a page of skeletons that won't fill.
 */
export function NoAccess() {
  const { t } = useI18n();
  const askKey = useAccessAskKey();
  return (
    <div className="min-h-[60dvh] flex items-center justify-center p-6" data-testid="no-access">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto h-14 w-14 rounded-full bg-surface-raised border border-line grid place-items-center">
          <Lock className="h-7 w-7 text-ink-muted" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl text-ink">{t('access.title')}</h1>
          <p className="text-sm text-ink-muted">{t(askKey)}</p>
        </div>
        <div className="flex justify-center">
          <Button asChild>
            <Link to="/">
              <Home className="h-4 w-4" aria-hidden="true" />
              {t('access.home')}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
