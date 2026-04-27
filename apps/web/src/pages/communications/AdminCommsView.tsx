import { useCallback, useEffect, useState } from 'react';
import { Inbox, Megaphone, Send } from 'lucide-react';
import { toast } from 'sonner';
import type {
  Notification,
  NotificationChannel,
} from '@alto-people/shared';
import {
  broadcast,
  listAdmin,
  sendNotification,
} from '@/lib/communicationsApi';
import { ApiError } from '@/lib/api';
import {
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
  EmptyState,
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
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

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdmin();
      setItems(res.notifications);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="max-w-6xl mx-auto">
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
          <CardTitle className="text-base">Sent log</CardTitle>
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Subject / preview</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="text-silver tabular-nums whitespace-nowrap">
                      {new Date(n.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{n.channel}</Badge>
                    </TableCell>
                    <TableCell className="text-silver">
                      {n.recipientEmail ?? n.recipientPhone ?? n.recipientUserId ?? '—'}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
    </div>
  );
}

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

function ComposeDialog({ open, onOpenChange, onSent }: ComposeDialogProps) {
  const [channel, setChannel] = useState<NotificationChannel>('IN_APP');
  const [recipientUserId, setRecipientUserId] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChannel('IN_APP');
      setRecipientUserId('');
      setRecipientEmail('');
      setRecipientPhone('');
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
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as NotificationChannel)}
                className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              >
                <option value="IN_APP">In-app inbox</option>
                <option value="EMAIL">Email (stub)</option>
                <option value="SMS">SMS (stub)</option>
                <option value="PUSH">Push (stub)</option>
              </select>
            </Field>
            <Field label="Recipient User ID (in-app / push)">
              <Input
                value={recipientUserId}
                onChange={(e) => setRecipientUserId(e.target.value)}
              />
            </Field>
            <Field label="Recipient email (for EMAIL)">
              <Input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </Field>
            <Field label="Recipient phone (for SMS)">
              <Input
                type="tel"
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
            <select
              value={audience}
              onChange={(e) =>
                setAudience(e.target.value as 'ALL_ASSOCIATES' | 'ALL_HR')
              }
              className="w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
            >
              <option value="ALL_ASSOCIATES">All active associates</option>
              <option value="ALL_HR">All HR administrators</option>
            </select>
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
