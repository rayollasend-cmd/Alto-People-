import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Inbox, Megaphone, RotateCw, Send, Users } from 'lucide-react';
import { dayHeading, dayKey, fmtTimeOnly } from '@/lib/dayGroup';
import { toast } from 'sonner';
import { performWithUndo } from '@/lib/undoToast';
import { pickOne } from '@/lib/validationCopy';
import type {
  EmailSuppression,
  Notification,
  NotificationChannel,
  NotificationStatus,
} from '@alto-people/shared';
import {
  deleteSuppression,
  listAdmin,
  listChannels,
  listSuppressions,
  sendNotification,
} from '@/lib/communicationsApi';
import { listBroadcastTemplates } from '@/lib/dirCommsApi';
import { cn } from '@/lib/cn';
import { BroadcastDrawer } from '@/pages/dirComms/BroadcastDrawer';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDateTime, ymdLocal } from '@/lib/format';
import { userPhotoUrl } from '@/lib/photoUrl';
import {
  AssociatePicker,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonRows,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { ListTemplate } from '@/components/templates';
import { useTerm } from '@/lib/auth';

function statusVariant(
  s: Notification['status'],
): 'pending' | 'success' | 'destructive' | 'info' {
  switch (s) {
    case 'SENT':
    case 'DELIVERED':
      return 'success';
    case 'FAILED':
    case 'BOUNCED':
    case 'COMPLAINED':
      return 'destructive';
    case 'READ':
      return 'info';
    case 'QUEUED':
    case 'SUPPRESSED':
    case 'NOT_CONFIGURED':
      return 'pending';
  }
}

const STATUS_LABELS: Record<NotificationStatus, string> = {
  QUEUED: 'Queued',
  SENT: 'Sent',
  READ: 'Read',
  FAILED: 'Failed',
  BOUNCED: 'Bounced',
  COMPLAINED: 'Marked as spam',
  SUPPRESSED: 'Suppressed',
  DELIVERED: 'Delivered',
  NOT_CONFIGURED: 'Not sent — channel not connected',
};

/** A person's name when the account has one, else the address it went to — never a raw user id. */
const recipientOf = (n: Notification) =>
  n.recipientName ?? n.recipientEmail ?? n.recipientPhone ?? (n.recipientUserId ? 'A user account' : '—');

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Email',
  SMS: 'SMS',
  PUSH: 'Push',
  WHATSAPP: 'WhatsApp',
};

interface AdminCommsViewProps {
  canManage: boolean;
}

/**
 * One send, as the log shows it: a single message, or one message to many
 * people (a reminder fanned out to four admins is one row, "4 people",
 * not four). Grouped by category, subject and the minute it went out.
 */
interface SendGroup {
  key: string;
  first: Notification;
  rows: Notification[];
  sent: number;
  failed: number;
  read: number;
}

const FAILED_STATUSES = new Set<NotificationStatus>(['FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'NOT_CONFIGURED']);

export function groupSends(items: Notification[]): SendGroup[] {
  const groups = new Map<string, SendGroup>();
  for (const n of items) {
    const key = [n.channel, n.category ?? '', n.subject ?? '', n.createdAt.slice(0, 16), n.senderUserId ?? ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { key, first: n, rows: [], sent: 0, failed: 0, read: 0 };
      groups.set(key, g);
    }
    g.rows.push(n);
    if (FAILED_STATUSES.has(n.status)) g.failed++;
    else if (n.status === 'READ' || n.readAt) g.read++;
    else g.sent++;
  }
  return [...groups.values()];
}

const groupRecipients = (g: SendGroup) => (g.rows.length === 1 ? recipientOf(g.first) : `${g.rows.length} people`);

export function AdminCommsView({ canManage }: AdminCommsViewProps) {
  const [showCompose, setShowCompose] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<SendGroup | null>(null);
  const [channelFilter, setChannelFilter] = useState<NotificationChannel | ''>('');
  const [statusFilter, setStatusFilter] = useState<NotificationStatus | ''>('');
  const [resendingId, setResendingId] = useState<string | null>(null);

  const listParams = {
    channel: channelFilter || undefined,
    status: statusFilter || undefined,
  };
  const refreshQuery = useQuery({
    queryKey: ['AdminCommsView', 'items', listParams],
    queryFn: () => listAdmin(listParams),
  });
  const items: Notification[] | null = refreshQuery.data?.notifications ?? null;
  const groups = useMemo(() => (items ? groupSends(items) : null), [items]);
  const error = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load.' : null;
  const refresh = async () => {
    await refreshQuery.refetch();
  };

  const exportCsv = () => {
    if (!items || items.length === 0) return;
    downloadCsv(`communications-${ymdLocal()}.csv`, [
      ['Created', 'Channel', 'Status', 'Recipient', 'Recipient name', 'Subject', 'Body', 'Sender', 'Failure reason'],
      ...items.map((n) => [
        fmtDateTime(n.createdAt),
        n.channel,
        n.status,
        n.recipientEmail ?? n.recipientPhone ?? n.recipientUserId ?? '',
        n.recipientName ?? '',
        n.subject ?? '',
        n.body,
        n.senderEmail ?? 'system',
        n.failureReason ?? '',
      ]),
    ]);
  };

  /** Re-post the exact payload of a FAILED row through the send endpoint. */
  const resend = async (n: Notification) => {
    setResendingId(n.id);
    try {
      const sent = await sendNotification({
        channel: n.channel,
        recipientUserId: n.recipientUserId ?? undefined,
        recipientEmail: n.recipientEmail ?? undefined,
        recipientPhone: n.recipientPhone ?? undefined,
        subject: n.subject ?? undefined,
        body: n.body,
        category: n.category ?? undefined,
      });
      if (sent.status === 'FAILED') {
        toast.error(`Resend failed: ${sent.failureReason ?? 'unknown error'}`);
      } else {
        toast.success('Resent.');
      }
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Resend failed.');
    } finally {
      setResendingId(null);
    }
  };

  const logColumns = useMemo<GridColumn<SendGroup>[]>(
    () => [
      {
        key: 'time',
        header: 'Time',
        accessor: (g) => new Date(g.first.createdAt).getTime(),
        csv: (g) => g.first.createdAt,
        sortable: true,
        searchable: false,
        cardMeta: true,
        width: '6rem',
        className: 'tabular-nums text-ink-muted whitespace-nowrap',
        cell: (g) => <span title={fmtDateTime(g.first.createdAt)}>{fmtTimeOnly(g.first.createdAt)}</span>,
      },
      {
        key: 'channel',
        header: 'Channel',
        accessor: (g) => CHANNEL_LABELS[g.first.channel],
        sortable: true,
        cardMeta: true,
        cell: (g) => <Badge variant="outline">{CHANNEL_LABELS[g.first.channel]}</Badge>,
      },
      {
        key: 'recipient',
        header: 'To',
        accessor: (g) => (g.rows.length === 1 ? recipientOf(g.first) : g.rows.map(recipientOf).join(', ')),
        sortable: true,
        primary: true,
        cell: (g) =>
          g.rows.length === 1 ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <Avatar src={userPhotoUrl(g.first.recipientUserId)} name={recipientOf(g.first)} email={g.first.recipientEmail ?? undefined} size="xs" />
              <span className="min-w-0 break-words text-ink">{recipientOf(g.first)}</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-2.5" title={g.rows.map(recipientOf).join(', ')}>
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 text-ink">{groupRecipients(g)}</span>
            </span>
          ),
      },
      {
        key: 'subject',
        header: 'Subject / preview',
        accessor: (g) => `${g.first.subject ?? ''} ${g.first.body}`,
        sortable: true,
        cell: (g) => (
          <>
            <div className="max-w-md truncate font-medium text-ink">{g.first.subject ?? '(no subject)'}</div>
            <div className="line-clamp-2 max-w-md text-xs text-ink-muted">{g.first.body}</div>
          </>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (g) => (g.failed ? 'Failed' : g.read === g.rows.length ? 'Read' : 'Sent'),
        sortable: true,
        cardMeta: true,
        cell: (g) =>
          g.rows.length === 1 ? (
            <>
              <Badge variant={statusVariant(g.first.status)}>{STATUS_LABELS[g.first.status]}</Badge>
              {g.first.failureReason && <div className="mt-1 text-2xs text-alert">{g.first.failureReason}</div>}
            </>
          ) : (
            <span className="flex flex-wrap gap-1 text-2xs">
              {g.sent > 0 && <Badge variant="success">{g.sent} sent</Badge>}
              {g.read > 0 && <Badge variant="info">{g.read} read</Badge>}
              {g.failed > 0 && <Badge variant="destructive">{g.failed} failed</Badge>}
            </span>
          ),
      },
      ...(canManage
        ? [
            {
              key: 'resend',
              header: 'Resend',
              accessor: () => null,
              searchable: false,
              stopRowClick: true,
              align: 'right',
              cell: (g) =>
                g.rows.length === 1 && g.first.status === 'FAILED' ? (
                  <Button size="xs" variant="outline" disabled={resendingId === g.first.id} onClick={() => void resend(g.first)}>
                    <RotateCw className="mr-1 h-3 w-3" />
                    {resendingId === g.first.id ? 'Resending…' : 'Resend'}
                  </Button>
                ) : null,
            } satisfies GridColumn<SendGroup>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, resendingId],
  );

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Communications"
      subtitle={canManage ? 'Message one person, or broadcast to a client, a department or everyone.' : 'Read-only view of sent notifications.'}
      primaryAction={
        canManage ? (
          <Button onClick={() => setShowCompose(true)}>
            <Send className="h-4 w-4" />
            Send
          </Button>
        ) : undefined
      }
      secondaryActions={
        canManage ? (
          <Button variant="outline" onClick={() => setShowBroadcast(true)}>
            <Megaphone className="h-4 w-4" />
            Broadcast
          </Button>
        ) : undefined
      }
    >
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Sent log</CardTitle>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select size="sm" aria-label="Filter by channel" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as NotificationChannel | '')}>
                <option value="">All channels</option>
                <option value="IN_APP">In-app</option>
                <option value="EMAIL">Email</option>
                <option value="SMS">SMS</option>
                <option value="PUSH">Push</option>
              </Select>
              <Select size="sm" aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as NotificationStatus | '')}>
                <option value="">All statuses</option>
                <option value="QUEUED">Queued</option>
                <option value="SENT">Sent</option>
                <option value="READ">Read</option>
                <option value="FAILED">Failed</option>
                <option value="BOUNCED">Bounced</option>
                <option value="COMPLAINED">Marked as spam</option>
                <option value="SUPPRESSED">Suppressed</option>
                <option value="NOT_CONFIGURED">Not sent — channel not connected</option>
              </Select>
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={!items || items.length === 0}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {error && (
            <ErrorBanner
              className="mb-3"
              action={
                <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                  Retry
                </Button>
              }
            >
              {error}
            </ErrorBanner>
          )}
          {!error && (
            <DataGrid<SendGroup>
              id="comms-log"
              caption="Notification log"
              rows={groups}
              loading={!groups}
              columns={logColumns}
              rowKey={(g) => g.key}
              urlState={false}
              exportCsv={false}
              search={{ placeholder: 'Search people and subjects' }}
              onRowClick={(g) => setDrawerTarget(g)}
              rowActionLabel={(g) => `Open message to ${groupRecipients(g)}`}
              // One table, a heading per day; only today starts open so
              // the log is not an endless scroll.
              groupBy={{
                key: (g) => dayKey(g.first.createdAt),
                header: (key, rows) => (
                  <span className="flex items-center gap-2">
                    <span>{dayHeading(key)}</span>
                    <span className="text-xs font-normal text-ink-muted/70">· {key}</span>
                    <span className="ml-auto text-xs font-normal text-ink-muted">
                      {rows.length} {rows.length === 1 ? 'send' : 'sends'}
                    </span>
                  </span>
                ),
                collapsible: { defaultOpen: (_key, index) => index === 0 },
              }}
              empty={{
                icon: Inbox,
                title: 'No notifications yet',
                description: canManage
                  ? 'Send your first message — it will show up here once delivered.'
                  : 'Notifications you receive or that go out from the system will appear here.',
                action: canManage ? (
                  <Button onClick={() => setShowCompose(true)}>
                    <Send className="h-4 w-4" />
                    Send notification
                  </Button>
                ) : undefined,
              }}
            />
          )}
        </CardContent>
      </Card>

      {canManage && <SuppressionListCard />}

      <ComposeDialog
        open={showCompose}
        onOpenChange={setShowCompose}
        onSent={() => {
          setShowCompose(false);
          void refresh();
        }}
      />
      {showBroadcast && (
        <BroadcastDrawer
          broadcast={null}
          onClose={() => setShowBroadcast(false)}
          onSaved={() => {
            setShowBroadcast(false);
            void refresh();
          }}
        />
      )}

      <Drawer open={!!drawerTarget} onOpenChange={(o) => !o && setDrawerTarget(null)} width="max-w-xl">
        {drawerTarget && (drawerTarget.rows.length === 1 ? <NotificationDetailPanel n={drawerTarget.first} /> : <SendGroupPanel g={drawerTarget} />)}
      </Drawer>
    </ListTemplate>
  );
}

/** One message to many people: the words once, then who got it and how it went. */
function SendGroupPanel({ g }: { g: SendGroup }) {
  const n = g.first;
  return (
    <>
      <DrawerHeader>
        <DrawerTitle className="truncate">{n.subject ?? '(no subject)'}</DrawerTitle>
        <DrawerDescription>
          {g.rows.length} people · {CHANNEL_LABELS[n.channel]} · {fmtDateTime(n.createdAt)}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="mb-5 whitespace-pre-wrap rounded-md border border-line bg-surface-raised p-4 text-sm text-ink">{n.body}</div>
        <ul className="divide-y divide-line" aria-label="Recipients">
          {g.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 py-2 text-sm">
              <Avatar src={userPhotoUrl(r.recipientUserId)} name={recipientOf(r)} email={r.recipientEmail ?? undefined} size="xs" />
              <span className="min-w-0 flex-1 truncate text-ink">{recipientOf(r)}</span>
              <Badge variant={statusVariant(r.status)}>{STATUS_LABELS[r.status]}</Badge>
            </li>
          ))}
        </ul>
      </DrawerBody>
    </>
  );
}

const SUPPRESSION_REASON_LABELS: Record<EmailSuppression['reason'], string> = {
  BOUNCED: 'Hard bounce',
  COMPLAINED: 'Spam complaint',
  MANUAL: 'Added manually',
};

/**
 * Do-not-email list. Populated automatically by the Resend webhook on hard
 * bounce / spam complaint; sends to these addresses short-circuit to a
 * Suppressed status. Removing an address resumes delivery.
 */
export function SuppressionListCard() {
  // Addresses removed in the UI while their undo window is open.
  const [hiddenEmails, setHiddenEmails] = useState<ReadonlySet<string>>(() => new Set());

  const refreshQuery = useQuery({
    queryKey: ['SuppressionListCard', 'rows'],
    queryFn: () => listSuppressions(),
  });
  const rows: EmailSuppression[] | null = refreshQuery.data?.suppressions.filter((s) => !hiddenEmails.has(s.email)) ?? null;
  const error = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load.' : null;
  const refresh = async () => {
    await refreshQuery.refetch();
  };


  const remove = (email: string) => {
    setHiddenEmails((prev) => new Set(prev).add(email));
    performWithUndo({
      message: `${email} can receive email again.`,
      onCommit: async () => {
        await deleteSuppression(email);
        await refresh();
      },
      onUndo: () =>
        setHiddenEmails((prev) => {
          const next = new Set(prev);
          next.delete(email);
          return next;
        }),
      commitFailedMessage: `Couldn't unblock ${email}.`,
    });
  };

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Suppressed emails</CardTitle>
        <p className="text-sm text-silver">
          Addresses that hard-bounced or reported us as spam. Sends to them are
          blocked until removed here.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        {error && (
          <ErrorBanner
            className="mb-3"
            action={
              <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!rows && !error && <SkeletonRows count={2} rowHeight="h-10" />}
        {rows && rows.length === 0 && (
          <p className="text-sm text-silver">
            No suppressed addresses — every mailbox is deliverable.
          </p>
        )}
        {rows && rows.length > 0 && (
          <DataGrid<(typeof rows)[number]>
            id="email-suppressions"
            caption="Suppressed addresses"
            rows={rows}
            rowKey={(sup) => sup.id}
            search={{ placeholder: 'Email…' }}
            urlState={false}
            exportCsv={{ filename: 'email-suppressions' }}
            columns={[
              { key: 'email', header: 'Email', accessor: (sup) => sup.email, sortable: true, primary: true, className: 'text-white break-all' },
              {
                key: 'reason',
                header: 'Reason',
                accessor: (sup) => SUPPRESSION_REASON_LABELS[sup.reason],
                sortable: true,
                cardMeta: true,
                cell: (sup) => (
                  <>
                    <Badge variant="destructive">{SUPPRESSION_REASON_LABELS[sup.reason]}</Badge>
                    {sup.notes && <div className="text-2xs mt-1 text-silver truncate max-w-xs">{sup.notes}</div>}
                  </>
                ),
              },
              { key: 'since', header: 'Since', accessor: (sup) => sup.createdAt, sortable: true, searchable: false, cardMeta: true, className: 'text-silver whitespace-nowrap', cell: (sup) => fmtDateTime(sup.createdAt) },
              {
                key: 'remove',
                header: '',
                accessor: () => null,
                searchable: false,
                csv: () => '',
                align: 'right',
                stopRowClick: true,
                width: '6rem',
                cell: (sup) => (
                  <Button size="xs" variant="outline" onClick={() => remove(sup.email)}>
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

function NotificationDetailPanel({ n }: { n: Notification }) {
  const recipient = recipientOf(n);
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            src={userPhotoUrl(n.recipientUserId)}
            name={recipient}
            email={n.recipientEmail ?? undefined}
            size="md"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {n.subject ?? '(no subject)'}
            </DrawerTitle>
            <DrawerDescription>
              {recipient} · {CHANNEL_LABELS[n.channel]}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex items-center gap-2 mb-4">
          <Badge variant={statusVariant(n.status)}>{STATUS_LABELS[n.status]}</Badge>
          {n.category && (
            <Badge variant="outline" className="text-2xs">
              {n.category}
            </Badge>
          )}
        </div>

        <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-4 mb-5 whitespace-pre-wrap text-sm text-white">
          {n.body}
        </div>

        {n.failureReason && (
          <div
            className="rounded-md border border-alert/40 bg-alert/[0.07] p-3 mb-5 text-sm text-alert"
            role="alert"
          >
            <div className="font-medium mb-0.5">Delivery failed</div>
            <div className="text-alert/90 break-words">{n.failureReason}</div>
          </div>
        )}

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <DetailRow label="Channel">{CHANNEL_LABELS[n.channel]}</DetailRow>
          <DetailRow label="Status">{STATUS_LABELS[n.status]}</DetailRow>
          <DetailRow label="Recipient email">
            {n.recipientEmail ?? <Mute>—</Mute>}
          </DetailRow>
          <DetailRow label="Recipient phone">
            {n.recipientPhone ?? <Mute>—</Mute>}
          </DetailRow>
          <DetailRow label="Sender">
            {n.senderEmail ?? <Mute>system</Mute>}
          </DetailRow>
          <DetailRow label="Category">
            {n.category ?? <Mute>—</Mute>}
          </DetailRow>
          <DetailRow label="Created">{fmtDateTime(n.createdAt)}</DetailRow>
          <DetailRow label="Sent">
            {n.sentAt ? fmtDateTime(n.sentAt) : <Mute>not sent</Mute>}
          </DetailRow>
          <DetailRow label="Read">
            {n.readAt ? fmtDateTime(n.readAt) : <Mute>unread</Mute>}
          </DetailRow>
          <DetailRow label="External ref">
            {n.externalRef ? (
              <span className="font-mono text-xs">{n.externalRef}</span>
            ) : (
              <Mute>—</Mute>
            )}
          </DetailRow>
        </dl>
      </DrawerBody>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-widest text-silver/80">
        {label}
      </dt>
      <dd className="text-white text-sm mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function Mute({ children }: { children: React.ReactNode }) {
  return <span className="text-silver/80">{children}</span>;
}

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

/**
 * One message to one person. Pick the person — the server finds their
 * account, email and phone, whichever the channel needs. A channel with
 * nothing behind it is shown disabled with the reason. An address outside
 * the directory is a second, explicit choice.
 */
function ComposeDialog({ open, onOpenChange, onSent }: ComposeDialogProps) {
  const term = useTerm();
  const channelsQuery = useQuery({ queryKey: ['communications', 'channels'], queryFn: listChannels, staleTime: 5 * 60_000, enabled: open });
  const templates = useQuery({ queryKey: ['dirComms', 'broadcast-templates'], queryFn: listBroadcastTemplates, enabled: open, retry: false });
  const [channel, setChannel] = useState<NotificationChannel>('IN_APP');
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [external, setExternal] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChannel('IN_APP');
      setAssociate(null);
      setExternal(false);
      setRecipientEmail('');
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open]);

  const channels = channelsQuery.data?.channels ?? [
    { channel: 'IN_APP' as NotificationChannel, available: true, reason: null },
  ];
  const chosen = channels.find((c) => c.channel === channel);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!external && !associate) {
      setError(`${pickOne(term).replace(/\.$/, '')}.`);
      return;
    }
    if (external && !recipientEmail) {
      setError('Enter the email address.');
      return;
    }
    setSubmitting(true);
    try {
      await sendNotification({
        channel: external ? 'EMAIL' : channel,
        ...(external ? { recipientEmail } : { recipientAssociateId: associate!.id }),
        subject: subject || undefined,
        body,
      });
      toast.success(external ? `Sent to ${recipientEmail}.` : `Sent to ${associate!.name}.`);
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Send failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const emailReady = channels.find((c) => c.channel === 'EMAIL')?.available ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send a message</DialogTitle>
          <DialogDescription>To one person. Every send is recorded in the log.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          {!external ? (
            <Field label="To">
              {(p) => <AssociatePicker id={p.id} value={associate} onChange={setAssociate} />}
            </Field>
          ) : (
            <Field label="Email address">
              {(p) => <Input {...p} type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />}
            </Field>
          )}
          <button
            type="button"
            className="-mt-2 justify-self-start text-xs text-accent hover:underline disabled:text-ink-muted disabled:no-underline"
            disabled={!external && !emailReady}
            title={!external && !emailReady ? 'No email provider connected' : undefined}
            onClick={() => setExternal((v) => !v)}
          >
            {external ? 'Pick someone from the directory instead' : 'Someone not in the directory? Send by email'}
          </button>

          {!external && (
            <fieldset>
              <legend className="text-sm font-medium text-ink">Channel</legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {channels.map((c) => (
                  <button
                    key={c.channel}
                    type="button"
                    aria-pressed={channel === c.channel}
                    disabled={!c.available}
                    title={c.reason ?? undefined}
                    onClick={() => setChannel(c.channel)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs',
                      channel === c.channel ? 'border-accent bg-accent-fill/15 text-ink' : 'border-line text-ink-muted hover:text-ink',
                      !c.available && 'cursor-not-allowed opacity-60 hover:text-ink-muted',
                    )}
                  >
                    {CHANNEL_LABELS[c.channel]}
                  </button>
                ))}
              </div>
              {channels.some((c) => !c.available) && (
                <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
                  {channels
                    .filter((c) => !c.available && c.reason)
                    .map((c) => (
                      <li key={c.channel}>
                        <span className="text-ink">{CHANNEL_LABELS[c.channel]}:</span> {c.reason}
                      </li>
                    ))}
                </ul>
              )}
              {chosen && !chosen.available && <p className="mt-1 text-xs text-warning">{chosen.reason}</p>}
            </fieldset>
          )}

          {(templates.data?.broadcasts.length ?? 0) > 0 && (
            <Field label="Start from a template">
              {(p) => (
                <Select
                  {...p}
                  defaultValue=""
                  onChange={(e) => {
                    const t = templates.data?.broadcasts.find((x) => x.id === e.target.value);
                    if (t) {
                      setSubject(t.title);
                      setBody(t.body);
                    }
                  }}
                >
                  <option value="">Blank</option>
                  {templates.data!.broadcasts.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.templateName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Subject">
            {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}
          </Field>
          <Field label="Message" required>
            {(p) => <Textarea {...p} required rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting || (!external && chosen !== undefined && !chosen.available)}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
