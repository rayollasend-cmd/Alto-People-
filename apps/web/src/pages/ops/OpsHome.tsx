import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { OpsRunner } from './OpsRunner';
import { OpsBoard } from './OpsBoard';
import { OpsLibrary } from './OpsLibrary';

/**
 * Store Operations — one module, three audiences:
 *  - Shift supervisors: "My shift" (open, run the SOP checklist, close).
 *  - Operations / HR / the chairman: the live board + scorecard.
 *  - The same leadership trio: the SOP library (the editable standard).
 * Tabs render only for the capabilities the signed-in user actually holds.
 */
export function OpsHome() {
  const { user } = useAuth();
  const canRun = user ? hasCapability(user.role, 'run:ops-shifts') : false;
  const canBoard = user ? hasCapability(user.role, 'view:ops') : false;
  const canLibrary = user ? hasCapability(user.role, 'manage:ops-library') : false;

  const tabs = useMemo(
    () =>
      [
        canRun ? { key: 'shift', label: 'My shift' } : null,
        canBoard ? { key: 'board', label: 'Board' } : null,
        canLibrary ? { key: 'library', label: 'SOP library' } : null,
      ].filter((t): t is { key: string; label: string } => t !== null),
    [canRun, canBoard, canLibrary],
  );
  const [tab, setTab] = useState<string>(() =>
    canRun ? 'shift' : canBoard ? 'board' : 'library',
  );

  return (
    <div>
      <PageHeader
        title="Store Ops"
        subtitle="The floor, on the record — SOP checklists, live shifts, handover, and the standard behind them."
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
      {tab === 'board' && canBoard && <OpsBoard />}
      {tab === 'library' && canLibrary && <OpsLibrary />}
    </div>
  );
}
