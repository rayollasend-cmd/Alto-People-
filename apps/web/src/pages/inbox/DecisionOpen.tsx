import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from '@/components/ui/icons';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates/ListTemplate';

/**
 * Where a decision assigned to someone opens (/decisions/open?key=…). The
 * link is worked out now, as the person opening it sees it — a "today" in
 * it is today, and it is a page they can open — not copied into the
 * notification when it was assigned.
 */
export function DecisionOpen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const key = params.get('key') ?? '';
  const item = useQuery({
    queryKey: ['decision-open', key],
    queryFn: () => apiFetch<{ linkUrl: string }>(`/me/decisions/item?key=${encodeURIComponent(key)}`),
    enabled: key.length > 0,
    retry: false,
  });
  const linkUrl = item.data?.linkUrl;
  useEffect(() => {
    if (linkUrl) navigate(linkUrl, { replace: true });
  }, [linkUrl, navigate]);

  if (key && (item.isPending || linkUrl)) {
    return (
      <ListTemplate title="Opening…">
        <Skeleton className="h-24" />
      </ListTemplate>
    );
  }
  return (
    <ListTemplate title="Nothing to open">
      <EmptyState
        icon={CheckCircle2}
        title="That item is no longer on your list"
        description="It was resolved, or it isn’t one you can act on. Everything still waiting on you is in your inbox."
        action={
          <Link to="/inbox" className="text-sm font-medium text-gold hover:underline">
            Open your inbox
          </Link>
        }
      />
    </ListTemplate>
  );
}
