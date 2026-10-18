import { useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Input';
import { ListTemplate } from '@/components/templates';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Brief 2-6 step 5 — the platform inbox: every customer's support requests,
 * for the platform operator's admins. An answer reaches the requester's
 * request page and bell. Another organization's admins get a 404 here.
 */

interface InboxRequest {
  id: string;
  tenant: string | null;
  requester: string;
  category: string;
  subject: string;
  body: string;
  pageUrl: string | null;
  appVersion: string | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  reply: string | null;
  createdAt: string;
}

function Row({ r, onDone }: { r: InboxRequest; onDone: () => void }) {
  const [reply, setReply] = useState(r.reply ?? '');
  const move = async (status: InboxRequest['status']) => {
    try {
      await apiFetch(`/support/${r.id}`, { method: 'PATCH', body: { status, reply: reply.trim() || null } });
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    }
  };
  return (
    <li className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-white">{r.subject}</span>
        <Badge variant={r.status === 'OPEN' ? 'pending' : 'accent'} size="sm">
          {r.status === 'OPEN' ? 'Open' : 'In progress'}
        </Badge>
        <span className="text-xs text-silver">
          {r.tenant ?? 'Unknown organization'} · {r.requester} · {r.category.toLowerCase()} · {r.createdAt.slice(0, 10)}
        </span>
      </div>
      <p className="whitespace-pre-wrap text-silver">{r.body}</p>
      {(r.pageUrl || r.appVersion) && (
        <p className="text-xs text-silver/70">
          {r.pageUrl ?? ''} {r.appVersion ? `· ${r.appVersion}` : ''}
        </p>
      )}
      <Textarea aria-label={`Answer to ${r.subject}`} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Answer (shown to the requester)" />
      <div className="flex gap-2">
        {r.status === 'OPEN' && (
          <Button size="sm" variant="outline" onClick={() => void move('IN_PROGRESS')}>
            Working on it
          </Button>
        )}
        <Button size="sm" onClick={() => void move('RESOLVED')}>
          Resolve
        </Button>
      </div>
    </li>
  );
}

export function PlatformSupportInbox() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['support', 'inbox'], queryFn: () => apiFetch<{ requests: InboxRequest[] }>('/support/inbox') });
  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Support inbox" subtitle="Every customer’s open requests, oldest first." breadcrumbs={[{ label: 'Platform' }, { label: 'Support inbox' }]}
    >
      {q.isError ? (
        <QueryError what="the support inbox" query={q} />
      ) : (
        <Card>
          <CardContent className="p-0">
            {q.data && q.data.requests.length === 0 ? (
              <EmptyState size="sm" title={"Nothing open."} />
            ) : (
              <ul className="divide-y divide-navy-secondary">
                {(q.data?.requests ?? []).map((r) => (
                  <Row key={r.id} r={r} onDone={() => void qc.invalidateQueries({ queryKey: ['support', 'inbox'] })} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </ListTemplate>
  );
}
