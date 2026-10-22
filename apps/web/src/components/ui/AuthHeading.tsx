import * as React from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';

/**
 * Headings for the signed-out pages (sign in, forgot / reset password,
 * accept an invite, confirm an email change, install). They sit outside
 * the app shell, so PageHeader (breadcrumbs, the topbar title, the hero
 * observer) does not fit: there is one centred lockup above one card.
 *
 *   <AuthShell>
 *     <form className={AUTH_CARD}>
 *       <AuthCardTitle>Forgot password?</AuthCardTitle>
 *       …
 *     </form>
 *   </AuthShell>
 *
 * AuthShell is the ONE lockup every signed-out page wears (F500 G5: three
 * different headers, and only /login had the Status · Trust Center ·
 * Accessibility footer): the logo, the wordmark, the tagline, the card, and
 * the footer. The page's own name is the card's title — the page's h1.
 */

/** The signed-out card's surface. */
export const AUTH_CARD = 'bg-navy/80 backdrop-blur border border-navy-secondary rounded-lg p-6 md:p-8 elev-3 ring-1 ring-white/[0.06] animate-zoom-in';

export function AuthShell({ children, wide = false }: { children: React.ReactNode; /** The install page's wider card. */ wide?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-login-aurora" data-testid="auth-shell">
      <div className={cn('w-full', wide ? 'max-w-xl' : 'max-w-md')}>
        <div className="text-center mb-8 animate-fade-in">
          <Logo size="lg" className="mx-auto mb-4 rounded-xl ring-1 ring-gold/25 shadow-[0_8px_32px_rgba(217,185,103,0.15)]" />
          <div className="font-display text-4xl md:text-5xl text-ink leading-none">
            Alto <span className="text-gold">People</span>
          </div>
          <p className="text-silver/70 text-xs2 tracking-[0.32em] uppercase mt-2">{t('login.brandTagline')}</p>
        </div>
        {children}
        <p className="text-center text-xs text-silver/70 mt-6">© {new Date().getFullYear()} Alto Etho LLC d/b/a Alto HR</p>
        <nav aria-label={t('login.publicPages')} className="mt-2 flex items-center justify-center gap-3 text-xs text-silver/70">
          <Link to="/status" className="hover:text-gold-bright underline-offset-2 hover:underline">
            {t('login.status')}
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/trust-center" className="hover:text-gold-bright underline-offset-2 hover:underline">
            {t('login.trustCenter')}
          </Link>
          <span aria-hidden="true">·</span>
          <Link to="/accessibility" className="hover:text-gold-bright underline-offset-2 hover:underline">
            {t('login.accessibility')}
          </Link>
        </nav>
      </div>
    </div>
  );
}

const CARD_SIZE = {
  /** A form's title ("Forgot password?"). */
  lg: 'text-2xl md:text-3xl mb-1',
  /** A result's title (done, failed, still working). */
  md: 'text-xl md:text-2xl mb-2',
  /** The sign-in card's quiet title. */
  sm: 'text-xl mb-1',
} as const;

/** The title inside the signed-out card — the page's name, so its h1 (the lockup above is the brand, not a heading). */
export function AuthCardTitle({
  children,
  size = 'lg',
  as: Tag = 'h1',
  className,
}: {
  children: React.ReactNode;
  size?: keyof typeof CARD_SIZE;
  as?: 'h1' | 'h2';
  className?: string;
}) {
  return <Tag className={cn('text-ink', CARD_SIZE[size], className)}>{children}</Tag>;
}
