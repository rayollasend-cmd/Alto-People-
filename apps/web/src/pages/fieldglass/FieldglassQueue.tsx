import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FieldglassPacketPanel, MarkAddedDialog } from './FieldglassPacket';

/**
 * The Fieldglass setup queue — one row per worker to ADD, TRANSFER or
 * CLOSE in the buyer's Fieldglass. A row unfolds to the registration
 * packet (every value one tap to copy); "Mark added" takes the Worker ID
 * Fieldglass gave them, and every mark carries an Undo. Shared by the
 * finance dashboard (the top of the queue) and the Fieldglass setup page
 * (all of it).
 */

export interface FieldglassQueueRow {
  kind: 'add' | 'transfer' | 'close';
  associateId: string;
  name: string;
  clientName: string | null;
  fromClientName: string | null;
  /** Their Fieldglass Worker ID (transfers and close-outs). */
  workerId?: string | null;
  /** Hours already worked (last 3 weeks) that can't be billed until added. */
  hoursUnbilled?: number;
  position: string | null;
  firstShiftAt: string | null;
  approvedAt: string | null;
  email: string | null;
  phone: string | null;
  hireDate: string | null;
}

export function FieldglassQueueList({ queue, returnTo }: { queue: FieldglassQueueRow[]; returnTo: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [fgBusy, setFgBusy] = useState<string | null>(null);
  // Which row is unfolded to show its Fieldglass entry facts.
  const [fgOpen, setFgOpen] = useState<string | null>(null);
  // "Mark added" asks for the Worker ID Fieldglass gave them first.
  const [adding, setAdding] = useState<{ associateId: string; name: string } | null>(null);

  // Both views of the queue (the dashboard's and the setup page's) and the menu's count.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['finance', 'overview'] }),
      queryClient.invalidateQueries({ queryKey: ['finance', 'fieldglass'] }),
    ]);

  // Mark added → row leaves the queue; the toast carries a real Undo.
  const markFieldglass = async (associateId: string, workerId?: string) => {
    setFgBusy(associateId);
    try {
      await apiFetch(`/finance/fieldglass/${associateId}/done`, { method: 'POST', body: workerId ? { workerId } : {} });
      setAdding(null);
      void refresh();
      toast.success(t('fin.fgMarked'), {
        action: {
          label: t('fin.fgUndo'),
          onClick: () => {
            void apiFetch(`/finance/fieldglass/${associateId}/done`, {
              method: 'DELETE',
            }).then(() => refresh());
          },
        },
      });
    } catch {
      toast.error(t('fin.fgFailed'));
    } finally {
      setFgBusy(null);
    }
  };

  // Close-out done = the registration is removed (the account no longer
  // exists at the client); Undo re-creates it.
  const markFieldglassClosed = async (associateId: string) => {
    setFgBusy(associateId);
    try {
      await apiFetch(`/finance/fieldglass/${associateId}/done`, { method: 'DELETE' });
      void refresh();
      toast.success(t('fin.fgClosedDone'), {
        action: {
          label: t('fin.fgUndo'),
          onClick: () => {
            void apiFetch(`/finance/fieldglass/${associateId}/done`, {
              method: 'POST',
            }).then(() => refresh());
          },
        },
      });
    } catch {
      toast.error(t('fin.fgFailed'));
    } finally {
      setFgBusy(null);
    }
  };

  return (
    <>
    <ul className="divide-y divide-navy-secondary/60">
      {queue.map((w) => {
        const soon =
          w.firstShiftAt !== null &&
          new Date(w.firstShiftAt).getTime() - Date.now() <
            48 * 3600_000;
        const open = fgOpen === w.associateId;
        return (
          <li key={w.associateId} className="py-2.5">
            <div className="flex items-center gap-3">
              <Avatar
                src={`/api/associates/${w.associateId}/photo`}
                name={w.name}
                email=""
                size="md"
              />
              {/* Tap unfolds the entry facts — the whole Fieldglass
                  entry happens here, no navigation round trip. */}
              <button
                type="button"
                onClick={() => setFgOpen(open ? null : w.associateId)}
                aria-expanded={open}
                className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-white">
                    {w.name}
                    {w.clientName && (
                      <span className="font-normal text-silver/80">
                        {' '}· {w.clientName}
                      </span>
                    )}
                  </span>
                  {w.kind === 'transfer' && (
                    <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                      {t('fin.fgTransfer')}
                    </span>
                  )}
                  {w.kind === 'close' && (
                    <span className="shrink-0 rounded-full bg-alert/15 px-2 py-0.5 text-2xs font-medium text-alert">
                      {t('fin.fgCloseBadge')}
                    </span>
                  )}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-silver/50 transition-transform',
                      open && 'rotate-180',
                    )}
                  />
                </div>
                <div className="text-xs text-silver tabular-nums">
                  {w.kind === 'close' ? (
                    <span className="font-medium text-alert">
                      {t('fin.fgCloseLine', { client: w.clientName ?? '—' })}
                    </span>
                  ) : (
                    <>
                      {w.kind === 'transfer' && (
                        <span className="font-medium text-warning">
                          {t('fin.fgTransferLine', {
                            from: w.fromClientName ?? '—',
                            to: w.clientName ?? '—',
                          })}
                        </span>
                      )}
                      {w.kind === 'transfer' && ' · '}
                      {(w.hoursUnbilled ?? 0) > 0 && (
                        <>
                          <span className="font-medium text-alert">
                            {t('fin.fgUnbilled', { hours: w.hoursUnbilled!.toFixed(1) })}
                          </span>
                          {' · '}
                        </>
                      )}
                      {/* Moved before being added to Fieldglass —
                          add under where they work now. */}
                      {w.kind === 'add' && w.fromClientName && (
                        <>
                          <span className="font-medium text-warning">
                            {t('fin.fgMovedLine', { from: w.fromClientName, to: w.clientName ?? '—' })}
                          </span>
                          {' · '}
                        </>
                      )}
                      <span className={cn(soon && 'font-medium text-warning')}>
                        {w.firstShiftAt
                          ? t('fin.fgFirstShift', { date: fmtDate(w.firstShiftAt) })
                          : t('fin.fgNoShift')}
                      </span>
                      {w.position && (
                        <span className="text-silver/60"> · {w.position}</span>
                      )}
                      {w.approvedAt && (
                        <span className="text-silver/60">
                          {' '}· {t('fin.fgApprovedOn', { date: fmtDate(w.approvedAt) })}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </button>
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                loading={fgBusy === w.associateId}
                disabled={fgBusy !== null}
                onClick={() =>
                  w.kind === 'close'
                    ? void markFieldglassClosed(w.associateId)
                    : setAdding({ associateId: w.associateId, name: w.name })
                }
              >
                {w.kind === 'close' ? t('fin.fgMarkClosed') : t('fin.fgMark')}
              </Button>
            </div>
            {open && (
              <div className="grid animate-unfold">
                <div className="overflow-hidden">
                  <div className="ml-[52px] mt-2">
                    <FieldglassPacketPanel associateId={w.associateId} kind={w.kind} />
                  </div>
                  <Link
                    to={`/people?associateId=${w.associateId}&return=${encodeURIComponent(returnTo)}`}
                    className="ml-[52px] mt-2 inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9"
                  >
                    {t('fin.fgFullRecord')}
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
      {adding && (
        <MarkAddedDialog
          name={adding.name}
          busy={fgBusy === adding.associateId}
          onConfirm={(workerId) => void markFieldglass(adding.associateId, workerId)}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}
