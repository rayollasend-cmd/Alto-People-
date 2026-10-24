import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, FileUp, RefreshCw } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtTime } from '@/lib/format';
import { getMarketData, importOews, refreshMarketData } from '@/lib/marketRatesApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Where the wage figures come from and how fresh they are. They refresh
 * on their own every week from the Bureau of Labor Statistics; "Refresh
 * now" fetches what's missing at once; and the published OEWS table can
 * be imported when the API isn't an option.
 */

export function MarketDataTab() {
  const { can } = useAuth();
  const canManage = can('manage:clients') || can('process:payroll');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['market', 'data'], queryFn: getMarketData });
  const refresh = useMutation({
    mutationFn: () => refreshMarketData(false),
    onSuccess: (r) => {
      toast.success(r.fetched === 0 ? 'Everything is already up to date.' : `Fetched ${r.saved} of ${r.fetched} metro and occupation pairs.`);
      if (r.messages.length) toast.message(r.messages.slice(0, 2).join(' '));
      void qc.invalidateQueries({ queryKey: ['market'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not reach the wage data service.'),
  });

  if (q.isError) return <QueryError what="the wage data" query={q} />;
  if (q.isLoading || !q.data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }
  const d = q.data;
  return (
    <div className="space-y-5">
      {/* The source is said once, in full, under the numbers — not a "SOURCE BLS" tile. */}
      <MetricStrip label="Wage data at a glance">
        <MetricCard label="Pairs with figures" value={d.pairs ? `${d.covered} of ${d.pairs}` : '—'} hint="Metro × occupation in use" tone={d.pairs > 0 && d.covered < d.pairs ? 'warning' : 'default'} />
        <MetricCard label="Survey year" value={d.latestYear ?? '—'} hint="Published once a year, each spring" />
        <MetricCard
          label="Last fetched"
          value={d.lastFetchedAt ? fmtDate(d.lastFetchedAt) : 'Never'}
          hint={`${d.lastFetchedAt ? `At ${fmtTime(d.lastFetchedAt)} · ` : ''}refreshes every ${Math.round(d.refreshEveryHours / 24)} days`}
        />
      </MetricStrip>
      <p className="text-sm text-ink-muted">
        {d.sources.includes('OEWS_IMPORT')
          ? 'From a table imported from the U.S. Bureau of Labor Statistics’ Occupational Employment and Wage Statistics.'
          : `From the U.S. Bureau of Labor Statistics’ Occupational Employment and Wage Statistics, through its public API${d.apiKeyConfigured ? ' with a registration key' : ''}.`}
      </p>

      {d.pairs === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Database} title="Nothing to fetch yet" description="Figures are fetched for the metros and occupations you map. Map a store and a role first, on the Mapping tab." />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4 p-4 md:p-5">
            <SectionTitle
              icon={RefreshCw}
              title="Fetch new figures"
              description="Occupational Employment and Wage Statistics: hourly wages at the 10th, 25th, 50th, 75th and 90th percentile, by metro area."
              trailing={
                canManage ? (
                  <Button size="sm" onClick={() => refresh.mutate()} loading={refresh.isPending}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Refresh now
                  </Button>
                ) : undefined
              }
            />
            {!d.apiKeyConfigured && (
              <ErrorBanner severity="info">
                Running without a BLS registration key: refreshes still work, a little more slowly and with a lower daily limit. Ask your administrator to set one.
              </ErrorBanner>
            )}
            {d.missing.length > 0 ? (
              <div>
                <div className="mb-1 text-xs font-medium text-ink-muted">Still without figures</div>
                <ul className="divide-y divide-line text-sm">
                  {d.missing.map((m) => (
                    <li key={`${m.areaCode}-${m.socCode}`} className="flex flex-wrap justify-between gap-x-3 py-2">
                      <span className="text-ink">{m.socTitle}</span>
                      <span className="text-ink-muted">{m.areaName}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-ink-muted">Some small metros don’t publish every occupation. Those stay without figures until the survey covers them.</p>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Every metro and occupation you use has figures.</p>
            )}
          </CardContent>
        </Card>
      )}

      {canManage && <ImportCard />}
    </div>
  );
}

function ImportCard() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [file, setFile] = useState<File | null>(null);
  const run = useMutation({
    mutationFn: async () => importOews(Number(year), await file!.text()),
    onSuccess: (r) => {
      toast.success(`Imported ${r.saved.toLocaleString()} rows${r.skipped ? `; ${r.skipped.toLocaleString()} skipped (not a metro-and-occupation row)` : ''}.`);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      void qc.invalidateQueries({ queryKey: ['market'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not import that file.'),
  });
  const yearOk = /^\d{4}$/.test(year) && Number(year) >= 2015;
  return (
    <Card>
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle icon={FileUp} title="Import the published table" description="The OEWS metropolitan-area table, saved as CSV. Useful when the API is blocked, or to load every metro at once." />
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (file && yearOk) run.mutate();
          }}
        >
          <Field label="Survey year" error={yearOk ? undefined : 'A year from 2015 on'} className="w-32">
            {(p) => <Input {...p} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />}
          </Field>
          <Field label="CSV file" className="min-w-0 flex-1 basis-56">
            {(p) => <Input {...p} ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
          </Field>
          <Button type="submit" disabled={!file || !yearOk} loading={run.isPending}>
            Import
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
