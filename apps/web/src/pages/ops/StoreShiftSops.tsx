import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, X } from 'lucide-react';
import { fmtShiftWindow } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useClients } from '@/lib/useClients';
import { getStoreShiftSops, setStoreShiftSop } from '@/lib/opsApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';

/**
 * Store shifts — the SOP each store shift runs. A supervisor's clock-in
 * opens exactly this checklist for the shift they're working, and they
 * can't clock out until it's submitted. A shift with no SOP opens nothing
 * automatically (the supervisor picks one by hand).
 */
export function StoreShiftSops({ canEdit }: { canEdit: boolean }) {
  const { user } = useAuth();
  const { clients } = useClients();
  const [picked, setPicked] = useState<string>(user?.clientId ?? '');
  const clientId = picked || (clients.length === 1 ? clients[0]!.id : '');
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['ops', 'store-shifts', clientId],
    queryFn: () => getStoreShiftSops(clientId),
    enabled: !!clientId,
  });
  const [saving, setSaving] = useState<string | null>(null);

  const assign = async (locationId: string, label: string, templateId: string) => {
    if (!templateId) return;
    setSaving(`${locationId}|${label}`);
    try {
      await setStoreShiftSop({ locationId, label, templateId });
      toast.success(`${label} now runs that SOP at clock-in.`);
      await queryClient.invalidateQueries({ queryKey: ['ops', 'store-shifts', clientId] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(null);
    }
  };

  /** Drop one department's SOP, leaving the window's others alone. */
  const removeOne = async (locationId: string, label: string, templateId: string) => {
    setSaving(`${locationId}|${label}`);
    try {
      await setStoreShiftSop({ locationId, label, templateId: null, removeTemplateId: templateId });
      toast.success(`Taken off ${label}.`);
      await queryClient.invalidateQueries({ queryKey: ['ops', 'store-shifts', clientId] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(null);
    }
  };

  const data = q.data;
  const unassigned = data
    ? data.stores.reduce((n, s) => n + s.windows.filter((w) => w.templateIds.length === 0).length, 0)
    : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-x-2 text-base">
          Store shifts — the SOP each shift runs
          <span className="text-xs font-normal text-silver/60">
            opens at the supervisor&apos;s clock-in; they can&apos;t clock out until it&apos;s submitted
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {clients.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="store-shifts-client" className="text-xs text-silver">
              Client
            </Label>
            <Select
              id="store-shifts-client"
              size="sm"
              className="w-auto min-w-[12rem]"
              value={clientId}
              onChange={(e) => setPicked(e.target.value)}
            >
              {!clientId && <option value="">Pick a client…</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            {data && unassigned > 0 && (
              <span className="text-xs text-warning">
                {unassigned} shift{unassigned === 1 ? '' : 's'} without an SOP
              </span>
            )}
          </div>
        )}
        {!clientId ? (
          <p className="text-sm text-silver/70">Pick a client to see its store shifts.</p>
        ) : !data ? (
          <Skeleton className="h-24" />
        ) : data.stores.every((s) => s.windows.length === 0) ? (
          <p className="text-sm text-silver/70">
            No store has named its shifts yet — add shift windows to a store&apos;s staffing
            targets in Labor costs first.
          </p>
        ) : (
          <div className="space-y-4">
            {data.stores
              .filter((s) => s.windows.length > 0)
              .map((s) => (
                <div key={s.locationId}>
                  <div className="mb-1.5 text-xs uppercase tracking-wide text-silver/80">{s.locationName}</div>
                  <ul className="divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary">
                    {s.windows.map((w) => {
                      const key = `${s.locationId}|${w.label}`;
                      return (
                        <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-white">{w.label}</div>
                            <div className="inline-flex items-center gap-1 text-xs text-silver">
                              <Clock className="h-3 w-3" aria-hidden="true" />
                              {fmtShiftWindow(w)}
                            </div>
                          </div>
                          {/* One SOP PER DEPARTMENT. A store where Alto
                              staffs Grocery and Front End runs both on the
                              same window — a single select could only ever
                              express one of them, which is why the second
                              department's checklist never ran. */}
                          <div className="w-full sm:w-80">
                            {w.templateIds.length > 0 && (
                              <ul className="mb-1.5 space-y-1">
                                {w.templateIds.map((id) => {
                                  const t = data.templates.find((x) => x.id === id);
                                  return (
                                    <li
                                      key={id}
                                      className="flex items-center gap-2 rounded-md border border-navy-secondary bg-navy-secondary/30 px-2 py-1 text-xs"
                                    >
                                      <span className="min-w-0 flex-1 truncate text-white">
                                        {t ? `${t.department} · ${t.name}` : 'SOP no longer in the library'}
                                      </span>
                                      {t && (
                                        <span className="shrink-0 tabular-nums text-silver/70">
                                          {t.taskCount} tasks
                                        </span>
                                      )}
                                      {canEdit && (
                                        <button
                                          type="button"
                                          onClick={() => void removeOne(s.locationId, w.label, id)}
                                          disabled={saving === key}
                                          aria-label={`Remove ${t ? t.name : 'this SOP'} from ${w.label}`}
                                          className="shrink-0 rounded p-0.5 text-silver/60 hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                            <Select
                              size="sm"
                              aria-label={`Add an SOP to ${s.locationName} ${w.label}`}
                              className="w-full"
                              value=""
                              disabled={!canEdit || saving === key}
                              onChange={(e) => void assign(s.locationId, w.label, e.target.value)}
                            >
                              <option value="">
                                {w.templateIds.length === 0
                                  ? 'No SOP — nothing opens at clock-in'
                                  : 'Add another department’s SOP…'}
                              </option>
                              {data.templates
                                .filter((t) => !w.templateIds.includes(t.id))
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name} · {t.department} · {t.taskCount} tasks
                                  </option>
                                ))}
                            </Select>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
