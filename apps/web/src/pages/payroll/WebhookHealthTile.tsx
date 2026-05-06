import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, ServerCrash, ShieldAlert } from 'lucide-react';
import {
  getDisbursementWebhookStatus,
  type DisbursementWebhookStatus,
  type WebhookHealth,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';

const POLL_INTERVAL_MS = 60_000;

const STYLE: Record<
  WebhookHealth,
  { label: string; color: string; ring: string; Icon: typeof CheckCircle2 }
> = {
  healthy: {
    label: 'Healthy',
    color: 'text-emerald-700 bg-emerald-50',
    ring: 'ring-emerald-200',
    Icon: CheckCircle2,
  },
  idle: {
    label: 'Idle',
    color: 'text-slate-600 bg-slate-50',
    ring: 'ring-slate-200',
    Icon: CircleDashed,
  },
  stale: {
    label: 'Stale',
    color: 'text-amber-700 bg-amber-50',
    ring: 'ring-amber-300',
    Icon: AlertTriangle,
  },
  erroring: {
    label: 'Erroring',
    color: 'text-red-700 bg-red-50',
    ring: 'ring-red-300',
    Icon: ServerCrash,
  },
  unconfigured: {
    label: 'N/A',
    color: 'text-slate-500 bg-slate-50',
    ring: 'ring-slate-200',
    Icon: ShieldAlert,
  },
  stub: {
    label: 'STUB MODE',
    color: 'text-red-700 bg-red-50',
    ring: 'ring-red-300',
    Icon: ShieldAlert,
  },
};

export function WebhookHealthTile() {
  const [data, setData] = useState<DisbursementWebhookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getDisbursementWebhookStatus()
        .then((s) => {
          if (!cancelled) {
            setData(s);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e instanceof ApiError ? e.message : "Couldn't load webhook status.");
          }
        });
    };
    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-500">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-400">
        Loading disbursement health…
      </div>
    );
  }

  const style = STYLE[data.health];
  const Icon = style.Icon;
  return (
    <div
      className={`rounded-lg border bg-white p-3 ring-1 ${style.ring} flex items-start gap-3`}
      role="status"
      aria-label={`Disbursement webhook is ${style.label}`}
    >
      <span className={`rounded-full p-2 ${style.color}`}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="flex-1 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-900">Disbursement webhook</span>
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${style.color}`}>
            {style.label}
          </span>
          <span className="text-xs text-slate-500">· {data.provider}</span>
        </div>
        <p className="mt-0.5 text-slate-600">{data.detail}</p>
        {data.health === 'erroring' && data.latestError?.notes && (
          <p className="mt-1 text-xs text-red-700 break-words">
            Latest error ({new Date(data.latestError.at).toLocaleString()}):{' '}
            {data.latestError.notes}
          </p>
        )}
        <p className="mt-1 text-xs text-slate-400">
          {data.eventsLast24h} event(s) in the last 24h ·{' '}
          {data.errorsLast7d} error(s) in the last 7 days ·{' '}
          {data.pendingFinalizedItems} item(s) awaiting disbursement
        </p>
      </div>
    </div>
  );
}
