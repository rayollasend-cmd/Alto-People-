import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { useClientBounded } from '@/lib/useClientBounded';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { OpsRunner } from './OpsRunner';
import { OpsBoard } from './OpsBoard';
import { OpsLibrary } from './OpsLibrary';
import { StoreOps } from '../portal/PortalOps';

/**
 * Store Operations — one module, three audiences:
 *  - Shift supervisors: "My shift" (open, run the SOP checklist, close).
 *    Floor supervisors: "My shift" too — help on it, run it covering.
 *  - Operations / HR / the chairman: the live board + scorecard.
 *  - The same leadership trio: the SOP library (the editable standard).
 *  - The store's team leads: "Store today" — every department's SOP, the
 *    page their store manager reads in the portal.
 * Tabs render only for the capabilities the signed-in user actually holds.
 */
export function OpsHome() {
  const { user } = useAuth();
  // A floor supervisor (assist:ops-shifts) has "My shift" too — the SOP
  // they help on, or run while covering; never the picker.
  const canRun = user
    ? hasCapability(user.role, 'run:ops-shifts') || hasCapability(user.role, 'assist:ops-shifts')
    : false;
  const canBoard = user ? hasCapability(user.role, 'view:ops') : false;
  const canLibrary = user ? hasCapability(user.role, 'manage:ops-library') : false;
  // The store's team leads read the whole store's day — every department's
  // SOP, temps, freight — the page their store manager reads in the portal.
  const canStore = user?.role === 'SHIFT_SUPERVISOR' || user?.role === 'FLOOR_SUPERVISOR';

  const tabs = useMemo(
    () =>
      [
        canRun ? { key: 'shift', label: 'My shift' } : null,
        canStore ? { key: 'store', label: 'Store today' } : null,
        canBoard ? { key: 'board', label: 'Board' } : null,
        canLibrary ? { key: 'library', label: 'SOP library' } : null,
      ].filter((t): t is { key: string; label: string } => t !== null),
    [canRun, canStore, canBoard, canLibrary],
  );
  // The active tab lives in ?tab= so views are linkable ("open the ops
  // board") and a tablet reload/wake doesn't dump the supervisor on the
  // role default. Invalid or unauthorized values fall back to that
  // default; replace-writes keep tab hops out of Back history. Other
  // params (?shift=, ?record=) are preserved across switches so live
  // context survives a detour through another tab.
  const [searchParams, setSearchParams] = useSearchParams();
  // Leadership (org-wide, holds the board) lands on the board — every
  // store at once; running one floor is a deliberate pick under My shift.
  // A supervisor lands on their own shift.
  const bounded = useClientBounded();
  const roleDefault =
    canBoard && !bounded ? 'board' : canRun ? 'shift' : canBoard ? 'board' : 'library';
  const tabParam = searchParams.get('tab');
  const tab = tabs.some((t) => t.key === tabParam) ? (tabParam as string) : roleDefault;
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div>
      {/* Mid-checklist the page is the checklist: no explainer above it. */}
      <PageHeader
        title="Store Ops"
        subtitle={
          searchParams.get('shift')
            ? undefined
            : 'The floor, on the record — SOP checklists, live shifts, handover, and the standard behind them.'
        }
      />
      {tabs.length > 1 && (
        <Tabs value={tab} onValueChange={setTab} className="mb-4">
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {tab === 'shift' && canRun && <OpsRunner />}
      {tab === 'store' && canStore && <StoreOps />}
      {tab === 'board' && canBoard && <OpsBoard />}
      {tab === 'library' && canLibrary && <OpsLibrary />}
    </div>
  );
}
