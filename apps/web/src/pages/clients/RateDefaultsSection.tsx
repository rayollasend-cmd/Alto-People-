import { useCallback, useEffect, useMemo, useState } from 'react';
import { DollarSign, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ShiftPosition, ShiftRateDefault } from '@alto-people/shared';
import {
  deleteRateDefault,
  listRateDefaults,
  upsertRateDefault,
} from '@/lib/schedulingApi';
import { listShiftPositions, updateShiftPosition } from '@/lib/orgApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Default pay/bill rate per position for this client. Shifts created
 * without an explicit rate resolve their labor cost from this table, so
 * the schedule's cost footer and KPIs stop reading $0 for rate-less
 * shifts. One row per catalog position, plus any defaults saved for
 * positions no longer in the catalog. Resurrected from
 * wip/scheduling-pay-rates.
 */
export function RateDefaultsSection({ clientId }: { clientId: string }) {
  const { can } = useAuth();
  const [defaults, setDefaults] = useState<ShiftRateDefault[] | null>(null);
  const [positions, setPositions] = useState<string[]>([]);
  // Catalog rows (id + isLead) for the supervisor/lead flag — drives the
  // labor-cost report's lead-vs-associate split.
  const [catalogRows, setCatalogRows] = useState<ShiftPosition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newPosition, setNewPosition] = useState('');
  const canManage = can('manage:scheduling');
  const canFlagLead = can('manage:org');

  const refresh = useCallback(async () => {
    try {
      const r = await listRateDefaults(clientId);
      setDefaults(r.rateDefaults);
      setPositions(r.positions);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load rate defaults.');
    }
    try {
      const p = await listShiftPositions(clientId);
      setCatalogRows(p.shiftPositions);
    } catch {
      // Lead flags are an enhancement — rates still work without them.
      setCatalogRows([]);
    }
  }, [clientId]);

  useEffect(() => {
    if (canManage) void refresh();
  }, [refresh, canManage]);

  // One row per catalog position, then any saved defaults whose position
  // fell out of the catalog (renamed/removed) so they stay editable.
  const rows = useMemo(() => {
    const byPosition = new Map((defaults ?? []).map((d) => [d.position, d]));
    const catalog = positions.map((p) => ({ position: p, saved: byPosition.get(p) }));
    const orphaned = (defaults ?? [])
      .filter((d) => !positions.includes(d.position))
      .map((d) => ({ position: d.position, saved: d as ShiftRateDefault | undefined }));
    return [...catalog, ...orphaned];
  }, [defaults, positions]);

  if (!canManage) return null;

  const addCustom = () => {
    const p = newPosition.trim();
    if (!p) return;
    if (rows.some((r) => r.position === p)) {
      toast.error('That position already has a row.');
      return;
    }
    setPositions((prev) => [...prev, p]);
    setNewPosition('');
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-gold" aria-hidden="true" />
          Default pay rates
        </CardTitle>
        <CardDescription>
          Per-position hourly rates used when a shift has no rate of its own —
          they drive the schedule's projected labor cost. A rate set directly
          on a shift always wins.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
        {defaults === null && !error ? (
          <SkeletonRows count={3} rowHeight="h-10" />
        ) : (
          <div className="space-y-2">
            {rows.length === 0 && (
              <p className="text-sm text-silver">
                No positions yet — add one below, or configure the position
                catalog under Org.
              </p>
            )}
            {rows.map((r) => (
              <RateRow
                key={r.position}
                clientId={clientId}
                position={r.position}
                saved={r.saved}
                catalogRow={catalogRows.find((c) => c.name === r.position)}
                canFlagLead={canFlagLead}
                onChanged={refresh}
              />
            ))}
            <div className="flex items-end gap-2 pt-2 border-t border-navy-secondary">
              <div className="flex-1 max-w-xs">
                <Input
                  value={newPosition}
                  onChange={(e) => setNewPosition(e.target.value)}
                  placeholder="Add another position…"
                  maxLength={120}
                  aria-label="Position to add a default rate for"
                />
              </div>
              <Button type="button" variant="secondary" size="sm" onClick={addCustom}>
                <Plus className="h-4 w-4" />
                Add row
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RateRow({
  clientId,
  position,
  saved,
  catalogRow,
  canFlagLead,
  onChanged,
}: {
  clientId: string;
  position: string;
  saved: ShiftRateDefault | undefined;
  /** The catalog row behind this position, when it still exists — carries
   *  the supervisor/lead flag. */
  catalogRow: ShiftPosition | undefined;
  canFlagLead: boolean;
  onChanged: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [pay, setPay] = useState(saved ? String(saved.payRate) : '');
  const [bill, setBill] = useState(saved?.billRate != null ? String(saved.billRate) : '');
  const [busy, setBusy] = useState(false);
  const [leadBusy, setLeadBusy] = useState(false);

  const toggleLead = async () => {
    if (!catalogRow || leadBusy) return;
    setLeadBusy(true);
    try {
      await updateShiftPosition(catalogRow.id, { isLead: !catalogRow.isLead });
      await onChanged();
    } catch (err) {
      toast.error('Could not update the lead flag.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setLeadBusy(false);
    }
  };

  // Re-sync when a refresh lands new server truth for this row.
  useEffect(() => {
    setPay(saved ? String(saved.payRate) : '');
    setBill(saved?.billRate != null ? String(saved.billRate) : '');
  }, [saved]);

  const dirty =
    pay !== (saved ? String(saved.payRate) : '') ||
    bill !== (saved?.billRate != null ? String(saved.billRate) : '');

  const save = async () => {
    const payNum = Number(pay);
    if (!pay || Number.isNaN(payNum) || payNum < 0) {
      toast.error('Enter a valid pay rate.');
      return;
    }
    const billNum = bill ? Number(bill) : null;
    if (billNum !== null && (Number.isNaN(billNum) || billNum < 0)) {
      toast.error('Enter a valid bill rate (or leave it empty).');
      return;
    }
    setBusy(true);
    try {
      await upsertRateDefault({ clientId, position, payRate: payNum, billRate: billNum });
      toast.success(`Default rate saved for ${position}.`);
      await onChanged();
    } catch (err) {
      toast.error('Could not save the rate.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!saved) return;
    // Wipes the client's default bill/pay rate for this position — every
    // future shift falls back to org standards. One tap shouldn't do that.
    if (
      !(await confirm({
        title: `Clear the default rate for ${position}?`,
        description: 'New shifts fall back to the org-standard rates until a new default is saved.',
        destructive: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteRateDefault(saved.id);
      toast.success(`Default rate cleared for ${position}.`);
      await onChanged();
    } catch (err) {
      toast.error('Could not clear the rate.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="w-48 truncate text-sm text-white" title={position}>
        {position}
      </div>
      <Input
        type="number"
        min={0}
        step="0.01"
        value={pay}
        onChange={(e) => setPay(e.target.value)}
        placeholder="Pay $/hr"
        className="w-28"
        aria-label={`Default pay rate for ${position}`}
      />
      <Input
        type="number"
        min={0}
        step="0.01"
        value={bill}
        onChange={(e) => setBill(e.target.value)}
        placeholder="Bill $/hr"
        className="w-28"
        aria-label={`Default bill rate for ${position}`}
      />
      {catalogRow && (
        <label
          className={
            canFlagLead
              ? 'flex cursor-pointer items-center gap-1.5 text-xs text-silver'
              : 'flex items-center gap-1.5 text-xs text-silver/60'
          }
          title="Supervisor/lead position — splits the labor-cost report into leads vs regular associates"
        >
          <input
            type="checkbox"
            checked={catalogRow.isLead ?? false}
            onChange={() => void toggleLead()}
            disabled={!canFlagLead || leadBusy}
            className="h-4 w-4 rounded border-navy-secondary bg-navy-secondary/40 text-gold focus:ring-gold"
          />
          Lead
        </label>
      )}
      <Button type="submit" size="sm" loading={busy} disabled={!dirty || busy}>
        Save
      </Button>
      {saved && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void clear()}
          aria-label={`Clear default rate for ${position}`}
        >
          <Trash2 className="h-4 w-4 text-alert" />
        </Button>
      )}
    </form>
  );
}
