import { useCallback, useEffect, useState } from 'react';
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
import { cn } from '@/lib/cn';

const STATUS_CLS: Record<Notification['status'], string> = {
  QUEUED: 'text-silver',
  SENT: 'text-emerald-300',
  FAILED: 'text-alert',
  READ: 'text-gold',
};

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
      <header className="mb-6 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Communications
          </h1>
          <p className="text-silver">
            {canManage
              ? 'Send notifications via SMS, push, email, or in-app inbox. Provider integrations are stubbed.'
              : 'Read-only view of sent notifications.'}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setShowCompose((v) => !v);
                setShowBroadcast(false);
              }}
              className="px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
            >
              {showCompose ? 'Close' : '+ Send'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowBroadcast((v) => !v);
                setShowCompose(false);
              }}
              className="px-4 py-2 rounded font-medium border border-gold/40 text-gold hover:bg-gold/10"
            >
              {showBroadcast ? 'Close' : 'Broadcast'}
            </button>
          </div>
        )}
      </header>

      {showCompose && canManage && (
        <ComposeForm
          onSent={() => {
            setShowCompose(false);
            refresh();
          }}
        />
      )}
      {showBroadcast && canManage && (
        <BroadcastForm
          onSent={() => {
            setShowBroadcast(false);
            refresh();
          }}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!items && <p className="text-silver">Loading…</p>}
      {items && items.length === 0 && (
        <p className="text-silver">No notifications yet.</p>
      )}
      {items && items.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">When</th>
                <th className="px-4 py-3 text-left">Channel</th>
                <th className="px-4 py-3 text-left">Recipient</th>
                <th className="px-4 py-3 text-left">Subject / preview</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id} className="border-t border-navy-secondary/60 text-white">
                  <td className="px-4 py-3 text-silver tabular-nums whitespace-nowrap">
                    {new Date(n.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs uppercase tracking-widest text-silver">
                    {n.channel}
                  </td>
                  <td className="px-4 py-3 text-silver">
                    {n.recipientEmail ?? n.recipientPhone ?? n.recipientUserId ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-white truncate max-w-md">
                      {n.subject ?? '(no subject)'}
                    </div>
                    <div className="text-xs text-silver truncate max-w-md">
                      {n.body}
                    </div>
                  </td>
                  <td className={cn('px-4 py-3 text-xs uppercase tracking-widest', STATUS_CLS[n.status])}>
                    {n.status}
                    {n.failureReason && (
                      <div className="text-[10px] normal-case tracking-normal mt-1 text-alert">
                        {n.failureReason}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const inputCls =
  'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

function ComposeForm({ onSent }: { onSent: () => void }) {
  const [channel, setChannel] = useState<NotificationChannel>('IN_APP');
  const [recipientUserId, setRecipientUserId] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <form
      onSubmit={handleSubmit}
      className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5 space-y-3"
    >
      <h2 className="font-display text-2xl text-white">Send notification</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Channel
          </span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as NotificationChannel)}
            className={inputCls}
          >
            <option value="IN_APP">In-app inbox</option>
            <option value="EMAIL">Email (stub)</option>
            <option value="SMS">SMS (stub)</option>
            <option value="PUSH">Push (stub)</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Recipient User ID (required for in-app/push)
          </span>
          <input
            type="text"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Recipient email (for EMAIL)
          </span>
          <input
            type="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Recipient phone (for SMS)
          </span>
          <input
            type="tel"
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Subject
        </span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Body
        </span>
        <textarea
          required
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={inputCls}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className={cn(
          'px-4 py-2 rounded font-medium transition',
          submitting
            ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
            : 'bg-gold text-navy hover:bg-gold-bright'
        )}
      >
        {submitting ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

function BroadcastForm({ onSent }: { onSent: () => void }) {
  const [audience, setAudience] = useState<'ALL_ASSOCIATES' | 'ALL_HR'>('ALL_ASSOCIATES');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setResultCount(null);
    setSubmitting(true);
    try {
      const res = await broadcast({
        channel: 'IN_APP',
        audience,
        subject: subject || undefined,
        body,
      });
      setResultCount(res.count);
      setSubject('');
      setBody('');
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Broadcast failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5 space-y-3"
    >
      <h2 className="font-display text-2xl text-white">Broadcast (in-app inbox)</h2>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Audience
        </span>
        <select
          value={audience}
          onChange={(e) => setAudience(e.target.value as 'ALL_ASSOCIATES' | 'ALL_HR')}
          className={inputCls}
        >
          <option value="ALL_ASSOCIATES">All active associates</option>
          <option value="ALL_HR">All HR administrators</option>
        </select>
      </label>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Subject
        </span>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Body
        </span>
        <textarea
          required
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={inputCls}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      {resultCount !== null && (
        <p className="text-sm text-emerald-300">
          Sent to {resultCount} recipient{resultCount === 1 ? '' : 's'}.
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className={cn(
          'px-4 py-2 rounded font-medium transition',
          submitting
            ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
            : 'bg-gold text-navy hover:bg-gold-bright'
        )}
      >
        {submitting ? 'Broadcasting…' : 'Broadcast'}
      </button>
    </form>
  );
}
