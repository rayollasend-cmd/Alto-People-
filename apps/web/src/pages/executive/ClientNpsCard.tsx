import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getNpsResults } from '@/lib/npsApi';
import { fmtDate } from '@/lib/format';
import { NpsNumber } from '@/pages/clients/ClientNpsPage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

/** The quarter's client NPS on the executive's home, with the lowest clients first. */
export function ClientNpsCard() {
  const q = useQuery({ queryKey: ['executive', 'nps'], queryFn: getNpsResults });
  const r = q.data ?? null;
  if (q.isError) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Client NPS</CardTitle>
          <Link to="/clients/nps" className="text-xs text-accent hover:underline">
            Every client and the trend
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {!r ? (
          <Skeleton className="h-20" />
        ) : !r.current ? (
          <EmptyState title="No survey sent yet" description="One question to every store manager, once a quarter. The first wave goes out in the first week of a quarter." className="py-4" />
        ) : (
          <div className="flex flex-wrap items-start gap-6">
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-muted">{r.current.quarter}</div>
              <NpsNumber nps={r.current.nps} className="text-4xl font-semibold" />
              <div className="mt-0.5 text-xs text-ink-muted">
                {r.current.responded} of {r.current.invited} answered · {r.current.open ? `open until ${fmtDate(r.current.closesAt)}` : 'closed'}
              </div>
            </div>
            <ul className="min-w-0 flex-1 divide-y divide-line">
              {r.byClient.slice(0, 4).map((c) => (
                <li key={c.clientId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                  <Link to={`/clients/${c.clientId}`} className="min-w-0 truncate text-ink hover:text-accent">
                    {c.clientName}
                  </Link>
                  <NpsNumber nps={c.nps} className="font-semibold" />
                </li>
              ))}
              {r.byClient.length === 0 && <li className="py-1.5 text-sm text-ink-muted">Answers show here as they arrive.</li>}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
