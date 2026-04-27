import { useEffect, useState } from 'react';
import { AlertCircle, Calendar, Clock, ShieldAlert } from 'lucide-react';
import {
  getExpirations,
  type ExpirationItem,
  type ExpirationsResponse,
} from '@/lib/expirations113Api';
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

/**
 * Phase 113 — Expiration dashboard.
 *
 * Three buckets stacked: expired (urgent — block deployment),
 * due soon (next N days), due later (informational, capped at 365).
 * Toggle between certs only / all qualifications.
 */
export function ExpirationsHome() {
  const [data, setData] = useState<ExpirationsResponse | null>(null);
  const [days, setDays] = useState<30 | 60 | 90>(60);
  const [filter, setFilter] = useState<'all' | 'cert'>('all');

  useEffect(() => {
    setData(null);
    getExpirations({
      days,
      isCert: filter === 'cert' ? true : undefined,
    })
      .then(setData)
      .catch(() => setData(null));
  }, [days, filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Expirations"
        subtitle="Qualifications and certifications expiring soon — chase renewals before they lapse."
        breadcrumbs={[{ label: 'Expirations' }]}
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-silver">Within:</span>
        {[30, 60, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d as 30 | 60 | 90)}
            className={`px-3 py-1 rounded-full border transition ${
              days === d
                ? 'bg-cyan-600 border-cyan-500 text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
            }`}
          >
            {d}d
          </button>
        ))}
        <span className="ml-4 text-silver">Type:</span>
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded-full border transition ${
            filter === 'all'
              ? 'bg-cyan-600 border-cyan-500 text-white'
              : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('cert')}
          className={`px-3 py-1 rounded-full border transition ${
            filter === 'cert'
              ? 'bg-cyan-600 border-cyan-500 text-white'
              : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
          }`}
        >
          Certs only
        </button>
      </div>

      {data === null ? (
        <Card><CardContent><SkeletonRows count={5} /></CardContent></Card>
      ) : (
        <div className="space-y-4">
          <Bucket
            title="Expired"
            icon={AlertCircle}
            accent="text-rose-400"
            count={data.counts.expired}
            items={data.expired}
            emptyHint="Nothing expired."
          />
          <Bucket
            title={`Due in next ${data.days} days`}
            icon={ShieldAlert}
            accent="text-amber-400"
            count={data.counts.dueSoon}
            items={data.dueSoon}
            emptyHint="Nothing due soon."
          />
          <Bucket
            title="Due later (within 1 year)"
            icon={Calendar}
            accent="text-cyan-400"
            count={data.counts.dueLater}
            items={data.dueLater}
            emptyHint="Nothing further out."
          />
        </div>
      )}
    </div>
  );
}

function Bucket({
  title,
  icon: Icon,
  accent,
  count,
  items,
  emptyHint,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  count: number;
  items: ExpirationItem[];
  emptyHint: string;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4 pb-2 flex items-center gap-2">
          <Icon className={`h-4 w-4 ${accent}`} />
          <div className="text-sm uppercase tracking-wider text-silver">
            {title}
          </div>
          <Badge variant="outline">{count}</Badge>
        </div>
        {items.length === 0 ? (
          <EmptyState icon={Clock} title="" description={emptyHint} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Qualification</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>In</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.slice(0, 100).map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium text-white">
                    {i.associateName}
                  </TableCell>
                  <TableCell className="text-silver text-xs">{i.associateEmail}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {i.qualificationName}
                      {i.isCert && <Badge variant="accent">cert</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{i.qualificationCode}</TableCell>
                  <TableCell>{new Date(i.expiresAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {i.daysUntilExpiry < 0 ? (
                      <span className="text-rose-400">{-i.daysUntilExpiry}d ago</span>
                    ) : i.daysUntilExpiry < 30 ? (
                      <span className="text-amber-400">{i.daysUntilExpiry}d</span>
                    ) : (
                      <span className="text-silver">{i.daysUntilExpiry}d</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
