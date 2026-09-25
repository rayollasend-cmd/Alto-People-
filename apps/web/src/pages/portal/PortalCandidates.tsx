import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Check, UserCheck, X } from 'lucide-react';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { onLiveEvent } from '@/lib/liveEvents';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { scopeParams } from './scope';

/**
 * The people Alto puts forward, for the client to approve or pass on.
 *
 * This used to happen by phone: a recruiter called the store, the answer
 * lived in their head, and nothing reached the candidate's record. Now
 * the client sees who, for which store, why (the recruiter's pitch) and
 * how Alto's interviewers recommended them — never contact details — and
 * their answer lands on the candidate's timeline and the recruiter's bell.
 */

type Status = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';

interface PortalCandidate {
  id: string;
  name: string;
  position: string | null;
  storeName: string | null;
  pitch: string | null;
  status: Status;
  feedback: string | null;
  /** Alto's interview recommendations, -2 (strong no) to 2 (strong yes). */
  interviewRatings: number[];
  submittedBy: string | null;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

const RATE_KEY: Record<number, MessageKey> = {
  2: 'portal.candRate2',
  1: 'portal.candRate1',
  0: 'portal.candRate0',
  [-1]: 'portal.candRateN1',
  [-2]: 'portal.candRateN2',
};

/** "2 × Strong yes · 1 × Yes", strongest first. */
function Recommendations({ ratings }: { ratings: number[] }) {
  const { t } = useI18n();
  if (ratings.length === 0) {
    return <p className="text-xs text-silver/60">{t('portal.candNoInterviews')}</p>;
  }
  const counts = [2, 1, 0, -1, -2]
    .map((r) => ({ r, n: ratings.filter((x) => x === r).length }))
    .filter((c) => c.n > 0);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-2xs uppercase tracking-wider text-silver">{t('portal.candInterviews')}</span>
      {counts.map(({ r, n }) => (
        <Badge key={r} variant={r > 0 ? 'success' : r < 0 ? 'destructive' : 'outline'}>
          {n > 1 ? `${n} × ` : ''}
          {t(RATE_KEY[r]!)}
        </Badge>
      ))}
    </div>
  );
}

export function PortalCandidates() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const scope = scopeParams(searchParams, isPortal);
  const qs = scope.toString() ? `?${scope.toString()}` : '';

  const query = useQuery({
    queryKey: ['clientPortal', 'candidates', qs],
    queryFn: () => apiFetch<{ canDecide: boolean; candidates: PortalCandidate[] }>(`/client-portal/candidates${qs}`),
    enabled: isPortal || (canPreview && Boolean(previewId)),
    refetchOnWindowFocus: true,
  });
  // A new candidate rings the bell; the list catches up the same moment.
  useEffect(
    () => onLiveEvent('notification', () => void queryClient.invalidateQueries({ queryKey: ['clientPortal', 'candidates'] })),
    [queryClient],
  );

  // The candidate being answered, and which way.
  const [deciding, setDeciding] = useState<{ row: PortalCandidate; decision: 'APPROVED' | 'DECLINED' } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (deciding) setFeedback('');
  }, [deciding]);

  const passing = deciding?.decision === 'DECLINED';
  const submit = async () => {
    if (!deciding) return;
    setBusy(true);
    try {
      await apiFetch(`/client-portal/candidates/${deciding.row.id}/decision`, {
        method: 'POST',
        body: { decision: deciding.decision, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) },
      });
      toast.success(t('portal.candDone'));
      setDeciding(null);
      void queryClient.invalidateQueries({ queryKey: ['clientPortal', 'candidates'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('portal.candFailed'));
      // Someone else at the store may have answered first.
      if (err instanceof ApiError && err.status === 409) {
        setDeciding(null);
        void queryClient.invalidateQueries({ queryKey: ['clientPortal', 'candidates'] });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!isPortal && !canPreview) {
    return <EmptyState icon={UserCheck} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return <EmptyState icon={UserCheck} title={t('portal.candTitle')} description={t('portal.pickClient')} />;
  }

  const rows = query.data?.candidates ?? [];
  const waiting = rows.filter((r) => r.status === 'PENDING');
  const answered = rows.filter((r) => r.status !== 'PENDING');
  const canDecide = query.data?.canDecide ?? false;

  const card = (r: PortalCandidate) => (
    <li key={r.id} className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-medium text-white">{r.name}</div>
          <div className="text-sm text-silver">
            {r.position ?? '—'}
            {' · '}
            {r.storeName ? t('portal.candForStore', { store: r.storeName }) : t('portal.candAnyStore')}
          </div>
        </div>
        {r.status !== 'PENDING' && (
          <Badge variant={r.status === 'APPROVED' ? 'success' : 'destructive'}>
            {r.status === 'APPROVED' ? t('portal.candApproved') : t('portal.candPassed')}
          </Badge>
        )}
      </div>
      {r.pitch && <p className="mt-2 whitespace-pre-wrap text-sm text-silver">{r.pitch}</p>}
      <div className="mt-2">
        <Recommendations ratings={r.interviewRatings} />
      </div>
      <p className="mt-2 text-2xs tabular-nums text-silver/60">
        {t('portal.candBy', { name: r.submittedBy ?? 'Alto', date: fmtDate(r.submittedAt) })}
      </p>
      {r.status === 'PENDING' && canDecide && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
          <Button onClick={() => setDeciding({ row: r, decision: 'APPROVED' })}>
            <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('portal.candApprove')}
          </Button>
          <Button variant="outline" onClick={() => setDeciding({ row: r, decision: 'DECLINED' })}>
            <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('portal.candPass')}
          </Button>
        </div>
      )}
      {r.status !== 'PENDING' && (
        <div className="mt-2 rounded border border-navy-secondary bg-navy-secondary/30 p-2.5">
          <p className="text-2xs text-silver/70">
            {t('portal.candAnsweredBy', {
              status: r.status === 'APPROVED' ? t('portal.candApproved') : t('portal.candPassed'),
              name: r.decidedBy ?? '—',
              date: r.decidedAt ? fmtDate(r.decidedAt) : '',
            })}
          </p>
          {r.feedback && <p className="mt-1 whitespace-pre-wrap text-sm text-silver">{r.feedback}</p>}
        </div>
      )}
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title={t('portal.candTitle')}
        subtitle={t('portal.candHint')}
        breadcrumbs={[{ label: t('portal.title'), to: '/portal' }]}
        secondaryActions={
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/portal${qs}`}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.backHome')}
            </Link>
          </Button>
        }
      />

      {!isPortal && <p className="text-xs text-silver/70">{t('portal.candPreview')}</p>}

      {query.isError && !query.data ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {query.error instanceof ApiError ? query.error.message : t('portal.loadFailed')}
        </ErrorBanner>
      ) : query.isLoading ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="animate-enter">
            <CardContent className="p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                {t('portal.candWaiting')}
                {waiting.length > 0 && <Badge variant="pending">{waiting.length}</Badge>}
              </h2>
              {waiting.length === 0 ? (
                <p className="text-sm text-silver/60">{t('portal.candNone')}</p>
              ) : (
                <ul className="divide-y divide-navy-secondary/60">{waiting.map(card)}</ul>
              )}
            </CardContent>
          </Card>
          {answered.length > 0 && (
            <Card className="animate-enter">
              <CardContent className="p-5">
                <h2 className="mb-3 text-sm font-medium text-white">{t('portal.candAnswered')}</h2>
                <ul className="divide-y divide-navy-secondary/60">{answered.map(card)}</ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Dialog
        open={deciding !== null}
        onOpenChange={(o) => !o && !busy && setDeciding(null)}
        confirmDiscard={() => feedback.trim().length > 0}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deciding
                ? t(passing ? 'portal.candPassTitle' : 'portal.candApproveTitle', { name: deciding.row.name })
                : ''}
            </DialogTitle>
            <DialogDescription>{t(passing ? 'portal.candPassHint' : 'portal.candApproveHint')}</DialogDescription>
          </DialogHeader>
          <Field label={t(passing ? 'portal.candReason' : 'portal.candNote')} required={passing}>
            {(p) => (
              <Textarea {...p} rows={3} maxLength={2000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            )}
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeciding(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={passing ? 'destructive' : 'primary'}
              onClick={() => void submit()}
              loading={busy}
              disabled={busy || (passing && !feedback.trim())}
            >
              {t(passing ? 'portal.candPass' : 'portal.candApprove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
