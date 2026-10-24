import type { ReactNode } from 'react';
import { Clock, Link2Off, Mail, Phone, TriangleAlert, type LucideIcon } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { fmtPhone, phoneHref } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** A person the reader can reach: name, work email, phone — any may be missing. */
export interface LinkContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * The one "this link doesn't work" state for every page reached by an
 * emailed or shared link (F500 G5): the offer, the candidate page, a shared
 * trip, a shared wallet, the NPS survey, a password reset, an email change,
 * an invitation. Each used to word and lay out a bad link its own way, and
 * a mistyped link was called "expired".
 *
 *   kind     'expired' — a real link past its time or already used (410);
 *            'invalid' — a link that was never issued, or cut off (404);
 *            'error'   — anything else (the server, the network).
 *   title    what happened, in a few words.
 *   reason   why, and what it means for them.
 *   action   the ONE next step (a button or a form).
 *   contact  a named person to ask, when the page knows one.
 */
const ICON: Record<'expired' | 'invalid' | 'error', LucideIcon> = { expired: Clock, invalid: Link2Off, error: TriangleAlert };

export function LinkProblem({
  kind,
  title,
  reason,
  action,
  contact,
  children,
  className,
  headingLevel = 1,
}: {
  kind: 'expired' | 'invalid' | 'error';
  title: string;
  reason: ReactNode;
  action?: ReactNode;
  contact?: LinkContact | null;
  /** Anything after the next step (a secondary way out). */
  children?: ReactNode;
  className?: string;
  /** 1 on a page of its own; 2 inside a card that already has a heading. */
  headingLevel?: 1 | 2;
}) {
  const { t } = useI18n();
  const Icon = ICON[kind];
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const hasContact = !!contact && (!!contact.name || !!contact.email || !!contact.phone);
  return (
    <div role="status" className={cn('rounded-xl border border-line bg-surface-raised p-6 text-center', className)} data-testid="link-problem" data-kind={kind}>
      <div
        className={cn(
          'mx-auto grid h-12 w-12 place-items-center rounded-full',
          kind === 'error' ? 'bg-alert/10 text-alert' : 'bg-accent-fill/15 text-accent',
        )}
        aria-hidden="true"
      >
        <Icon className="h-6 w-6" />
      </div>
      <Heading className="mt-4 text-xl font-medium text-ink">{title}</Heading>
      <p className="mx-auto mt-2 max-w-prose text-sm text-ink-muted">{reason}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
      {hasContact && (
        <div className="mx-auto mt-5 max-w-sm rounded-lg border border-line px-4 py-3 text-left text-sm" data-testid="link-problem-contact">
          <div className="text-2xs uppercase tracking-[0.14em] text-ink-muted">{t('linkProblem.whoToAsk')}</div>
          {contact!.name && <div className="mt-1 font-medium text-ink">{contact!.name}</div>}
          <div className="mt-1 flex flex-col gap-1">
            {contact!.email && (
              <a href={`mailto:${contact!.email}`} className="inline-flex items-center gap-1.5 text-accent underline-offset-2 hover:underline">
                <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="break-all">{contact!.email}</span>
              </a>
            )}
            {contact!.phone && phoneHref(contact!.phone) && (
              <a href={phoneHref(contact!.phone)!} className="inline-flex items-center gap-1.5 text-accent underline-offset-2 hover:underline">
                <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {fmtPhone(contact!.phone)}
              </a>
            )}
          </div>
        </div>
      )}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** The same named person, as a quiet line on a page that works ("Questions? Rosa Recruiter · rosa@… · (850) 555-0199"). */
export function ContactLine({ label, contact, className }: { label: string; contact: LinkContact | null | undefined; className?: string }) {
  if (!contact || (!contact.name && !contact.email && !contact.phone)) return null;
  return (
    <p className={cn('flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-ink-muted', className)} data-testid="contact-line">
      <span>{label}</span>
      {contact.name && <span className="font-medium text-ink">{contact.name}</span>}
      {contact.email && (
        <a href={`mailto:${contact.email}`} className="text-accent underline-offset-2 hover:underline">
          {contact.email}
        </a>
      )}
      {contact.phone && phoneHref(contact.phone) && (
        <a href={phoneHref(contact.phone)!} className="text-accent underline-offset-2 hover:underline">
          {fmtPhone(contact.phone)}
        </a>
      )}
    </p>
  );
}
