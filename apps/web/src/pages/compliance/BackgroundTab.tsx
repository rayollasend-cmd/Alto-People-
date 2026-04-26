import { useCallback, useEffect, useState } from 'react';
import type { BackgroundCheck, BgCheckStatus } from '@alto-people/shared';
import {
  initiateBackgroundCheck,
  listBackgroundChecks,
  updateBackgroundCheck,
} from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const STATUS_OPTIONS: BgCheckStatus[] = [
  'INITIATED',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
];

const statusCls: Record<BgCheckStatus, string> = {
  INITIATED: 'text-silver',
  IN_PROGRESS: 'text-gold',
  PASSED: 'text-emerald-300',
  FAILED: 'text-alert',
  NEEDS_REVIEW: 'text-gold',
};

export function BackgroundTab({ canManage }: { canManage: boolean }) {
  const [checks, setChecks] = useState<BackgroundCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listBackgroundChecks();
      setChecks(res.checks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const initiate = async () => {
    if (!canManage) return;
    const associateId = window.prompt('Associate ID to initiate background check?');
    if (!associateId) return;
    try {
      await initiateBackgroundCheck({ associateId, provider: 'alto-stub' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Initiate failed.');
    }
  };

  const updateStatus = async (id: string, status: BgCheckStatus) => {
    setPendingId(id);
    try {
      await updateBackgroundCheck(id, { status });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section>
      {canManage && (
        <button
          type="button"
          onClick={initiate}
          className="mb-4 px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
        >
          + Initiate check
        </button>
      )}

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!checks && <p className="text-silver">Loading…</p>}
      {checks && checks.length === 0 && (
        <p className="text-silver">No background checks yet.</p>
      )}
      {checks && checks.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">Associate</th>
                <th className="px-4 py-3 text-left">Provider</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Initiated</th>
                <th className="px-4 py-3 text-left">Completed</th>
                {canManage && <th className="px-4 py-3 text-left">Update</th>}
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className="border-t border-navy-secondary/60 text-white">
                  <td className="px-4 py-3">{c.associateName}</td>
                  <td className="px-4 py-3 text-silver">{c.provider}</td>
                  <td className={cn('px-4 py-3 text-xs uppercase tracking-widest', statusCls[c.status])}>
                    {c.status}
                  </td>
                  <td className="px-4 py-3 text-silver tabular-nums">
                    {new Date(c.initiatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-silver tabular-nums">
                    {c.completedAt ? new Date(c.completedAt).toLocaleDateString() : '—'}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3">
                      <select
                        value={c.status}
                        disabled={pendingId === c.id}
                        onChange={(e) =>
                          updateStatus(c.id, e.target.value as BgCheckStatus)
                        }
                        className="text-xs bg-navy-secondary/60 border border-navy-secondary rounded px-2 py-1"
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
