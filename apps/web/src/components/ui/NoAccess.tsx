import { Link, useLocation } from 'react-router-dom';
import { Home, Inbox, Lock } from 'lucide-react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from './Button';
import { useAccessAskKey } from './QueryError';

/**
 * The page someone sees when a link takes them somewhere their role doesn't
 * reach (RequireCapability). Friendly and plain: what happened, who can
 * change it, and the way home — never the server's "Missing capability:
 * view:org", and never a page of skeletons that won't fill.
 */
/**
 * Pages a role meets by habit (a bookmark, the command palette) that belong
 * to someone else: say whose they are and where this person's own work is,
 * instead of only "ask for access". An associate on /approvals is pointed
 * to their Inbox (F500 G5).
 */
const ELSEWHERE: Array<{ prefix: string; hint: MessageKey; to: string; label: MessageKey }> = [
  { prefix: '/approvals', hint: 'access.approvalsHint', to: '/inbox', label: 'access.toInbox' },
];

export function NoAccess() {
  const { t } = useI18n();
  const askKey = useAccessAskKey();
  const { pathname } = useLocation();
  const elsewhere = ELSEWHERE.find((e) => pathname === e.prefix || pathname.startsWith(`${e.prefix}/`));
  return (
    <div className="min-h-[60dvh] flex items-center justify-center p-6" data-testid="no-access">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto h-14 w-14 rounded-full bg-surface-raised border border-line grid place-items-center">
          <Lock className="h-8 w-8 text-ink-muted" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl text-ink">{t('access.title')}</h1>
          <p className="text-sm text-ink-muted">{elsewhere ? t(elsewhere.hint) : t(askKey)}</p>
        </div>
        <div className="flex justify-center gap-2">
          {elsewhere && (
            <Button asChild>
              <Link to={elsewhere.to}>
                <Inbox className="h-4 w-4" aria-hidden="true" />
                {t(elsewhere.label)}
              </Link>
            </Button>
          )}
          <Button asChild variant={elsewhere ? 'secondary' : 'primary'}>
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
