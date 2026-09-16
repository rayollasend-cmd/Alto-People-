import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageSquarePlus, Send } from 'lucide-react';
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

/** `refetchMs`: the Requests tab polls every minute; the Home embed can ease off. */
export function PortalRequests({ prefill, refetchMs = 60_000 }: { prefill?: RequestPrefill | null; refetchMs?: number }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['clientPortal', 'requests'],
    queryFn: () => apiFetch<{ requests: PortalRequest[] }>('/client-portal/requests'),
    refetchInterval: refetchMs,
  });
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

  const rows = query.data?.requests ?? [];

  return (
    <Card className="animate-enter print:hidden" id="requests">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-white">{t('portal.reqTitle')}</h2>
          <Button size="md" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
            <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('portal.reqNew')}
          </Button>
        </div>
        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-silver/60">{t('portal.reqNone')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-navy-secondary/60">
            {rows.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                    {r.subject}
                  </span>
                  <Badge variant="outline">{t(KIND_KEY[r.kind])}</Badge>
                  <Badge variant={r.overdue ? 'destructive' : STATUS_VARIANT[r.status]}>
                    {r.overdue ? t('portal.reqOverdue') : t(STATUS_KEY[r.status])}
                  </Badge>
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
