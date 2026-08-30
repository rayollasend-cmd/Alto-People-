import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth';

/**
 * An associate's name that goes somewhere.
 *
 * The 2026-08 navigation audit found ~40 pages rendering associate names as
 * dead text — seeing someone's record meant menu → People → find them again.
 * This renders the standard deep link (/people?associateId=…, which opens
 * their profile drawer) whenever the viewer can actually open the People
 * directory, and degrades to a plain span for roles that can't (bounded
 * supervisors lack view:org — a dead 403 link is worse than no link).
 *
 * The link also carries a `return` leg by default: the profile drawer shows
 * a "Back to <where you came from>" chip so the round trip has a way home.
 * PeopleDirectory validates and consumes the param; links clicked while
 * already on /people skip it (the directory IS home).
 *
 * Inline by design: drop it wherever the name already renders. Row onClick
 * handlers across the codebase already ignore clicks on <a>, so it nests
 * safely inside clickable table rows.
 */
export function AssociateLink({
  associateId,
  children,
  className,
  tab,
  carryReturn = true,
  newTab = false,
}: {
  associateId: string | null | undefined;
  /** The name (or any label) as it already renders today. */
  children: ReactNode;
  className?: string;
  /** Land on a specific profile tab (e.g. "documents" for the vault). */
  tab?: 'profile' | 'compensation' | 'documents';
  /**
   * Append `&return=<current path>` so the profile drawer can offer a
   * "Back to …" chip. On by default (strictly additive); pass false to
   * emit the bare historical link.
   */
  carryReturn?: boolean;
  /**
   * Open the profile in a new tab. For links inside drawers with typed
   * form state (exit interviews, renewals) — a same-tab navigation would
   * destroy the text mid-entry. Implies no return leg: the origin page
   * stays open in its own tab.
   */
  newTab?: boolean;
}) {
  const { can } = useAuth();
  const location = useLocation();
  if (!associateId || !can('view:org')) {
    return <span className={className}>{children}</span>;
  }
  // No return leg when we're already in the People directory — a "back to
  // People" chip on a People drawer is noise.
  const onPeople =
    location.pathname === '/people' || location.pathname.startsWith('/people/');
  const returnLeg =
    carryReturn && !newTab && !onPeople
      ? `&return=${encodeURIComponent(location.pathname + location.search)}`
      : '';
  return (
    <Link
      to={`/people?associateId=${associateId}${tab ? `&tab=${tab}` : ''}${returnLeg}`}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener noreferrer' : undefined}
      className={cn(
        'rounded-sm hover:text-gold hover:underline focus-visible:underline focus-visible:outline-none transition-colors',
        className,
      )}
      title={newTab ? 'Open profile in a new tab' : 'Open profile'}
    >
      {children}
    </Link>
  );
}
