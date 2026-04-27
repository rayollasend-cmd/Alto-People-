import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Filter, RefreshCw, Search } from 'lucide-react';
import type { AuditSearchEntry } from '@alto-people/shared';
import {
  auditCsvUrl,
  searchAuditLogs,
  type AuditFilters,
} from '@/lib/auditApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

const PAGE_SIZE = 100;

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

function metaPreview(m: Record<string, unknown> | null): string {
  if (!m) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === 'ip' || k === 'userAgent') continue;
    const str =
      typeof v === 'string' ? v : v === null ? 'null' : JSON.stringify(v);
    parts.push(`${k}=${str}`);
    if (parts.join(' · ').length > 140) break;
  }
  const joined = parts.join(' · ');
  return joined.length > 160 ? `${joined.slice(0, 157)}…` : joined;
}

/**
 * Phase 40 — global audit-log search. AuditLog rows have been written
 * since Phase 6 across auth / onboarding / time / payroll / shifts /
 * documents / compliance, but the only viewer until now was the
 * per-application timeline. This page lets HR/Exec slice by action,
 * entity, actor, and time window, and export the result as CSV for
 * external compliance work.
 */
export function AuditHome() {
  const [filters, setFilters] = useState<AuditFilters>({ limit: PAGE_SIZE });
  const [appliedFilters, setAppliedFilters] = useState<AuditFilters>({ limit: PAGE_SIZE });
  const [entries, setEntries] = useState<AuditSearchEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (f: AuditFilters) => {
    setLoading(true);
    setError(null);
    try {
      const res = await searchAuditLogs(f);
      setEntries(res.entries);
      setNextBefore(res.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(appliedFilters);
  }, [load, appliedFilters]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await searchAuditLogs({ ...appliedFilters, before: nextBefore });
      setEntries((prev) => [...(prev ?? []), ...res.entries]);
      setNextBefore(res.nextBefore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setAppliedFilters({ ...filters, limit: PAGE_SIZE });
  };

  const reset = () => {
    const empty: AuditFilters = { limit: PAGE_SIZE };
    setFilters(empty);
    setAppliedFilters(empty);
  };

  const csvHref = useMemo(() => auditCsvUrl(appliedFilters), [appliedFilters]);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Audit log
          </h1>
          <p className="text-silver">
            Every authentication, onboarding, payroll, scheduling, and
            document event in one searchable feed. Used for SOC 2,
            compliance reviews, and incident forensics.
          </p>
        </div>
        <Button asChild variant="secondary">
          <a href={csvHref} download>
            <Download className="h-4 w-4" />
            Export CSV
          </a>
        </Button>
      </header>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4 text-gold" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={apply} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <Label htmlFor="aud-q">Action contains</Label>
                <Input
                  id="aud-q"
                  value={filters.q ?? ''}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, q: e.target.value || undefined }))
                  }
                  placeholder="e.g. payroll, login_failed"
                />
              </div>
              <div>
                <Label htmlFor="aud-entityType">Entity type</Label>
                <Input
                  id="aud-entityType"
                  value={filters.entityType ?? ''}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      entityType: e.target.value || undefined,
                    }))
                  }
                  placeholder="Application, User, PayrollRun…"
                />
              </div>
              <div>
                <Label htmlFor="aud-entityId">Entity ID</Label>
                <Input
                  id="aud-entityId"
                  value={filters.entityId ?? ''}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      entityId: e.target.value || undefined,
                    }))
                  }
                  placeholder="UUID or email"
                />
              </div>
              <div>
                <Label htmlFor="aud-actor">Actor user ID</Label>
                <Input
                  id="aud-actor"
                  value={filters.actorUserId ?? ''}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      actorUserId: e.target.value || undefined,
                    }))
                  }
                  placeholder="UUID"
                />
              </div>
              <div>
                <Label htmlFor="aud-since">Since</Label>
                <Input
                  id="aud-since"
                  type="datetime-local"
                  value={isoToLocal(filters.since)}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      since: localToIso(e.target.value),
                    }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="aud-before">Before</Label>
                <Input
                  id="aud-before"
                  type="datetime-local"
                  value={isoToLocal(filters.before)}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      before: localToIso(e.target.value),
                    }))
                  }
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={reset}>
                Reset
              </Button>
              <Button type="submit" loading={loading}>
                <Search className="h-4 w-4" />
                Search
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error && (
        <div
          className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading && !entries && (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          )}
          {entries && entries.length === 0 && !loading && (
            <p className="text-sm text-silver p-6 text-center">
              No audit rows match these filters.
            </p>
          )}
          {entries && entries.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-silver text-xs whitespace-nowrap tabular-nums">
                      {fmtTs(e.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {e.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-silver text-xs truncate max-w-[16ch]">
                      {e.actorEmail ?? (
                        <span className="text-silver/50">system</span>
                      )}
                    </TableCell>
                    <TableCell className="text-silver text-xs">
                      <div className="text-white">{e.entityType}</div>
                      <div className="font-mono text-[10px] text-silver/60 truncate max-w-[20ch]">
                        {e.entityId}
                      </div>
                    </TableCell>
                    <TableCell className="text-silver text-xs font-mono truncate max-w-[44ch]">
                      {metaPreview(e.metadata)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {nextBefore && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            <RefreshCw className="h-4 w-4" />
            Load older entries
          </Button>
        </div>
      )}
      {entries && entries.length > 0 && !nextBefore && (
        <p className="text-xs text-silver/60 mt-4 text-center">
          End of results — {entries.length} row{entries.length === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}

function isoToLocal(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}
