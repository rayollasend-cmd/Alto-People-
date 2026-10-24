import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, MoreHorizontal, RotateCw, Send, Users } from '@/components/ui/icons';
import { dayHeading, dayKey, fmtTimeOnly, isRelativeDayHeading } from '@/lib/dayGroup';
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
import { listBroadcastTemplates, listBroadcasts } from '@/lib/dirCommsApi';
import { cn } from '@/lib/cn';
import { BroadcastDrawer } from '@/pages/dirComms/BroadcastDrawer';
import { ApiError } from '@/lib/api';
import { fmtCount, fmtDateOnly, fmtDateTime } from '@/lib/format';
import { personPhotoUrl } from '@/lib/photoUrl';
import { useUrlParam } from '@/lib/useUrlState';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorBanner,
  Field,
  Input,
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { useTerm } from '@/lib/auth';
import { BROADCASTS_KEY, BroadcastsPanel, waitingBroadcasts } from './BroadcastsPanel';

type BadgeVariant = 'pending' | 'success' | 'destructive' | 'info' | 'default';

/** How one message's delivery reads: an email with no provider went nowhere, whatever its stored status. */
export function deliveryOf(n: Notification): 'sent' | 'read' | 'failed' | 'notSent' | 'queued' {
  if (n.loggedOnly || n.status === 'NOT_CONFIGURED') return 'notSent';
  if (n.status === 'FAILED' || n.status === 'BOUNCED' || n.status === 'COMPLAINED' || n.status === 'SUPPRESSED') return 'failed';
  if (n.status === 'READ' || n.readAt) return 'read';
  if (n.status === 'QUEUED') return 'queued';
  return 'sent';
}

function statusVariant(n: Notification): BadgeVariant {
  switch (deliveryOf(n)) {
    case 'sent':
      return 'success';
    case 'read':
      return 'info';
    case 'failed':
      return 'destructive';
    case 'queued':
      return 'pending';
    case 'notSent':
      // Grey, not red: nothing failed — there was nothing to send it through.
      return 'default';
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

/** The status in words; an email written to the server log says so instead of "Sent". */
export function statusLabelOf(n: Notification): string {
  return n.loggedOnly ? 'Not sent: no email provider' : STATUS_LABELS[n.status];
}

/** A person's name when the account has one, else the address it went to — never a raw user id. */
const recipientOf = (n: Notification) =>
  n.recipientName ?? n.recipientEmail ?? n.recipientPhone ?? (n.recipientUserId ? 'A user account' : '—');
/** One person across channels: the account, else the address. */
const personKeyOf = (n: Notification) => n.recipientUserId ?? n.recipientEmail ?? n.recipientPhone ?? n.id;
const photoOf = (n: Notification) => personPhotoUrl({ photoUrl: n.recipientPhotoUrl, userId: n.recipientUserId });

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Email',
  SMS: 'SMS',
  PUSH: 'Push',
  WHATSAPP: 'WhatsApp',
};
const CHANNEL_ORDER: NotificationChannel[] = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP'];

/**
 * One message, as the log shows it: the same words to one person or many,
 * by every channel it went by — a reminder fanned out to four admins by
 * email and in-app is one row ("4 people · Email · In-app"), not eight.
 * Grouped by category, subject, the minute it went out and the sender.
 */
export interface SendGroup {
  key: string;
  first: Notification;
  rows: Notification[];
  channels: NotificationChannel[];
  people: number;
  sent: number;
  failed: number;
  read: number;
  notSent: number;
  queued: number;
}

export function groupSends(items: Notification[]): SendGroup[] {
  const groups = new Map<string, SendGroup & { who: Set<string> }>();
  for (const n of items) {
    const key = [n.category ?? '', n.subject ?? '', n.createdAt.slice(0, 16), n.senderUserId ?? ''].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { key, first: n, rows: [], channels: [], people: 0, sent: 0, failed: 0, read: 0, notSent: 0, queued: 0, who: new Set() };
      groups.set(key, g);
    }
    g.rows.push(n);
    if (!g.channels.includes(n.channel)) g.channels.push(n.channel);
    g.who.add(personKeyOf(n));
    g[deliveryOf(n)]++;
  }
  return [...groups.values()].map(({ who, ...g }) => ({
    ...g,
    people: who.size,
    channels: [...g.channels].sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)),
  }));
}

const groupRecipients = (g: SendGroup) => (g.people === 1 ? recipientOf(g.first) : `${g.people} people`);
const failedRows = (g: SendGroup) => g.rows.filter((r) => r.status === 'FAILED');

const STATUS_FILTERS: NotificationStatus[] = ['QUEUED', 'SENT', 'READ', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'NOT_CONFIGURED'];
const CHANNEL_FILTERS: NotificationChannel[] = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'];
const VIEWS = ['log', 'broadcasts'] as const;

interface AdminCommsViewProps {
  canManage: boolean;
  /** Which composer the page header opened ("Send", "New broadcast"); null when none. */
  compose?: 'send' | 'broadcast' | null;
  onComposeChange?: (next: 'send' | 'broadcast' | null) => void;
}

/**
 * Notifications › Sends & broadcasts: the log of every message that went
 * out (one row per message, its channels as chips, an honest status), and
 * the broadcasts — drafts to review, scheduled, sent. The page header holds
 * Send and New broadcast; this is the body under it.
 */
export function AdminCommsView({ canManage, compose = null, onComposeChange }: AdminCommsViewProps) {
  const qc = useQueryClient();
  const [view, setView] = useUrlParam<(typeof VIEWS)[number]>('view', 'log', VIEWS, { history: 'push' });
  const [drawerTarget, setDrawerTarget] = useState<SendGroup | null>(null);
  const [channelFilter, setChannelFilter] = useUrlParam<NotificationChannel | ''>('channel', '', ['', ...CHANNEL_FILTERS]);
  const [statusFilter, setStatusFilter] = useUrlParam<NotificationStatus | ''>('status', '', ['', ...STATUS_FILTERS]);
  const [resendingKey, setResendingKey] = useState<string | null>(null);
  const setCompose = (next: 'send' | 'broadcast' | null) => onComposeChange?.(next);

  const listParams = {
    channel: channelFilter || undefined,
    status: statusFilter || undefined,
  };
  const refreshQuery = useQuery({
    queryKey: ['AdminCommsView', 'items', listParams],
    queryFn: () => listAdmin(listParams),
  });
  const items: Notification[] | null = refreshQuery.data?.notifications ?? null;
  const total = refreshQuery.data?.total ?? null;
  const groups = useMemo(() => (items ? groupSends(items) : null), [items]);
  const error = refreshQuery.error ? (refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load.') : null;
  const refresh = async () => {
    await refreshQuery.refetch();
  };

  // Drafts waiting (Marketing's announcements to review, scheduled sends): said on the log, one click from them.
  const broadcastsQuery = useQuery({ queryKey: BROADCASTS_KEY, queryFn: () => listBroadcasts(), enabled: canManage });
  const waiting = waitingBroadcasts(broadcastsQuery.data?.broadcasts);

  /** Re-post the exact payload of each FAILED row in the message through the send endpoint. */
  const resend = async (g: SendGroup) => {
    const rows = failedRows(g);
    if (rows.length === 0) return;
    setResendingKey(g.key);
    let failed = 0;
    try {
      for (const n of rows) {
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
          if (sent.status === 'FAILED') failed++;
        } catch {
          failed++;
        }
      }
      if (failed > 0) toast.error(`${failed} of ${rows.length} still failed.`);
      else toast.success(rows.length === 1 ? 'Resent.' : `Resent to ${rows.length}.`);
      void refresh();
    } finally {
      setResendingKey(null);
    }
  };

  const logColumns = useMemo<GridColumn<SendGroup>[]>(
    () => [
      {
        key: 'time',
        header: 'Time',
        accessor: (g) => new Date(g.first.createdAt).getTime(),
        csv: (g) => fmtDateTime(g.first.createdAt),
        sortable: true,
        searchable: false,
        cardMeta: true,
        width: '6rem',
        className: 'tabular-nums text-ink-muted whitespace-nowrap',
        cell: (g) => <span title={fmtDateTime(g.first.createdAt)}>{fmtTimeOnly(g.first.createdAt)}</span>,
      },
      {
        key: 'recipient',
        header: 'To',
        accessor: (g) => (g.people === 1 ? recipientOf(g.first) : [...new Set(g.rows.map(recipientOf))].join(', ')),
        sortable: true,
        primary: true,
        cell: (g) =>
          g.people === 1 ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <Avatar src={photoOf(g.first)} name={recipientOf(g.first)} email={g.first.recipientEmail ?? undefined} size="xs" />
              <span className="min-w-0 break-words text-ink">{recipientOf(g.first)}</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-2.5" title={[...new Set(g.rows.map(recipientOf))].join(', ')}>
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 text-ink">{groupRecipients(g)}</span>
            </span>
          ),
      },
      {
        key: 'subject',
        header: 'Message',
        accessor: (g) => `${g.first.subject ?? ''} ${g.first.body}`,
        csv: (g) => g.first.subject ?? '',
        sortable: true,
        cell: (g) => (
          <>
            <div className="max-w-md truncate font-medium text-ink">{g.first.subject ?? '(no subject)'}</div>
            <div className="max-w-md truncate text-xs text-ink-muted">{g.first.body.split('\n').find((l) => l.trim()) ?? ''}</div>
          </>
        ),
      },
      {
        key: 'channel',
        header: 'Channels',
        accessor: (g) => g.channels.map((c) => CHANNEL_LABELS[c]).join(' · '),
        sortable: true,
        cardMeta: true,
        cell: (g) => (
          <span className="flex flex-wrap gap-1">
            {g.channels.map((c) => (
              <Badge key={c} variant="outline">
                {CHANNEL_LABELS[c]}
              </Badge>
            ))}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        accessor: (g) => (g.rows.length === 1 ? statusLabelOf(g.first) : [g.sent && `${g.sent} sent`, g.read && `${g.read} read`, g.notSent && `${g.notSent} not sent`, g.failed && `${g.failed} failed`, g.queued && `${g.queued} queued`].filter(Boolean).join(', ')),
        sortable: true,
        cardMeta: true,
        cell: (g) =>
          g.rows.length === 1 ? (
            <>
              <Badge variant={statusVariant(g.first)}>{statusLabelOf(g.first)}</Badge>
              {g.first.failureReason && deliveryOf(g.first) === 'failed' && <div className="mt-1 text-2xs text-alert">{g.first.failureReason}</div>}
            </>
          ) : (
            <span className="flex flex-wrap gap-1 text-2xs">
              {g.sent > 0 && <Badge variant="success">{g.sent} sent</Badge>}
              {g.read > 0 && <Badge variant="info">{g.read} read</Badge>}
              {g.queued > 0 && <Badge variant="pending">{g.queued} queued</Badge>}
              {g.notSent > 0 && (
                <Badge variant="default" title={g.rows.some((r) => r.loggedOnly) ? 'No email provider is connected: these were written to the server log, not sent.' : 'The channel is not connected.'}>
                  {g.notSent} not sent
                </Badge>
              )}
              {g.failed > 0 && <Badge variant="destructive">{g.failed} failed</Badge>}
            </span>
          ),
      },
      {
        key: 'more',
        header: '',
        accessor: () => null,
        csv: () => '',
        searchable: false,
        stopRowClick: true,
        align: 'right',
        width: '3rem',
        cell: (g) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" aria-label={`More for the message to ${groupRecipients(g)}`} loading={resendingKey === g.key}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDrawerTarget(g)}>Open</DropdownMenuItem>
              {canManage && failedRows(g).length > 0 && (
                <DropdownMenuItem onSelect={() => void resend(g)}>
                  <RotateCw className="mr-2 h-3.5 w-3.5" />
                  {failedRows(g).length === 1 ? 'Resend' : `Resend the ${failedRows(g).length} that failed`}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, resendingKey],
  );

  const activeFilters = (channelFilter ? 1 : 0) + (statusFilter ? 1 : 0);
  const clearFilters = () => {
    setChannelFilter('');
    setStatusFilter('');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          ariaLabel="What to show"
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: 'log' as const, label: 'Sent log' },
            { value: 'broadcasts' as const, label: 'Broadcasts', count: waiting.length || undefined },
          ]}
        />
        {view === 'log' && waiting.length > 0 && (
          <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setView('broadcasts')}>
            {waiting.length === 1 ? '1 broadcast is waiting to be sent' : `${waiting.length} broadcasts are waiting to be sent`} — review
          </button>
        )}
      </div>

      {view === 'broadcasts' ? (
        <BroadcastsPanel />
      ) : error ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : (
        <DataGrid<SendGroup>
          id="comms-log"
          caption="Sent log"
          noun={{ one: 'message', many: 'messages' }}
          rows={groups}
          loading={!groups}
          columns={logColumns}
          rowKey={(g) => g.key}
          urlKey="log"
          exportCsv={{ filename: 'sent-log' }}
          search={{ placeholder: 'Search people and subjects' }}
          onRowClick={(g) => setDrawerTarget(g)}
          rowActionLabel={(g) => `Open the message to ${groupRecipients(g)}`}
          filters={
            <>
              <Select size="sm" aria-label="Channel" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value as NotificationChannel | '')}>
                <option value="">All channels</option>
                {CHANNEL_FILTERS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c]}
                  </option>
                ))}
              </Select>
              <Select size="sm" aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as NotificationStatus | '')}>
                <option value="">All statuses</option>
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>
                    {s === 'NOT_CONFIGURED' ? 'Not sent (nothing connected)' : STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </>
          }
          activeFilters={activeFilters}
          onClearFilters={clearFilters}
          footnote={
            items && total !== null && total > items.length
              ? `The latest ${items.length.toLocaleString()} of ${fmtCount(total, 'message')}. Pick a channel or a status to reach older ones.`
              : undefined
          }
          // One table, a heading per day; only today starts open so the log
          // is not an endless scroll.
          groupBy={{
            key: (g) => dayKey(g.first.createdAt),
            header: (key, rows) => (
              <span className="flex items-center gap-2">
                <span>{dayHeading(key)}</span>
                {isRelativeDayHeading(dayHeading(key)) && <span className="text-xs font-normal text-ink-muted/70">· {fmtDateOnly(key)}</span>}
                <span className="ml-auto text-xs font-normal text-ink-muted">
                  {rows.length} {rows.length === 1 ? 'message' : 'messages'}
                </span>
              </span>
            ),
            collapsible: { defaultOpen: (_key, index) => index === 0 },
          }}
          empty={{
            icon: Inbox,
            title: 'Nothing sent yet',
            description: canManage
              ? 'Messages and broadcasts show up here, with how each one was delivered.'
              : 'Notifications that go out from the system will appear here.',
            action: canManage ? (
              <Button onClick={() => setCompose('send')}>
                <Send className="h-4 w-4" />
                Send a message
              </Button>
            ) : undefined,
          }}
        />
      )}

      {canManage && view === 'log' && <SuppressionListCard />}

      <ComposeDialog
        open={compose === 'send'}
        onOpenChange={(o) => setCompose(o ? 'send' : null)}
        onSent={() => {
          setCompose(null);
          void refresh();
        }}
      />
      {compose === 'broadcast' && (
        <BroadcastDrawer
          broadcast={null}
          onClose={() => setCompose(null)}
          onSaved={() => {
            setCompose(null);
            void qc.invalidateQueries({ queryKey: BROADCASTS_KEY });
            void refresh();
          }}
        />
      )}

      <Drawer open={!!drawerTarget} onOpenChange={(o) => !o && setDrawerTarget(null)} width="max-w-xl">
        {drawerTarget && (drawerTarget.rows.length === 1 ? <NotificationDetailPanel n={drawerTarget.first} /> : <SendGroupPanel g={drawerTarget} />)}
      </Drawer>
    </div>
  );
}

/** One message to many people (or by several channels): the words once, then who got it, how, and how it went. */
function SendGroupPanel({ g }: { g: SendGroup }) {
  const n = g.first;
  return (
    <>
      <DrawerHeader>
        <DrawerTitle className="truncate">{n.subject ?? '(no subject)'}</DrawerTitle>
        <DrawerDescription>
          {g.people === 1 ? recipientOf(n) : `${g.people} people`} · {g.channels.map((c) => CHANNEL_LABELS[c]).join(' · ')} · {fmtDateTime(n.createdAt)}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="mb-5 whitespace-pre-wrap rounded-md border border-line bg-surface-raised p-4 text-sm text-ink">{n.body}</div>
        <ul className="divide-y divide-line" aria-label="Recipients">
          {g.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2.5 py-2 text-sm">
              <Avatar src={photoOf(r)} name={recipientOf(r)} email={r.recipientEmail ?? undefined} size="xs" />
              <span className="min-w-0 flex-1 truncate text-ink">{recipientOf(r)}</span>
              <Badge variant="outline">{CHANNEL_LABELS[r.channel]}</Badge>
              <Badge variant={statusVariant(r)}>{statusLabelOf(r)}</Badge>
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
            src={photoOf(n)}
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
          <Badge variant={statusVariant(n)}>{statusLabelOf(n)}</Badge>
          {n.category && (
            <Badge variant="outline" className="text-2xs">
              {n.category}
            </Badge>
          )}
        </div>

        <div className="mb-5 whitespace-pre-wrap rounded-md border border-line bg-surface-raised p-4 text-sm text-ink">
          {n.body}
        </div>

        {deliveryOf(n) === 'notSent' && (
          <p className="mb-5 rounded-md border border-line p-3 text-sm text-ink-muted">
            {n.loggedOnly
              ? 'No email provider is connected, so this was written to the server log instead of being sent.'
              : n.failureReason ?? 'The channel is not connected, so nothing was sent.'}
          </p>
        )}

        {n.failureReason && deliveryOf(n) === 'failed' && (
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
          <DetailRow label="Status">{statusLabelOf(n)}</DetailRow>
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
            {n.sentAt && !n.loggedOnly ? fmtDateTime(n.sentAt) : <Mute>not sent</Mute>}
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
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
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
