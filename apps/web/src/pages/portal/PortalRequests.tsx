import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { onLiveEvent } from '@/lib/liveEvents';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageSquarePlus, Send } from '@/components/ui/icons';
import { ApiError, apiFetch } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
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
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useUrlParam } from '@/lib/useUrlState';

/**
 * The client's side of the loop: make a structured request (staffing /
 * feedback / issue / billing), optionally about a named person from the
 * store's own roster, and watch it move — received → in progress →
 * resolved — with the desk that owns it, the person who picked it up,
 * the promised reply-by date, and Alto's reply. The request lands as a
 * baton on the right desk the moment it's sent, and the requester hears
 * back on pickup and on reply.
 */

export type ReqKind = 'STAFFING' | 'FEEDBACK' | 'ISSUE' | 'BILLING';
type ReqStatus = 'RECEIVED' | 'IN_PROGRESS' | 'RESOLVED';

interface PortalRequest {
  id: string;
  kind: ReqKind;
  subject: string;
  body: string;
  status: ReqStatus;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
  dueAt: string | null;
  desk: string;
  owner: string | null;
  overdue: boolean;
  associateId: string | null;
  associateName: string | null;
}

const KIND_KEY: Record<ReqKind, MessageKey> = {
  STAFFING: 'portal.reqKindStaffing',
  FEEDBACK: 'portal.reqKindFeedback',
  ISSUE: 'portal.reqKindIssue',
  BILLING: 'portal.reqKindBilling',
};
const STATUS_KEY: Record<ReqStatus, MessageKey> = {
  RECEIVED: 'portal.reqReceived',
  IN_PROGRESS: 'portal.reqInProgress',
  RESOLVED: 'portal.reqResolved',
};
const STATUS_VARIANT: Record<ReqStatus, 'pending' | 'accent' | 'success'> = {
  RECEIVED: 'pending',
  IN_PROGRESS: 'accent',
  RESOLVED: 'success',
};

export interface RequestPrefill {
  kind: ReqKind;
  subject: string;
  body?: string;
  associateId?: string | null;
  /** Bump to re-open the dialog with a fresh prefill. */
  nonce: number;
}

type Show = 'open' | 'resolved';
const SHOWS: readonly Show[] = ['open', 'resolved'];

/**
 * `refetchMs`: the Requests tab polls every minute; the Home embed can ease off.
 * `bare`: the page's own header carries the title and "Make a request" (the
 * Requests page), so the list drops its card title — "Requests" sat twice.
 * `tabs`: Open | Resolved, kept in the URL (?show=).
 */
export function PortalRequests({
  prefill,
  refetchMs = 60_000,
  bare = false,
  tabs = false,
}: {
  prefill?: RequestPrefill | null;
  refetchMs?: number;
  bare?: boolean;
  tabs?: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['clientPortal', 'requests'],
    queryFn: () => apiFetch<{ requests: PortalRequest[] }>('/client-portal/requests'),
    refetchInterval: refetchMs,
    refetchOnWindowFocus: true,
  });
  // A reply or pick-up rings the bell; the list catches up the same moment.
  useEffect(
    () => onLiveEvent('notification', () => void queryClient.invalidateQueries({ queryKey: ['clientPortal', 'requests'] })),
    [queryClient],
  );
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReqKind>('STAFFING');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [associateId, setAssociateId] = useState('');
  const [busy, setBusy] = useState(false);
  // The store's own people — loaded only when the dialog is open.
  const people = useQuery({
    queryKey: ['clientPortal', 'people'],
    queryFn: () =>
      apiFetch<{ people: Array<{ id: string; name: string; position: string }> }>(
        '/client-portal/people',
      ),
    enabled: open,
    staleTime: 5 * 60_000,
  });

  // A "dispute this statement" click, or a digest link, opens the
  // dialog pre-addressed with the subject named.
  useEffect(() => {
    if (!prefill) return;
    setKind(prefill.kind);
    setSubject(prefill.subject);
    setBody(prefill.body ?? '');
    setAssociateId(prefill.associateId ?? '');
    setOpen(true);
  }, [prefill]);

  const dirty = () => subject.trim().length > 0 || body.trim().length > 0;
  const aboutPerson = kind === 'FEEDBACK' || kind === 'ISSUE';

  const submit = async () => {
    setBusy(true);
    try {
      await apiFetch('/client-portal/requests', {
        method: 'POST',
        body: {
          kind,
          subject: subject.trim(),
          body: body.trim(),
          associateId: aboutPerson && associateId ? associateId : null,
        },
      });
      setOpen(false);
      setSubject('');
      setBody('');
      setAssociateId('');
      setKind('STAFFING');
      void queryClient.invalidateQueries({ queryKey: ['clientPortal', 'requests'] });
      toast.success(t('portal.reqSent'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('portal.reqFailed'));
    } finally {
      setBusy(false);
    }
  };

  const allRows = query.data?.requests ?? [];
  // A notification or a Needs-you row links to one request (?id=): open the
  // list on it, scrolled into view and marked.
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('id');
  const [showParam, setShow] = useUrlParam<Show>('show', 'open', SHOWS);
  const openCount = allRows.filter((r) => r.status !== 'RESOLVED').length;
  const resolvedCount = allRows.length - openCount;
  // A linked request opens on its own tab (a reply lands on a resolved one).
  const focusRow = focusId ? allRows.find((r) => r.id === focusId) : undefined;
  const show: Show = focusRow && !searchParams.get('show') ? (focusRow.status === 'RESOLVED' ? 'resolved' : 'open') : showParam;
  const rows = tabs ? allRows.filter((r) => (show === 'resolved' ? r.status === 'RESOLVED' : r.status !== 'RESOLVED')) : allRows;
  const focusFound = !!focusId && rows.some((r) => r.id === focusId);
  useEffect(() => {
    if (!focusFound || !focusId) return;
    document.getElementById(`request-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusFound, focusId]);

  return (
    <Card className="animate-enter print:hidden" id="requests">
      <CardContent>
        {!bare && (
          <SectionTitle
            size="sm"
            wrap
            className="mb-0"
            title={t('portal.reqTitle')}
            trailing={
              <Button size="md" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
                <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {t('portal.reqNew')}
              </Button>
            }
          />
        )}
        {tabs && allRows.length > 0 && (
          <SegmentedControl
            className={cn(!bare && 'mt-3')}
            ariaLabel={t('portal.reqShowAria')}
            value={show}
            onChange={setShow}
            options={[
              { value: 'open', label: t('portal.reqShowOpen'), count: openCount },
              { value: 'resolved', label: t('portal.reqShowResolved'), count: resolvedCount },
            ]}
          />
        )}
        {query.isError && !query.data ? (
          <div className="mt-3">
            <ErrorBanner
              action={
                <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t('portal.loadFailed')}
            </ErrorBanner>
          </div>
        ) : query.isLoading ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-silver/60">
            {tabs && allRows.length > 0 ? (show === 'open' ? t('portal.reqNoneOpen') : t('portal.reqNoneResolved')) : t('portal.reqNone')}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-navy-secondary/60">
            {rows.map((r) => (
              <li
                key={r.id}
                id={`request-${r.id}`}
                data-testid="portal-request"
                className={cn('scroll-mt-24 py-3', focusId === r.id && '-mx-2 rounded-md bg-gold/5 px-2 ring-1 ring-gold/40')}
              >
                {/* The subject on its own line: it shared a row with two
                    badges and collapsed to "T" on a phone (F500 G5). */}
                <p className="line-clamp-2 break-words text-sm font-medium text-white">{r.subject}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{t(KIND_KEY[r.kind])}</Badge>
                  {/* The status always shows; a late reply is Alto's lateness, said as such. */}
                  <Badge variant={STATUS_VARIANT[r.status]}>{t(STATUS_KEY[r.status])}</Badge>
                  {r.overdue && r.dueAt && (
                    <span className="text-xs font-medium tabular-nums text-alert" data-testid="request-reply-overdue">
                      {t('portal.reqReplyOverdue', {
                        count: Math.max(1, Math.floor((Date.now() - Date.parse(r.dueAt)) / 86_400_000)),
                      })}
                    </span>
                  )}
                </div>
                {r.associateName && (
                  <p className="mt-1 text-xs text-silver">
                    {t('portal.reqAbout', { name: r.associateName })}
                  </p>
                )}
                <p className="mt-1 line-clamp-3 text-xs text-silver/70">{r.body}</p>
                <p className="mt-1 text-2xs tabular-nums text-silver/50">
                  {fmtDate(r.createdAt)}
                  {' · '}
                  {r.owner
                    ? t('portal.reqOwner', { name: r.owner, desk: r.desk })
                    : t('portal.reqDesk', { desk: r.desk })}
                  {r.status !== 'RESOLVED' && r.dueAt && (
                    <>
                      {' · '}
                      {t('portal.reqDue', { when: fmtDate(r.dueAt) })}
                    </>
                  )}
                </p>
                {r.resolution && (
                  <div className="mt-2 rounded border border-success/30 bg-success/5 p-2.5">
                    <div className="text-2xs font-medium uppercase tracking-wider text-success">
                      {t('portal.reqReply')}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-silver">{r.resolution}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)} confirmDiscard={dirty}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('portal.reqNew')}</DialogTitle>
            <DialogDescription>{t('portal.reqDialogHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select
              aria-label={t('portal.reqKindLabel')}
              value={kind}
              onChange={(e) => setKind(e.target.value as ReqKind)}
            >
              {(Object.keys(KIND_KEY) as ReqKind[]).map((k) => (
                <option key={k} value={k}>
                  {t(KIND_KEY[k])}
                </option>
              ))}
            </Select>
            {aboutPerson && (
              <Select
                aria-label={t('portal.reqAboutLabel')}
                value={associateId}
                onChange={(e) => setAssociateId(e.target.value)}
              >
                <option value="">{t('portal.reqAboutNone')}</option>
                {(people.data?.people ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.position}
                  </option>
                ))}
              </Select>
            )}
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('portal.reqSubject')}
              maxLength={200}
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('portal.reqBody')}
              rows={4}
              maxLength={4000}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void submit()}
              loading={busy}
              disabled={subject.trim().length < 3 || !body.trim()}
            >
              <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('portal.reqSend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
