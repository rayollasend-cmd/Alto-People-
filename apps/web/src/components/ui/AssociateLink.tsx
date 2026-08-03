import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
 * Inline by design: drop it wherever the name already renders. Row onClick
 * handlers across the codebase already ignore clicks on <a>, so it nests
 * safely inside clickable table rows.
 */
export function AssociateLink({
  associateId,
  children,
  className,
  tab,
}: {
  associateId: string | null | undefined;
  /** The name (or any label) as it already renders today. */
  children: ReactNode;
  className?: string;
  /** Land on a specific profile tab (e.g. "documents" for the vault). */
  tab?: 'profile' | 'compensation' | 'documents';
}) {
  const { can } = useAuth();
  if (!associateId || !can('view:org')) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link
      to={`/people?associateId=${associateId}${tab ? `&tab=${tab}` : ''}`}
      className={cn(
        'rounded-sm hover:text-gold hover:underline focus-visible:underline focus-visible:outline-none transition-colors',
        className,
      )}
      title="Open profile"
    >
      {children}
    </Link>
  );
}
