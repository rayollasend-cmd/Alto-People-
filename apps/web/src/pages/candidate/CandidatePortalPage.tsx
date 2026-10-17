import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { CalendarCheck, CalendarClock, CheckCircle2, FileText, MapPin, Upload, UserRound } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { confirmPortalInterview, getCandidatePortal, uploadPortalDocument, type CandidatePortal } from '@/lib/candidatePortalApi';
import { fmtDate } from '@/lib/format';
import { Logo } from '@/components/Logo';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The candidate's own page.
 *
 * Everything about their application in one place, reached from the link
 * in the email or text: where they stand, their next interview — with one
 * tap to say they'll be there — and the documents we asked for, uploaded
 * right here from a phone. No login and no app chrome: the link is the
 * key, and it lapses after thirty days.
 */

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-ink">
      <div className="mx-auto max-w-xl px-4 py-8 md:px-6 md:py-12">
        <div className="mb-6 flex items-center justify-center">
          <Logo size="lg" alt="Company logo" />
        </div>
        {children}
      </div>
    </div>
  );
}

function Panel({ title, icon: Icon, children, trailing }: { title: string; icon: typeof FileText; children: ReactNode; trailing?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface-raised p-4 md:p-5">
      <div className="mb-3">
        <SectionTitle as="h2" icon={Icon} title={title} trailing={trailing} />
      </div>
      {children}
    </section>
  );
}

const DOC_BADGE: Record<CandidatePortal['documents'][number]['status'], { label: string; variant: 'pending' | 'info' | 'success' | 'destructive' }> = {
  REQUESTED: { label: 'Needed', variant: 'pending' },
  UPLOADED: { label: 'Received', variant: 'info' },
  ACCEPTED: { label: 'Accepted', variant: 'success' },
  REJECTED: { label: 'Please upload again', variant: 'destructive' },
};

function DocumentRow({ token, doc }: { token: string; doc: CandidatePortal['documents'][number] }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadPortalDocument(token, doc.id, file),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['candidate-portal', token] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The upload did not go through. Try again.'),
  });
  const canUpload = doc.status === 'REQUESTED' || doc.status === 'REJECTED' || doc.status === 'UPLOADED';
  const badge = DOC_BADGE[doc.status];
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{doc.label}</div>
          {doc.note && <div className="mt-0.5 text-xs text-ink-muted">{doc.note}</div>}
          {doc.status === 'REJECTED' && doc.reviewNote && <div className="mt-1 text-xs text-alert">{doc.reviewNote}</div>}
          {doc.fileName && doc.status !== 'REJECTED' && (
            <div className="mt-1 truncate text-xs text-ink-muted">
              {doc.fileName}
              {doc.uploadedAt ? ` · sent ${fmtDate(doc.uploadedAt)}` : ''}
            </div>
          )}
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      {canUpload && (
        <div className="mt-2">
          <input
            ref={input}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label={`Upload ${doc.label}`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
          <Button size="sm" variant={doc.status === 'UPLOADED' ? 'outline' : 'primary'} loading={upload.isPending} onClick={() => input.current?.click()}>
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {doc.status === 'UPLOADED' ? 'Replace file' : 'Upload a photo or PDF'}
          </Button>
          {error && <p className="mt-1 text-xs text-alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

export function CandidatePortalPage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['candidate-portal', token],
    queryFn: () => getCandidatePortal(token),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const data = q.data ?? null;
  const gone = q.error instanceof ApiError && q.error.status === 404;
  const loadError = q.error && !gone ? (q.error instanceof ApiError ? q.error.message : 'Could not load your page.') : null;
  const confirm = useMutation({
    mutationFn: (id: string) => confirmPortalInterview(token, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['candidate-portal', token] }),
  });

  useEffect(() => {
    document.title = data ? `Your application — ${data.orgName}` : 'Your application';
  }, [data]);

  return (
    <Shell>
      {gone ? (
        <div role="status" className="rounded-xl border border-line bg-surface-raised p-6">
          <div className="text-lg font-medium">This link has expired</div>
          <p className="mt-2 text-sm text-ink-muted">Links work for thirty days. Ask your recruiter for a new one and it will reach you by email or text.</p>
        </div>
      ) : loadError ? (
        <ErrorBanner>{loadError}</ErrorBanner>
      ) : !data ? (
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="space-y-4">
          <header className="rounded-xl border border-line bg-surface-raised p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-ink-muted">{data.orgName}</div>
            <div className="mt-1 font-display text-2xl">
              <h1>Hi {data.firstName}</h1>
            </div>
            <p className="mt-1 text-sm text-ink-muted">
              {data.position ? `Your application for ${data.position}` : 'Your application'}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Badge variant={data.stage === 'HIRED' ? 'success' : data.stage === 'REJECTED' || data.stage === 'WITHDRAWN' ? 'outline' : 'accent'} size="lg">
                {data.stageLabel}
              </Badge>
            </div>
            <p className="mt-2 text-sm">{data.stageDetail}</p>
          </header>

          <Panel title="Your interview" icon={CalendarClock}>
            {data.interviews.length === 0 ? (
              <p className="text-sm text-ink-muted">No interview is scheduled right now. You will get an email and a calendar invite when one is.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.interviews.map((i) => (
                  <li key={i.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="text-sm font-medium">{i.when}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                      <span>{i.durationMinutes} minutes</span>
                      {i.location && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" aria-hidden="true" />
                          {i.location}
                        </span>
                      )}
                      {i.interviewerName && (
                        <span className="inline-flex items-center gap-1">
                          <UserRound className="h-3 w-3" aria-hidden="true" />
                          with {i.interviewerName}
                        </span>
                      )}
                    </div>
                    <div className="mt-2">
                      {i.confirmedAt ? (
                        <span className="inline-flex items-center gap-1.5 text-sm text-success">
                          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          You said you&rsquo;ll be there
                        </span>
                      ) : (
                        <Button size="sm" loading={confirm.isPending && confirm.variables === i.id} onClick={() => confirm.mutate(i.id)}>
                          <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
                          I&rsquo;ll be there
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Documents we need" icon={FileText} trailing={data.documents.length > 0 ? <span className="text-xs text-ink-muted">{data.documents.filter((d) => d.status === 'ACCEPTED').length} of {data.documents.length} accepted</span> : undefined}>
            {data.documents.length === 0 ? (
              <p className="text-sm text-ink-muted">We have everything we need from you for now.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.documents.map((d) => (
                  <DocumentRow key={d.id} token={token} doc={d} />
                ))}
              </ul>
            )}
          </Panel>

          <p className="text-center text-xs text-ink-muted">
            This link is yours alone and works until {fmtDate(data.expiresAt)}. Questions? Reply to the email your recruiter sent.
          </p>
        </div>
      )}
    </Shell>
  );
}
