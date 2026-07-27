import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Download, Inbox, Megaphone, RotateCw, Send } from 'lucide-react';
import { dayHeading, fmtTimeOnly, groupByDay } from '@/lib/dayGroup';
import { toast } from 'sonner';
import type {
  Notification,
  NotificationChannel,
  NotificationStatus,
} from '@alto-people/shared';
import {
  broadcast,
  listAdmin,
  sendNotification,
} from '@/lib/communicationsApi';
import { listDirectory } from '@/lib/directoryApi';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDateTime, ymdLocal } from '@/lib/format';
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
  EmptyState,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';

function statusVariant(
  s: Notification['status'],
): 'default' | 'success' | 'destructive' | 'accent' {
  switch (s) {
    case 'SENT':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'READ':
      return 'accent';
    case 'QUEUED':
      return 'default';
  }
}

interface AdminCommsViewProps {
  canManage: boolean;
}

export function AdminCommsView({ canManage }: AdminCommsViewProps) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<Notification | null>(null);
  const [channelFilter, setChannelFilter] = useState<NotificationChannel | ''>('');
  const [statusFilter, setStatusFilter] = useState<NotificationStatus | ''>('');
  const [resendingId, setResendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setItems(null);
      const res = await listAdmin({
        channel: channelFilter || undefined,
        status: statusFilter || undefined,
      });
      setItems(res.notifications);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [channelFilter, statusFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const exportCsv = () => {
    if (!items || items.length === 0) return;
    downloadCsv(`communications-${ymdLocal()}.csv`, [
      [
        'Created',
        'Channel',
        'Status',
        'Recipient',
        'Subject',
        'Body',
        'Sender',
        'Failure reason',
      ],
      ...items.map((n) => [
        fmtDateTime(n.createdAt),
        n.channel,
        n.status,
        n.recipientEmail ?? n.recipientPhone ?? n.recipientUserId ?? '',
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
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Resend failed.');
    } finally {
      setResendingId(null);
    }
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title="Communications"
        subtitle={
          canManage
            ? 'Send notifications via SMS, push, email, or in-app inbox. Provider integrations are stubbed.'
            : 'Read-only view of sent notifications.'
        }
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
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Sent log</CardTitle>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select
                size="sm"
                aria-label="Filter by channel"
                value={channelFilter}
                onChange={(e) =>
                  setChannelFilter(e.target.value as NotificationChannel | '')
                }
              >
                <option value="">All channels</option>
                <option value="IN_APP">In-app</option>
                <option value="EMAIL">Email</option>
                <option value="SMS">SMS</option>
                <option value="PUSH">Push</option>
              </Select>
              <Select
                size="sm"
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as NotificationStatus | '')
                }
              >
                <option value="">All statuses</option>
                <option value="QUEUED">Queued</option>
                <option value="SENT">Sent</option>
                <option value="READ">Read</option>
                <option value="FAILED">Failed</option>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={exportCsv}
                disabled={!items || items.length === 0}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {error && (
            <p role="alert" className="text-sm text-alert mb-3">
              {error}
            </p>
          )}
          {!items && <SkeletonRows count={5} rowHeight="h-12" />}
          {items && items.length === 0 && (
            <EmptyState
              icon={Inbox}
              title="No notifications yet"
              description={
                canManage
                  ? 'Send your first message — it will show up here once delivered.'
                  : 'Notifications you receive or that go out from the system will appear here.'
              }
              action={
                canManage ? (
                  <Button onClick={() => setShowCompose(true)}>
                    <Send className="h-4 w-4" />
                    Send notification
                  </Button>
                ) : undefined
              }
            />
          )}
          {items && items.length > 0 && (
            <div className="divide-y divide-navy-secondary -mx-6">
              {groupByDay(items).map((group, idx) => (
                <details
                  key={group.key}
                  open={idx === 0}
                  className="[&[open]>summary>svg.chev]:rotate-90"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-2.5 text-sm hover:bg-navy-secondary/40">
                    <ChevronRight className="chev h-4 w-4 text-silver transition-transform" />
                    <span className="font-medium text-white">
                      {dayHeading(group.key)}
                    </span>
                    <span className="text-xs text-silver/70">· {group.key}</span>
                    <span className="ml-auto text-xs text-silver">
                      {group.entries.length}{' '}
                      {group.entries.length === 1 ? 'message' : 'messages'}
                    </span>
                  </summary>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="hidden md:table-cell w-24">
                          Time
                        </TableHead>
                        <TableHead className="hidden sm:table-cell">Channel</TableHead>
                        <TableHead>Recipient</TableHead>
                        <TableHead className="hidden lg:table-cell">
                          Subject / preview
                        </TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.entries.map((n) => (
                        <TableRow
                          key={n.id}
                          className="group cursor-pointer"
                          onClick={(e) => {
                            const target = e.target as HTMLElement;
                            if (
                              target.closest(
                                'button, a, input, [data-no-row-click]',
                              )
                            )
                              return;
                            if (window.getSelection()?.toString()) return;
                            setDrawerTarget(n);
                          }}
                        >
                          <TableCell
                            className="hidden md:table-cell text-silver tabular-nums whitespace-nowrap"
                            title={fmtDateTime(n.createdAt)}
                          >
                            {fmtTimeOnly(n.createdAt)}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            <Badge variant="outline">{n.channel}</Badge>
                          </TableCell>
                          <TableCell className="text-silver">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Avatar
                                name={
                                  n.recipientEmail ??
                                  n.recipientPhone ??
                                  n.recipientUserId ??
                                  '—'
                                }
                                email={n.recipientEmail ?? undefined}
                                size="xs"
                              />
                              <span className="truncate">
                                {n.recipientEmail ??
                                  n.recipientPhone ??
                                  n.recipientUserId ??
                                  '—'}
                              </span>
                            </div>
                            <div className="lg:hidden mt-1 text-xs text-silver truncate max-w-[60vw]">
                              {n.subject ?? '(no subject)'}
                            </div>
                            <div className="md:hidden text-[10px] text-silver/70 tabular-nums">
                              {fmtTimeOnly(n.createdAt)}
                            </div>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <div className="text-white truncate max-w-md font-medium">
                              {n.subject ?? '(no subject)'}
                            </div>
                            <div className="text-xs text-silver truncate max-w-md">
                              {n.body}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(n.status)}>{n.status}</Badge>
                            {n.failureReason && (
                              <div className="text-[10px] mt-1 text-alert">
                                {n.failureReason}
                              </div>
                            )}
                            {canManage && n.status === 'FAILED' && (
                              <div className="mt-1">
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={resendingId === n.id}
                                  onClick={() => void resend(n)}
                                >
                                  <RotateCw className="mr-1 h-3 w-3" />
                                  {resendingId === n.id ? 'Resending…' : 'Resend'}
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </details>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ComposeDialog
        open={showCompose}
        onOpenChange={setShowCompose}
        onSent={() => {
          setShowCompose(false);
          refresh();
        }}
      />
      <BroadcastDialog
        open={showBroadcast}
        onOpenChange={setShowBroadcast}
        onSent={() => {
          setShowBroadcast(false);
          refresh();
        }}
      />

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-xl"
      >
        {drawerTarget && <NotificationDetailPanel n={drawerTarget} />}
      </Drawer>
    </div>
  );
}

function NotificationDetailPanel({ n }: { n: Notification }) {
  const recipient =
    n.recipientEmail ?? n.recipientPhone ?? n.recipientUserId ?? 'Unknown';
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            name={recipient}
            email={n.recipientEmail ?? undefined}
            size="md"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {n.subject ?? '(no subject)'}
            </DrawerTitle>
            <DrawerDescription>
              {recipient} · {n.channel}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex items-center gap-2 mb-4">
          <Badge variant={statusVariant(n.status)}>{n.status}</Badge>
          {n.category && (
            <Badge variant="outline" className="text-[10px]">
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
          <DetailRow label="Channel">{n.channel}</DetailRow>
          <DetailRow label="Status">{n.status}</DetailRow>
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
      <dt className="text-[10px] uppercase tracking-widest text-silver/80">
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

function ComposeDialog({ open, onOpenChange, onSent }: ComposeDialogProps) {
  const [channel, setChannel] = useState<NotificationChannel>('IN_APP');
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [recipientUserId, setRecipientUserId] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChannel('IN_APP');
      setAssociate(null);
      setRecipientUserId('');
      setRecipientEmail('');
      setRecipientPhone('');
      setResolveNote(null);
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open]);

  /**
   * A picked associate resolves in two steps: the directory row carries
   * email/phone (auto-filled into the external fields when they're empty),
   * and the admin user list maps associate → linked User id, which is what
   * IN_APP / PUSH delivery actually targets.
   */
  const onPickAssociate = async (picked: PickedAssociate | null) => {
    setAssociate(picked);
    setRecipientUserId('');
    setResolveNote(null);
    if (!picked) return;
    // Search by first name token — the directory matches on individual
    // name fields, not the concatenated display name.
    const nameToken = picked.name.split(/\s+/)[0] ?? picked.name;
    let email: string | null = null;
    try {
      const dir = await listDirectory({ q: nameToken });
      const entry = dir.associates.find((a) => a.id === picked.id) ?? null;
      if (entry) {
        email = entry.email;
        const entryEmail = entry.email;
        const entryPhone = entry.phone;
        setRecipientEmail((cur) => cur || entryEmail);
        if (entryPhone) setRecipientPhone((cur) => cur || entryPhone);
      }
    } catch {
      // Directory lookup is best-effort; the manual fields still work.
    }
    try {
      const res = await listAdminUsers({ q: email ?? nameToken });
      const u = res.users.find((x) => x.associateId === picked.id);
      if (u) {
        setRecipientUserId(u.id);
        setRecipientEmail((cur) => cur || u.email);
      } else {
        setResolveNote(
          'No linked user account found — in-app/push needs one. Email or SMS will still work.',
        );
      }
    } catch {
      setResolveNote(
        'Could not resolve a user account for in-app delivery. Email or SMS will still work.',
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!recipientUserId && !recipientEmail && !recipientPhone) {
      setError('Pick an associate or fill in an email/phone.');
      return;
    }
    setSubmitting(true);
    try {
      await sendNotification({
        channel,
        recipientUserId: recipientUserId || undefined,
        recipientEmail: recipientEmail || undefined,
        recipientPhone: recipientPhone || undefined,
        subject: subject || undefined,
        body,
      });
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Send failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send notification</DialogTitle>
          <DialogDescription>
            Pick the channel and the recipient. Email / SMS / Push are stubbed —
            they record an audit row but don&apos;t hit a real provider yet.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Channel">
              <Select
                value={channel}
                onChange={(e) => setChannel(e.target.value as NotificationChannel)}
              >
                <option value="IN_APP">In-app inbox</option>
                <option value="EMAIL">Email (stub)</option>
                <option value="SMS">SMS (stub)</option>
                <option value="PUSH">Push (stub)</option>
              </Select>
            </Field>
            <Field label="Recipient (associate)">
              <AssociatePicker
                value={associate}
                onChange={(v) => void onPickAssociate(v)}
              />
              {resolveNote && (
                <p className="text-[11px] text-warning mt-1">{resolveNote}</p>
              )}
            </Field>
            <Field label="Recipient email (for EMAIL / external)">
              <Input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </Field>
            <Field label="Recipient phone (for SMS / external)">
              <Input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Body" required>
            <Textarea
              required
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface BroadcastDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

function BroadcastDialog({
  open,
  onOpenChange,
  onSent,
}: BroadcastDialogProps) {
  const [audience, setAudience] = useState<'ALL_ASSOCIATES' | 'ALL_HR'>(
    'ALL_ASSOCIATES',
  );
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAudience('ALL_ASSOCIATES');
      setSubject('');
      setBody('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await broadcast({
        channel: 'IN_APP',
        audience,
        subject: subject || undefined,
        body,
      });
      toast.success(
        `Sent to ${res.count} recipient${res.count === 1 ? '' : 's'}.`,
      );
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Broadcast failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Broadcast to in-app inbox</DialogTitle>
          <DialogDescription>
            Reaches every active recipient in the chosen audience.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <Field label="Audience">
            <Select
              value={audience}
              onChange={(e) =>
                setAudience(e.target.value as 'ALL_ASSOCIATES' | 'ALL_HR')
              }
            >
              <option value="ALL_ASSOCIATES">All active associates</option>
              <option value="ALL_HR">All HR administrators</option>
            </Select>
          </Field>
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Body" required>
            <Textarea
              required
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Broadcast
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-silver mb-1">
        {label}
        {required && <span className="text-alert"> *</span>}
      </span>
      {children}
    </label>
  );
}
