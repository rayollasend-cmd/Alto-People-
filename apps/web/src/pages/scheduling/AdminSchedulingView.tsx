import { useCallback, useEffect, useState } from 'react';
import type { ClientSummary, Shift, ShiftStatus } from '@alto-people/shared';
import {
  assignShift,
  cancelShift,
  createShift,
  listShifts,
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

  const onAssign = async (id: string) => {
    if (pendingId) return;
    const associateId = window.prompt('Associate ID to assign?');
    if (!associateId) return;
    setPendingId(id);
    try {
      await assignShift(id, { associateId });
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
                        <button
                          type="button"
                          onClick={() => onAssign(s.id)}
                          disabled={pendingId === s.id}
                          className="text-xs px-2 py-1 rounded border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                        >
                          Assign
                        </button>
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
    </div>
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
