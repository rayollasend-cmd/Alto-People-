import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, ServerCrash, ShieldAlert } from 'lucide-react';
import {
  getDisbursementWebhookStatus,
  type DisbursementWebhookStatus,
  type WebhookHealth,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';

const POLL_INTERVAL_MS = 60_000;

/**
 * Status pill style triplet. We carry the tinted background (token/15)
 * separately from the saturated text (token) and the matching ring
 * (token/30) so the badge is visible against the navy card without
 * collapsing into a single block of colour. Previously the file used
 * Tailwind light-mode ramps (`text-success-700 bg-success-50`) which
 * a bulk token replace flattened to `text-success bg-success` — same
 * value on text and bg, invisible.
 */
const STYLE: Record<
  WebhookHealth,
  {
    label: string;
    chip: string;
    iconBox: string;
    ring: string;
    Icon: typeof CheckCircle2;
  }
> = {
  healthy: {
    label: 'Healthy',
    chip: 'text-success bg-success/15 border border-success/30',
    iconBox: 'bg-success/15 text-success',
    ring: 'ring-success/30',
    Icon: CheckCircle2,
  },
  idle: {
    label: 'Idle',
    chip: 'text-silver bg-navy-secondary/40 border border-navy-secondary',
    iconBox: 'bg-navy-secondary/40 text-silver',
    ring: 'ring-navy-secondary',
    Icon: CircleDashed,
  },
  stale: {
    label: 'Stale',
    chip: 'text-warning bg-warning/15 border border-warning/30',
    iconBox: 'bg-warning/15 text-warning',
    ring: 'ring-warning/30',
    Icon: AlertTriangle,
  },
  erroring: {
    label: 'Erroring',
    chip: 'text-alert bg-alert/15 border border-alert/30',
    iconBox: 'bg-alert/15 text-alert',
    ring: 'ring-alert/30',
    Icon: ServerCrash,
  },
  unconfigured: {
    label: 'N/A',
    chip: 'text-silver bg-navy-secondary/40 border border-navy-secondary',
    iconBox: 'bg-navy-secondary/40 text-silver',
    ring: 'ring-navy-secondary',
    Icon: ShieldAlert,
  },
  stub: {
    label: 'STUB MODE',
    chip: 'text-alert bg-alert/15 border border-alert/30',
    iconBox: 'bg-alert/15 text-alert',
    ring: 'ring-alert/30',
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
      <div className="rounded-lg border border-navy-secondary bg-navy elev-1 p-3 text-sm text-silver">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-navy-secondary bg-navy elev-1 p-3 text-sm text-silver">
        Loading disbursement health…
      </div>
    );
  }

  const style = STYLE[data.health];
  const Icon = style.Icon;
  return (
    <div
      className={`rounded-lg border border-navy-secondary bg-navy p-3 ring-1 ${style.ring} elev-1 flex items-start gap-3`}
      role="status"
      aria-label={`Disbursement webhook is ${style.label}`}
    >
      <span className={`rounded-full p-2 ${style.iconBox}`}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="flex-1 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-white">Disbursement webhook</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest font-medium ${style.chip}`}
          >
            {style.label}
          </span>
          <span className="text-xs text-silver">· {data.provider}</span>
        </div>
        <p className="mt-0.5 text-silver">{data.detail}</p>
        {data.health === 'erroring' && data.latestError?.notes && (
          <p className="mt-1 text-xs text-alert break-words">
            Latest error ({new Date(data.latestError.at).toLocaleString()}):{' '}
            {data.latestError.notes}
          </p>
        )}
        <p className="mt-1 text-xs text-silver">
          {data.eventsLast24h} event(s) in the last 24h ·{' '}
          {data.errorsLast7d} error(s) in the last 7 days ·{' '}
          {data.pendingFinalizedItems} item(s) awaiting disbursement
        </p>
      </div>
    </div>
  );
}
