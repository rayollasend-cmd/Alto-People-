import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Flag } from '@/components/ui/icons';
import { useTenant, useTerm } from '@/lib/auth';
import { fmtDateOnlyRange, fmtDateTime, fmtHours } from '@/lib/format';
import { getClientSignOffs, type SignOffState, type StaffSignOffWeek } from '@/lib/hoursSignOffApi';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The client's sign-off on its stores' weekly hours, as staff read it on the
 * client's page: each finished week, store by store — the hours worked now,
 * and whether the store manager signed them off, flagged lines (with their
 * notes), or the hours moved after they signed. Only where the client
 * portal is on; hours only.
 */

const STATE: Record<SignOffState, { label: string; variant: 'success' | 'pending' | 'destructive' | 'default' }> = {
  signed: { label: 'Signed off', variant: 'success' },
  flagged: { label: 'Signed with questions', variant: 'pending' },
  changed: { label: 'Changed since sign-off', variant: 'destructive' },
  unsigned: { label: 'Not signed off', variant: 'default' },
};

export const hoursSignOffKey = (clientId: string) => ['clients', clientId, 'hours-signoffs'] as const;

export function HoursSignOffCard({ clientId }: { clientId: string }) {
  const tenant = useTenant();
  const term = useTerm();
  const site = term('site').toLowerCase();
  const on = tenant.moduleOn('clientPortal');
  const q = useQuery({ queryKey: hoursSignOffKey(clientId), queryFn: () => getClientSignOffs(clientId), enabled: on, staleTime: 60_000 });
  if (!on || q.data?.enabled === false) return null;
  const rows = q.data?.weeks ?? null;
  return (
    <Card data-testid="client-hours-signoff">
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle size="sm" className="mb-0" icon={ClipboardCheck} title="Hours sign-off" />
        <p className="mt-1 text-xs text-ink-muted">
          The client&rsquo;s sign-off on each {site}&rsquo;s finished week: worked hours, breaks out, as the statement bills them.
        </p>
        {rows === null ? (
          q.isError ? (
            <p className="mt-3 text-sm text-ink-muted">Couldn&rsquo;t load the sign-offs.</p>
          ) : (
            <Skeleton className="mt-3 h-24" />
          )
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No worked hours in the last six finished weeks.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {rows.map((r) => (
              <SignOffRow key={`${r.locationId}-${r.weekStart}`} r={r} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SignOffRow({ r }: { r: StaffSignOffWeek }) {
  const st = STATE[r.state];
  const s = r.signOff;
  return (
    <li className="py-2.5" data-testid="hours-signoff-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{r.storeName}</span>
          <span className="block text-xs tabular-nums text-ink-muted">
            {fmtDateOnlyRange(r.weekStart, r.weekEnd)} · {fmtHours(r.hours.totalHours)} · {r.hours.people} {r.hours.people === 1 ? 'person' : 'people'}
          </span>
        </span>
        <Badge variant={st.variant} size="sm">
          {st.label}
        </Badge>
      </div>
      {s && (
        <p className="mt-1 text-xs text-ink-muted">
          {s.status === 'FLAGGED' ? 'Flagged' : 'Signed'} by {s.signedByName} · {fmtDateTime(s.signedAt)} · {fmtHours(s.totalHours)} at signing
          {r.state === 'changed' ? ` · ${fmtHours(r.hours.totalHours)} now` : ''}
        </p>
      )}
      {s && s.flags.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {s.flags.map((f) => (
            <li key={f.associateId} className="flex items-start gap-1.5 text-xs text-ink">
              <Flag className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
              <span>
                <span className="font-medium">{f.name}</span> ({fmtHours(f.hours)}): {f.note}
              </span>
            </li>
          ))}
        </ul>
      )}
      {s?.note && <p className="mt-1 text-xs italic text-ink-muted">&ldquo;{s.note}&rdquo;</p>}
    </li>
  );
}
