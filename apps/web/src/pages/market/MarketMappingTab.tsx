import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Check, MapPinned, Sparkles } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { getMarketMapping, setPositionSoc, setSiteArea, type MarketMapping } from '@/lib/marketRatesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SearchInput } from '@/components/ui/FilterBar';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * What the desk benchmarks against: each store's metro area, each role's
 * occupation. Most come suggested — a zip or city for the metro, the words
 * in the role's name for the occupation — and one tap accepts a suggestion
 * (or all of them). A metro or occupation the list doesn't carry can still
 * be chosen by code.
 */

export function MarketMappingTab() {
  const { can } = useAuth();
  const canManage = can('manage:clients') || can('process:payroll');
  const q = useQuery({ queryKey: ['market', 'mapping'], queryFn: getMarketMapping });

  if (q.isError) return <QueryError what="the mapping" query={q} />;
  if (q.isLoading || !q.data) {
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    );
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <StoresCard data={q.data} canManage={canManage} />
      <RolesCard data={q.data} canManage={canManage} />
    </div>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['market'] });
}

function StoresCard({ data, canManage }: { data: MarketMapping; canManage: boolean }) {
  const term = useTerm();
  const invalidate = useInvalidate();
  const [filter, setFilter] = useState('');
  const save = useMutation({
    mutationFn: ({ siteId, code }: { siteId: string; code: string | null }) => setSiteArea(siteId, code),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the metro.'),
  });
  const pending = data.sites.filter((s) => !s.area && s.suggestion);
  const acceptAll = useMutation({
    mutationFn: async () => {
      for (const s of pending) await setSiteArea(s.id, s.suggestion!.code);
    },
    onSuccess: () => {
      toast.success(`${pending.length} ${pending.length === 1 ? term('label.store').toLowerCase() : term('label.stores').toLowerCase()} given their metro.`);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save every metro.'),
  });
  const shown = useMemo(() => data.sites.filter((s) => !filter || `${s.name} ${s.clientName ?? ''} ${s.place ?? ''}`.toLowerCase().includes(filter.toLowerCase())), [data.sites, filter]);
  const done = data.sites.filter((s) => s.area).length;

  return (
    <Card>
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle
          icon={MapPinned}
          title={`${term('label.stores')} and their metro`}
          description={`${done} of ${data.sites.length} set. Wages are compared within the metro area (as the Bureau of Labor Statistics defines it).`}
          trailing={
            canManage && pending.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => acceptAll.mutate()} loading={acceptAll.isPending}>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Use {pending.length} suggestion{pending.length === 1 ? '' : 's'}
              </Button>
            ) : undefined
          }
        />
        {data.sites.length > 8 && <SearchInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find a ${term('label.store').toLowerCase()}`} aria-label={`Find a ${term('label.store').toLowerCase()}`} />}
        {data.sites.length === 0 ? (
          <EmptyState icon={MapPinned} title={`No ${term('label.stores').toLowerCase()} yet`} description={`Add ${term('label.stores').toLowerCase()} on the Org chart, then give each its metro here.`} />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <div className="truncate text-sm font-medium text-ink">{s.name}</div>
                  <div className="truncate text-xs text-ink-muted">{[s.clientName, s.place, s.zip].filter(Boolean).join(' · ') || 'No address on file'}</div>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <label htmlFor={`area-${s.id}`} className="sr-only">
                    Metro for {s.name}
                  </label>
                  <Select
                    id={`area-${s.id}`}
                    size="sm"
                    className="w-full sm:w-96"
                    title={s.area?.name ?? undefined}
                    value={s.area?.code ?? ''}
                    disabled={!canManage || save.isPending}
                    onChange={(e) => save.mutate({ siteId: s.id, code: e.target.value || null })}
                  >
                    <option value="">Not set</option>
                    {s.area && !data.catalog.areas.some((a) => a.code === s.area!.code) && <option value={s.area.code}>{s.area.name}</option>}
                    {data.catalog.areas.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {!s.area && s.suggestion && (
                  <div className="flex w-full flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span>
                      Suggested: <span className="text-ink">{s.suggestion.name}</span> (from {s.suggestion.reason})
                    </span>
                    {canManage && (
                      <Button size="xs" variant="ghost" onClick={() => save.mutate({ siteId: s.id, code: s.suggestion!.code })}>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        Use it
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RolesCard({ data, canManage }: { data: MarketMapping; canManage: boolean }) {
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: ({ name, code }: { name: string; code: string | null }) => setPositionSoc(name, code),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the occupation.'),
  });
  const pending = data.positions.filter((p) => !p.soc && p.suggestion);
  const acceptAll = useMutation({
    mutationFn: async () => {
      for (const p of pending) await setPositionSoc(p.name, p.suggestion!.code);
    },
    onSuccess: () => {
      toast.success(`${pending.length} role${pending.length === 1 ? '' : 's'} given their occupation.`);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save every occupation.'),
  });
  const done = data.positions.filter((p) => p.soc).length;

  return (
    <Card>
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle
          icon={Briefcase}
          title="Roles and their occupation"
          description={`${done} of ${data.positions.length} set. Each role is compared with the matching federal occupation.`}
          trailing={
            canManage && pending.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => acceptAll.mutate()} loading={acceptAll.isPending}>
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Use {pending.length} suggestion{pending.length === 1 ? '' : 's'}
              </Button>
            ) : undefined
          }
        />
        {data.positions.length === 0 ? (
          <EmptyState icon={Briefcase} title="No roles yet" description="Roles come from rate cards, shift positions and job profiles. Add rates for a role and it appears here." />
        ) : (
          <ul className="divide-y divide-line">
            {data.positions.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate text-sm font-medium text-ink">{p.name}</div>
                  {p.soc ? (
                    <Badge variant="success" size="sm" className="mt-0.5">
                      Benchmarked
                    </Badge>
                  ) : (
                    <div className="text-xs text-ink-muted">Not benchmarked yet</div>
                  )}
                </div>
                <div className="w-full sm:w-auto">
                  <label htmlFor={`soc-${p.key}`} className="sr-only">
                    Occupation for {p.name}
                  </label>
                  <Select
                    id={`soc-${p.key}`}
                    size="sm"
                    className="w-full sm:w-96"
                    title={p.soc?.title ?? undefined}
                    value={p.soc?.code ?? ''}
                    disabled={!canManage || save.isPending}
                    onChange={(e) => save.mutate({ name: p.name, code: e.target.value || null })}
                  >
                    <option value="">Not set</option>
                    {p.soc && !data.catalog.occupations.some((o) => o.code === p.soc!.code) && <option value={p.soc.code}>{p.soc.title}</option>}
                    {data.catalog.occupations.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.title}
                      </option>
                    ))}
                  </Select>
                </div>
                {!p.soc && p.suggestion && (
                  <div className="flex w-full flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span>
                      Suggested: <span className="text-ink">{p.suggestion.title}</span> ({p.suggestion.reason})
                    </span>
                    {canManage && (
                      <Button size="xs" variant="ghost" onClick={() => save.mutate({ name: p.name, code: p.suggestion!.code })}>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        Use it
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
