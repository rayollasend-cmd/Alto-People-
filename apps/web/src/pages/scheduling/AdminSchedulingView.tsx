import { useCallback, useEffect, useState } from 'react';
import type {
  AutoFillCandidate,
  ClientSummary,
  Shift,
  ShiftStatus,
  ShiftSwapRequest,
} from '@alto-people/shared';
import {
  assignShift,
  cancelShift,
  createShift,
  getAutoFillCandidates,
  getShiftConflicts,
  listAdminSwaps,
  listShifts,
  managerApproveSwap,
  managerRejectSwap,
  unassignShift,
} from '@/lib/schedulingApi';
import { apiFetch, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const STATUS_FILTERS: Array<{ value: ShiftStatus | 'ALL'; label: string }> = [
  { value: 'OPEN', label: 'Open' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
];

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface AdminSchedulingViewProps {
  canManage: boolean;
}

export function AdminSchedulingView({ canManage }: AdminSchedulingViewProps) {
  const [filter, setFilter] = useState<ShiftStatus | 'ALL'>('OPEN');
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listShifts(filter === 'ALL' ? {} : { status: filter });
      setShifts(res.shifts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canManage) return;
    (async () => {
      try {
        const res = await apiFetch<{ clients: ClientSummary[] }>('/clients');
        setClients(res.clients);
      } catch {
        // The Create form will fall back to a free-text clientId entry if
        // /clients isn't accessible (e.g., this user has view:scheduling but
        // not view:clients).
      }
    })();
  }, [canManage]);

  const [autoFillForShift, setAutoFillForShift] = useState<{
    shiftId: string;
    candidates: AutoFillCandidate[];
  } | null>(null);

  const onAssign = async (id: string) => {
    if (pendingId) return;
    const associateId = window.prompt('Associate ID to assign?');
    if (!associateId) return;
    // Check conflicts before assigning — surface them to HR but don't block.
    setPendingId(id);
    try {
      const c = await getShiftConflicts(id, associateId).catch(() => null);
      if (c && c.conflicts.length > 0) {
        const summary = c.conflicts
          .map(
            (cf) =>
              `• ${cf.conflictingPosition} @ ${cf.conflictingClientName ?? '—'} ${new Date(
                cf.conflictingStartsAt
              ).toLocaleString()}`
          )
          .join('\n');
        const proceed = window.confirm(
          `This associate has ${c.conflicts.length} overlapping shift${
            c.conflicts.length === 1 ? '' : 's'
          }:\n\n${summary}\n\nAssign anyway?`
        );
        if (!proceed) {
          setPendingId(null);
          return;
        }
      }
      await assignShift(id, { associateId });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Assign failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onAutoFill = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      const res = await getAutoFillCandidates(id);
      setAutoFillForShift({ shiftId: id, candidates: res.candidates });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Auto-fill failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onPickAutoFill = async (associateId: string) => {
    if (!autoFillForShift) return;
    setPendingId(autoFillForShift.shiftId);
    try {
      await assignShift(autoFillForShift.shiftId, { associateId });
      setAutoFillForShift(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Assign failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onUnassign = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      await unassignShift(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unassign failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onCancel = async (id: string) => {
    if (pendingId) return;
    const reason = window.prompt('Cancellation reason?');
    if (!reason) return;
    setPendingId(id);
    try {
      await cancelShift(id, { reason });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cancel failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Scheduling
          </h1>
          <p className="text-silver">
            {canManage
              ? 'Plan shifts, assign associates, and track fill status.'
              : 'Read-only view of scheduled shifts.'}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
          >
            {showCreate ? 'Close' : '+ New shift'}
          </button>
        )}
      </header>

      {showCreate && canManage && (
        <CreateShiftForm
          clients={clients}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition',
              filter === f.value
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      {!shifts && <p className="text-silver">Loading…</p>}
      {shifts && shifts.length === 0 && (
        <p className="text-silver">No shifts match this filter.</p>
      )}

      {shifts && shifts.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">Position</th>
                <th className="px-4 py-3 text-left">Client</th>
                <th className="px-4 py-3 text-left">Starts</th>
                <th className="px-4 py-3 text-left">Ends</th>
                <th className="px-4 py-3 text-left">Assigned</th>
                <th className="px-4 py-3 text-left">Status</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id} className="border-t border-navy-secondary/60 text-white">
                  <td className="px-4 py-3">{s.position}</td>
                  <td className="px-4 py-3 text-silver">{s.clientName ?? '—'}</td>
                  <td className="px-4 py-3 tabular-nums">{fmt(s.startsAt)}</td>
                  <td className="px-4 py-3 tabular-nums">{fmt(s.endsAt)}</td>
                  <td className="px-4 py-3 text-silver">
                    {s.assignedAssociateName ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-xs uppercase tracking-widest text-silver">
                    {s.status}
                    {s.cancellationReason && (
                      <div className="text-alert text-[10px] normal-case tracking-normal mt-1">
                        {s.cancellationReason}
                      </div>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                      {(s.status === 'OPEN' || s.status === 'DRAFT') && (
                        <>
                          <button
                            type="button"
                            onClick={() => onAutoFill(s.id)}
                            disabled={pendingId === s.id}
                            className="text-xs px-2 py-1 rounded border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                          >
                            Auto-fill
                          </button>
                          <button
                            type="button"
                            onClick={() => onAssign(s.id)}
                            disabled={pendingId === s.id}
                            className="text-xs px-2 py-1 rounded border border-silver/40 text-silver hover:bg-silver/10 disabled:opacity-50"
                          >
                            Assign…
                          </button>
                        </>
                      )}
                      {s.status === 'ASSIGNED' && (
                        <button
                          type="button"
                          onClick={() => onUnassign(s.id)}
                          disabled={pendingId === s.id}
                          className="text-xs px-2 py-1 rounded border border-silver/40 text-silver hover:bg-silver/10 disabled:opacity-50"
                        >
                          Unassign
                        </button>
                      )}
                      {s.status !== 'COMPLETED' && s.status !== 'CANCELLED' && (
                        <button
                          type="button"
                          onClick={() => onCancel(s.id)}
                          disabled={pendingId === s.id}
                          className="text-xs px-2 py-1 rounded border border-alert/40 text-alert hover:bg-alert/10 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && <AdminSwapsPanel />}

      {autoFillForShift && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-midnight/80 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAutoFillForShift(null);
          }}
        >
          <div className="bg-navy border border-gold/40 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="font-display text-2xl text-white">Suggested associates</h2>
              <button
                type="button"
                onClick={() => setAutoFillForShift(null)}
                className="text-silver hover:text-white text-sm"
              >
                Close
              </button>
            </div>
            {autoFillForShift.candidates.length === 0 && (
              <p className="text-silver">No candidates returned.</p>
            )}
            {autoFillForShift.candidates.length > 0 && (
              <ul className="space-y-2">
                {autoFillForShift.candidates.slice(0, 15).map((c) => (
                  <li
                    key={c.associateId}
                    className="flex items-center justify-between gap-3 p-3 bg-navy-secondary/30 border border-navy-secondary rounded"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-white text-sm">{c.associateName}</div>
                      <div className="text-xs text-silver flex flex-wrap gap-x-3">
                        <span className={c.matchesAvailability ? 'text-emerald-300' : 'text-silver/60'}>
                          {c.matchesAvailability ? '✓ Available' : '— No availability'}
                        </span>
                        <span className={c.noConflict ? 'text-emerald-300' : 'text-alert'}>
                          {c.noConflict ? '✓ No conflict' : '⚠ Conflict'}
                        </span>
                        <span className="tabular-nums">
                          {Math.round(c.weeklyMinutesActual / 60)}h worked this week
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gold tabular-nums">
                        {(c.score * 100).toFixed(0)}%
                      </span>
                      <button
                        type="button"
                        onClick={() => onPickAutoFill(c.associateId)}
                        className="text-xs px-3 py-1 rounded border border-gold/40 text-gold hover:bg-gold/10"
                      >
                        Assign
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SWAP_STATUS_CLS: Record<ShiftSwapRequest['status'], string> = {
  PENDING_PEER: 'text-gold',
  PEER_ACCEPTED: 'text-emerald-300',
  PEER_DECLINED: 'text-alert',
  MANAGER_APPROVED: 'text-emerald-300',
  MANAGER_REJECTED: 'text-alert',
  CANCELLED: 'text-silver/60',
};

function AdminSwapsPanel() {
  const [items, setItems] = useState<ShiftSwapRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminSwaps({ status: 'PEER_ACCEPTED' });
      setItems(res.requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load swaps.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const wrap = async (id: string, fn: () => Promise<unknown>) => {
    setPendingId(id);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className="mt-8 bg-navy border border-navy-secondary rounded-lg p-5">
      <h2 className="font-display text-2xl text-white mb-3">
        Swap requests awaiting your approval
      </h2>
      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!items && <p className="text-silver">Loading…</p>}
      {items && items.length === 0 && (
        <p className="text-silver">No swap requests need your approval.</p>
      )}
      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((s) => (
            <li
              key={s.id}
              className="p-3 bg-navy-secondary/30 border border-navy-secondary rounded flex items-start justify-between gap-3 flex-wrap"
            >
              <div>
                <div className="text-white text-sm">
                  <span className="font-medium">{s.requesterName}</span>
                  {' → '}
                  <span className="font-medium">{s.counterpartyName}</span>
                </div>
                <div className="text-xs text-silver">
                  {s.shiftPosition} · {s.shiftClientName ?? '—'} ·{' '}
                  {new Date(s.shiftStartsAt).toLocaleString()}
                </div>
                {s.note && (
                  <div className="text-xs text-silver/70 italic mt-1">"{s.note}"</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={cn('text-[10px] uppercase tracking-widest', SWAP_STATUS_CLS[s.status])}>
                  {s.status.replace(/_/g, ' ')}
                </span>
                <button
                  type="button"
                  onClick={() => wrap(s.id, () => managerApproveSwap(s.id))}
                  disabled={pendingId === s.id}
                  className="text-xs px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => wrap(s.id, () => managerRejectSwap(s.id))}
                  disabled={pendingId === s.id}
                  className="text-xs px-2 py-1 rounded border border-alert/40 text-alert hover:bg-alert/10 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface CreateShiftFormProps {
  clients: ClientSummary[];
  onCreated: () => void;
}

function CreateShiftForm({ clients, onCreated }: CreateShiftFormProps) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [position, setPosition] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [location, setLocation] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [notes, setNotes] = useState('');
  const [lateNoticeReason, setLateNoticeReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await createShift({
        clientId,
        position,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        location: location || undefined,
        hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
        notes: notes || undefined,
        status: 'OPEN',
        lateNoticeReason: lateNoticeReason.trim() || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5 space-y-3"
    >
      <h2 className="font-display text-2xl text-white">New shift</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Client
          </span>
          {clients.length > 0 ? (
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              className={inputCls}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              required
              placeholder="Client UUID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={inputCls}
            />
          )}
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Position
          </span>
          <input
            type="text"
            required
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder="e.g. Server"
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Starts at
          </span>
          <input
            type="datetime-local"
            required
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Ends at
          </span>
          <input
            type="datetime-local"
            required
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Location
          </span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Hourly rate ($)
          </span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Notes
        </span>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className="block">
        <span className="block text-xs uppercase tracking-widest text-silver mb-1">
          Late-notice reason (only required for fair-workweek states inside the 14-day window)
        </span>
        <textarea
          rows={2}
          value={lateNoticeReason}
          onChange={(e) => setLateNoticeReason(e.target.value)}
          placeholder="e.g. Mutual agreement — associate volunteered to cover a sick call-out"
          className={inputCls}
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className={cn(
            'px-5 py-2.5 rounded font-medium transition',
            submitting
              ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
              : 'bg-gold text-navy hover:bg-gold-bright'
          )}
        >
          {submitting ? 'Saving…' : 'Create shift'}
        </button>
      </div>
    </form>
  );
}
