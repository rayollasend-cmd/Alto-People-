import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Link2, Plus, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { usePrompt } from '@/lib/confirm';
import {
  createDocumentRequest,
  documentRequestFileUrl,
  listDocumentRequests,
  reviewDocumentRequest,
  sendCandidatePortalLink,
  type DocumentRequest,
} from '@/lib/candidatePortalApi';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * The recruiter's side of the candidate's page, on the candidate's record:
 * send (or resend) their link, ask for documents, and review what came
 * back. Every action here reaches the candidate on their own page.
 */

const BADGE: Record<DocumentRequest['status'], { label: string; variant: 'pending' | 'info' | 'success' | 'destructive' }> = {
  REQUESTED: { label: 'Asked', variant: 'pending' },
  UPLOADED: { label: 'To review', variant: 'info' },
  ACCEPTED: { label: 'Accepted', variant: 'success' },
  REJECTED: { label: 'Asked again', variant: 'destructive' },
};

export function CandidatePortalPanel({ candidateId, canManage, onChanged }: { candidateId: string; canManage: boolean; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({ queryKey: ['CandidateDetailDrawer', 'portal', candidateId], queryFn: () => listDocumentRequests(candidateId) });
  const [label, setLabel] = useState('');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['CandidateDetailDrawer', 'portal', candidateId] });
    onChanged?.();
  };
  const sendLink = useMutation({
    mutationFn: () => sendCandidatePortalLink(candidateId),
    onSuccess: async (r) => {
      if (r.link) {
        await navigator.clipboard?.writeText(r.link).catch(() => undefined);
        toast.success('Link copied — email isn’t set up here, so send it yourself.');
      } else {
        toast.success(`Their page link sent by ${[r.emailed && 'email', r.texted && 'text'].filter(Boolean).join(' and ')}.`);
      }
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the link.'),
  });
  const ask = useMutation({
    mutationFn: (l: string) => createDocumentRequest(candidateId, { label: l }),
    onSuccess: (r) => {
      setLabel('');
      toast.success(r.link ? 'Asked — link copied for you to send.' : `Asked for ${r.request.label}; they have the link.`);
      if (r.link) void navigator.clipboard?.writeText(r.link).catch(() => undefined);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not ask for the document.'),
  });
  const review = useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: 'ACCEPT' | 'REJECT'; note?: string | null }) => reviewDocumentRequest(id, { decision, note }),
    onSuccess: (r) => {
      toast.success(r.request.status === 'ACCEPTED' ? 'Accepted.' : 'Asked for it again, with your note.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not review.'),
  });
  const reject = async (d: DocumentRequest) => {
    const note = await prompt({
      title: `Ask for ${d.label} again?`,
      description: 'Your note goes to the candidate with a fresh link.',
      reasonLabel: 'What was wrong',
      reasonPlaceholder: 'e.g. The photo is blurry — please retake it in good light.',
      confirmLabel: 'Ask again',
    });
    if (!note) return;
    review.mutate({ id: d.id, decision: 'REJECT', note: note.trim() });
  };
  const data = q.data ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        {data ? (
          data.portal.linkActive ? (
            <span className="inline-flex items-center gap-1">
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Their link works until {fmtDate(data.portal.expiresAt)}
            </span>
          ) : (
            <span>They don&rsquo;t have a working link yet.</span>
          )
        ) : (
          <span>&nbsp;</span>
        )}
        {canManage && (
          <Button size="xs" variant="outline" className="ml-auto" loading={sendLink.isPending} onClick={() => sendLink.mutate()}>
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            {data?.portal.linkActive ? 'Send the link again' : 'Send their page link'}
          </Button>
        )}
      </div>
      {q.isError ? (
        <p className="text-sm text-alert">Could not load their documents.</p>
      ) : !data ? (
        <SkeletonRows count={2} />
      ) : data.requests.length === 0 ? (
        <p className="text-sm text-ink-muted">No document asked for. Ask below and they upload it from their phone.</p>
      ) : (
        <ul className="space-y-2">
          {data.requests.map((d) => (
            <li key={d.id} className="rounded-md border border-line bg-surface px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-ink">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                  <span className="truncate">{d.label}</span>
                </span>
                <Badge variant={BADGE[d.status].variant}>{BADGE[d.status].label}</Badge>
              </div>
              <div className="mt-1 text-xs2 text-ink-muted">
                {d.status === 'REQUESTED' && `asked ${fmtDate(d.createdAt)}`}
                {d.status !== 'REQUESTED' && d.uploadedAt && `${d.fileName ?? 'file'} · ${fmtDate(d.uploadedAt)}`}
                {d.status === 'REJECTED' && d.reviewNote && ` · ${d.reviewNote}`}
              </div>
              {d.status !== 'REQUESTED' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild size="xs" variant="outline">
                    <a href={documentRequestFileUrl(d.id)} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      Open
                    </a>
                  </Button>
                  {canManage && d.status === 'UPLOADED' && (
                    <>
                      <Button size="xs" loading={review.isPending && review.variables?.id === d.id && review.variables.decision === 'ACCEPT'} onClick={() => review.mutate({ id: d.id, decision: 'ACCEPT' })}>
                        Accept
                      </Button>
                      <Button size="xs" variant="ghost" className="text-alert hover:text-alert" onClick={() => void reject(d)}>
                        Ask again
                      </Button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) ask.mutate(label.trim());
          }}
        >
          <Input aria-label="Document to ask for" value={label} maxLength={120} placeholder="Ask for a document, e.g. Driver's licence" onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" variant="outline" loading={ask.isPending} disabled={!label.trim() || ask.isPending}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Ask
          </Button>
        </form>
      )}
    </div>
  );
}
