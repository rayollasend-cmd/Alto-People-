import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Headings for the signed-out pages (sign in, forgot / reset password,
 * accept an invite, confirm an email change, install). They sit outside
 * the app shell, so PageHeader (breadcrumbs, the topbar title, the hero
 * observer) does not fit: there is one centred wordmark above one card.
 *
 *   <AuthHero title="Reset password" eyebrow="Alto People" />
 *   <AuthCardTitle>Forgot password?</AuthCardTitle>
 *   <AuthCardTitle size="md">Check your email</AuthCardTitle>
 */

const HERO_SIZE = {
  /** The app's own name on the invite page. */
  lg: 'text-5xl md:text-6xl',
  /** A task's name ("Reset password") in place of the wordmark. */
  md: 'text-4xl md:text-5xl',
  /** The install page's plain title. */
  sm: 'text-3xl sm:text-4xl',
} as const;

export function AuthHero({
  title,
  eyebrow,
  size = 'md',
  tone = 'gold',
  className,
}: {
  title: React.ReactNode;
  /** The tracked, upper-case line under the title ("Alto People"). */
  eyebrow?: React.ReactNode;
  size?: keyof typeof HERO_SIZE;
  /** gold: the brand wordmark; ink: a plain page title. */
  tone?: 'gold' | 'ink';
  className?: string;
}) {
  return (
    <>
      <h1
        className={cn(
          'font-display mb-2',
          HERO_SIZE[size],
          tone === 'gold' ? 'text-gold leading-none' : 'text-ink',
          className,
        )}
      >
        {title}
      </h1>
      {eyebrow && (
        <p className="text-silver text-xs md:text-sm tracking-[0.3em] uppercase">{eyebrow}</p>
      )}
    </>
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

/** The title inside the signed-out card. */
export function AuthCardTitle({
  children,
  size = 'lg',
  className,
}: {
  children: React.ReactNode;
  size?: keyof typeof CARD_SIZE;
  className?: string;
}) {
  return <h2 className={cn('text-ink', CARD_SIZE[size], className)}>{children}</h2>;
}
