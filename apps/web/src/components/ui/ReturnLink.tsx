import { Link, useInRouterContext, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { returnPathLabel, sanitizeReturnPath } from '@/lib/returnPath';
import { cn } from '@/lib/cn';

/**
 * "← Back to …" for a page opened from somewhere else with `?return=`.
 * Rendered by every page header, so a link built with `withReturn()` has a
 * way back on whatever page it lands on. Nothing renders without the param.
 * Same-origin paths only (sanitizeReturnPath), so it can't redirect out.
 */
export function ReturnLink({ className }: { className?: string }) {
  // The header also renders in unit tests and previews without a router;
  // outside one there is no URL to read, so there is no way back to offer.
  const inRouter = useInRouterContext();
  return inRouter ? <ReturnLinkInner className={className} /> : null;
}

function ReturnLinkInner({ className }: { className?: string }) {
  const [params] = useSearchParams();
  const back = sanitizeReturnPath(params.get('return'));
  if (!back) return null;
  return (
    <Link
      to={back}
      className={cn('inline-flex items-center gap-1 text-xs text-gold hover:underline underline-offset-4', className)}
      data-return-link
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Back to {returnPathLabel(back)}
    </Link>
  );
}
