import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Phone } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, fmtRelativeDayTz, fmtTimeTz } from '@/lib/format';
import { associatePhotoUrl } from '@/lib/photoUrl';
import { getRiderProfile, remindUnsignedRiders, type Ride, type RideStatus } from '@/lib/transportApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { MetricCard } from '@/components/ui/MetricCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Transport walk 7 — the rider's record, one click from any name on the
 * board, a run, the Rides tab or an issue: the last 30 rides, how often
 * they no-show, what they owe and what's held until they sign, whether
 * they've signed (with "Ask to sign"), phone and message, open issues.
 * Opens from `/transport?rider=<associateId>` — an exact-record link.
 */

const cents = (n: number) => fmtMoney(n / 100);
const STATUS: Record<RideStatus, { label: string; variant: 'accent' | 'success' | 'pending' | 'destructive' | 'default' }> = {
  REQUESTED: { label: 'Needs a van', variant: 'pending' },
  SCHEDULED: { label: 'Scheduled', variant: 'accent' },
  BOARDED: { label: 'On board', variant: 'success' },
  COMPLETED: { label: 'Done', variant: 'default' },
  NO_SHOW: { label: 'No-show', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'default' },
};

export function RiderDrawer({ associateId, manage, onClose, onIssues }: { associateId: string | null; manage: boolean; onClose: () => void; onIssues?: () => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['transport', 'rider', associateId], queryFn: () => getRiderProfile(associateId!), enabled: !!associateId });
  const remind = useMutation({
    mutationFn: () => remindUnsignedRiders([associateId!]),
    onSuccess: (r) => {
      toast.success(r.sent ? 'Asked them to sign.' : 'Already reminded in the last day, or not reachable.');
      void queryClient.invalidateQueries({ queryKey: ['transport'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the reminder.'),
  });
  const r = q.data?.rider;
  const recent: Ride[] = q.data?.recent ?? [];
  return (
    <Drawer open={!!associateId} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>{r?.name ?? 'Rider'}</DrawerTitle>
        <DrawerDescription>{r ? `Riding since ${fmtDate(r.since)}` : 'The rider’s record'}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {q.isLoading || !r ? (
          q.isError ? <QueryError what="this rider" query={q} /> : <Skeleton className="h-48" />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar src={associatePhotoUrl(r.associateId)} name={r.name} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {r.authorization ? (
                    <Badge variant={r.authorization.current ? 'success' : r.authorization.withdrawnAt ? 'destructive' : 'pending'}>
                      {r.authorization.current ? 'Signed' : r.authorization.withdrawnAt ? 'Withdrawn' : 'Must sign'}
                    </Badge>
                  ) : null}
                  {(r.openIssues ?? 0) > 0 && (
                    <Button size="xs" variant="ghost" onClick={onIssues}>
                      {r.openIssues} open {r.openIssues === 1 ? 'issue' : 'issues'}
                    </Button>
                  )}
                </div>
                {r.authorization && !r.authorization.current && r.authorization.reason && <p className="mt-0.5 text-xs text-silver">{r.authorization.reason}</p>}
              </div>
              <div className="flex items-center gap-2">
                {r.phone && (
                  <>
                    <Button size="sm" variant="secondary" asChild>
                      <a href={`tel:${r.phone}`}>
                        <Phone className="h-3.5 w-3.5" />
                        Call
                      </a>
                    </Button>
                    <Button size="sm" variant="secondary" asChild>
                      <a href={`sms:${r.phone.replace(/[^+\d]/g, '')}`}>
                        <MessageSquare className="h-3.5 w-3.5" />
                        Text
                      </a>
                    </Button>
                  </>
                )}
                {manage && r.authorization && !r.authorization.current && r.userId && (
                  <Button size="sm" loading={remind.isPending} disabled={remind.isPending} onClick={() => remind.mutate()}>
                    Ask to sign
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard label="Rides" value={r.rides} />
              <MetricCard label="No-shows" value={r.noShows} hint={r.noShowRate !== null && r.noShowRate !== undefined ? `${r.noShowRate}% of marked rides` : undefined} accent={r.noShows > 1} />
              <MetricCard label="Owed" value={cents(r.owedCents ?? 0)} hint={(r.heldCents ?? 0) > 0 ? `${cents(r.heldCents ?? 0)} held until they sign` : 'comes out at the next payroll'} accent={(r.heldCents ?? 0) > 0} />
              <MetricCard label="Waived" value={cents(r.waivedCents ?? 0)} hint={(r.notAuthorizedCents ?? 0) > 0 ? `${cents(r.notAuthorizedCents ?? 0)} not charged — unsigned` : undefined} />
            </div>
            {(r.heldCents ?? 0) > 0 && <p className="text-xs text-silver">A ride taken is never waived — what’s held comes out of pay once they sign the ride authorization.</p>}
            <section aria-label="Recent rides">
              <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-silver">Last {recent.length} rides</h3>
              {recent.length === 0 ? (
                <p className="text-sm text-silver">No rides on record.</p>
              ) : (
                <ul className="divide-y divide-navy-secondary/60 text-sm">
                  {recent.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                      <span className="w-36 shrink-0 tabular-nums text-ink">
                        {fmtRelativeDayTz(x.targetAt, x.store.timezone)} {fmtTimeTz(x.targetAt, x.store.timezone)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-silver">
                        {x.direction === 'TO_WORK' ? 'To' : 'Home from'} {x.store.name}
                        {x.run ? ` · ${x.run.van.name}` : ''}
                      </span>
                      <Badge size="sm" variant={STATUS[x.status].variant}>
                        {STATUS[x.status].label}
                      </Badge>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-silver">
                        {x.waiveKind === 'NOT_AUTHORIZED' ? 'unsigned' : x.waived ? 'waived' : x.heldForSignature ? `${cents(x.owedCents)} held` : x.owedCents > 0 ? cents(x.owedCents) : x.charged ? 'from pay' : ''}
                      </span>
                      {x.status === 'NO_SHOW' && x.noShowDistanceM !== null && x.noShowDistanceM !== undefined && (
                        <span className="text-2xs text-silver" title="How far the driver's phone was from the stop at the no-show">
                          van {x.noShowDistanceM} m away
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
