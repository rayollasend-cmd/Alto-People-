import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth';

/**
 * An associate's name that goes somewhere.
 *
 * The 2026-08 navigation audit found ~40 pages rendering associate names as
 * dead text — seeing someone's record meant menu → People → find them again.
 * This renders the person's full record (/people/:id) whenever the viewer
 * can actually open People, and degrades to a plain span for roles that
 * can't (bounded supervisors lack view:org — a dead 403 link is worse than
 * no link).
 *
 * The link also carries a `return` leg by default: the record's header
 * shows a "Back to <where you came from>" link so the round trip has a way
 * home. Links clicked while already on /people skip it (People IS home).
 *
 * Inline by design: drop it wherever the name already renders. Row onClick
 * handlers across the codebase already ignore clicks on <a>, so it nests
 * safely inside clickable table rows.
 *
 * A shift supervisor can't open People (no view:org) but may reach her own
 * crew (message:crew): her names open the scoped crew card instead
 * (components/floor/CrewCard — contact, availability, certifications, next
 * shifts; never pay). It loads on first use, so this file stays free of
 * import-time work.
 */
type CrewLinkProps = { associateId: string; name: string | null; className?: string; children: ReactNode };
let crewLink: ComponentType<CrewLinkProps> | null = null;
const loadCrewLink = () => (crewLink ??= lazy(() => import('@/components/floor/CrewCard').then((m) => ({ default: m.CrewLink }))));

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
  if (associateId && !can('view:org') && can('message:crew')) {
    const CrewLink = loadCrewLink();
    const plain = <span className={className}>{children}</span>;
    return (
      // The card opens from a button: keep its click from also firing a clickable row.
      <span onClick={(e) => e.stopPropagation()}>
        <Suspense fallback={plain}>
          <CrewLink associateId={associateId} name={typeof children === 'string' ? children : null} className={className}>
            {children}
          </CrewLink>
        </Suspense>
      </span>
    );
  }
  if (!associateId || !can('view:org')) {
    return <span className={className}>{children}</span>;
  }
  // No return leg when we're already in the People directory — a "back to
  // People" chip on a People drawer is noise.
  const onPeople =
    location.pathname === '/people' || location.pathname.startsWith('/people/');
  // The full record, not the directory drawer: the drawer needed a second
  // click ("Open full record") on ~48 call sites (ease-of-use sweep,
  // 2026-10-22). The record page reads ?tab= and renders the ?return= link.
  const q = new URLSearchParams();
  if (tab) q.set('tab', tab);
  if (carryReturn && !newTab && !onPeople) q.set('return', location.pathname + location.search);
  const qs = q.toString();
  return (
    <Link
      to={`/people/${associateId}${qs ? `?${qs}` : ''}`}
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
