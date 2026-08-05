import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Download, FileSearch, Filter, RefreshCw, Search } from 'lucide-react';
import type { AuditSearchEntry } from '@alto-people/shared';
import {
  auditCsvUrl,
  searchAuditLogs,
  type AuditFilters,
} from '@/lib/auditApi';
import { ApiError } from '@/lib/api';
import { listDirectory } from '@/lib/directoryApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/Card';
import {
  AssociatePicker,
  type PickedAssociate,
} from '@/components/ui/AssociatePicker';
import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { fmtDateTime } from '@/lib/format';

import { dayHeading, fmtTimeOnly, groupByDay } from '@/lib/dayGroup';

const PAGE_SIZE = 100;

/**
 * Entity types the app actually writes audit rows for. Kept as a Select so
 * HR doesn't have to guess exact casing; "Other…" opens a free-text escape
 * for anything not listed here yet.
 */
const KNOWN_ENTITY_TYPES = [
  'Application',
  'User',
  'Associate',
  'PayrollRun',
  'Agreement',
  'DocumentRecord',
  'TimeEntry',
  'Shift',
  'Client',
] as const;

const ENTITY_OTHER = '__other__';

function sinceDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Default window: last 7 days. An unbounded first query on years of audit
 *  rows is slow AND useless — nobody reviews "all history" first. */
function defaultFilters(): AuditFilters {
  return { limit: PAGE_SIZE, since: sinceDaysAgo(7) };
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
  const [filters, setFilters] = useState<AuditFilters>(defaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<AuditFilters>(defaultFilters);
  const [entries, setEntries] = useState<AuditSearchEntry[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Other…" free-text mode for the entity-type filter.
  const [entityOther, setEntityOther] = useState(false);
  // Associate helper next to the raw actor-ID input (see the Field hint).
  const [helperAssociate, setHelperAssociate] = useState<PickedAssociate | null>(null);
  // Row detail drawer.
  const [detail, setDetail] = useState<AuditSearchEntry | null>(null);

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
    const empty = defaultFilters();
    setFilters(empty);
    setAppliedFilters(empty);
    setEntityOther(false);
    setHelperAssociate(null);
  };

  // Quick time-window chips — set `since` and search immediately.
  const applyPreset = (hours: number) => {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const next = { ...filters, since, before: undefined, limit: PAGE_SIZE };
    setFilters(next);
    setAppliedFilters(next);
  };

  // The audit table keys actors by *user* ID, which isn't searchable by
  // name from the web app (the directory only exposes associate IDs). The
  // picker instead fills the associate's email into the Entity ID filter —
  // auth/onboarding rows are keyed by email there, so it still finds their
  // trail without pasting UUIDs.
  const onPickHelperAssociate = (v: PickedAssociate | null) => {
    setHelperAssociate(v);
    if (!v) return;
    listDirectory({ q: v.name })
      .then((r) => {
        const email = r.associates.find((a) => a.id === v.id)?.email;
        setFilters((f) => ({ ...f, entityId: email ?? v.id }));
      })
      .catch(() => {
        // Directory lookup failed — the associate id is still a valid
        // entity-ID for Associate-typed rows.
        setFilters((f) => ({ ...f, entityId: v.id }));
      });
  };

  const csvHref = useMemo(() => auditCsvUrl(appliedFilters), [appliedFilters]);

  return (
    <div className="mx-auto">
      <PageHeader
        title="Audit log"
        subtitle="Every authentication, onboarding, payroll, scheduling, and document event in one searchable feed. Used for SOC 2, compliance reviews, and incident forensics."
        primaryAction={
          <Button asChild variant="secondary">
            <a href={csvHref} download>
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          </Button>
        }
      />

      <Card className="mb-4">
        <CardHeader>
          {/* h2, not CardTitle's h3: this heading sits directly under the
              page h1, and an h1 → h3 jump trips axe's heading-order rule.
              Classes match CardTitle + the old overrides exactly. */}
          <h2 className="font-display text-white leading-tight flex items-center gap-2 text-base">
            <Filter className="h-4 w-4 text-silver/80" />
            Filters
          </h2>
        </CardHeader>
        <CardContent>
          <form onSubmit={apply} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Field label="Action contains">
                {(p) => (
                  <Input
                    value={filters.q ?? ''}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, q: e.target.value || undefined }))
                    }
                    placeholder="e.g. payroll, login_failed"
                    {...p}
                  />
                )}
              </Field>
              <Field label="Entity type">
                {(p) => (
                  <div className="space-y-2">
                    <Select
                      value={
                        entityOther ? ENTITY_OTHER : (filters.entityType ?? '')
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === ENTITY_OTHER) {
                          setEntityOther(true);
                          setFilters((f) => ({ ...f, entityType: undefined }));
                        } else {
                          setEntityOther(false);
                          setFilters((f) => ({
                            ...f,
                            entityType: v || undefined,
                          }));
                        }
                      }}
                      {...p}
                    >
                      <option value="">Any entity type</option>
                      {KNOWN_ENTITY_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      <option value={ENTITY_OTHER}>Other…</option>
                    </Select>
                    {entityOther && (
                      <Input
                        value={filters.entityType ?? ''}
                        onChange={(e) =>
                          setFilters((f) => ({
                            ...f,
                            entityType: e.target.value || undefined,
                          }))
                        }
                        placeholder="Exact entity type, e.g. KioskDevice"
                        aria-label="Entity type (free text)"
                      />
                    )}
                  </div>
                )}
              </Field>
              <Field label="Entity ID">
                {(p) => (
                  <Input
                    value={filters.entityId ?? ''}
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        entityId: e.target.value || undefined,
                      }))
                    }
                    placeholder="UUID or email"
                    {...p}
                  />
                )}
              </Field>
              <Field label="Actor user ID">
                {(p) => (
                  <Input
                    value={filters.actorUserId ?? ''}
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        actorUserId: e.target.value || undefined,
                      }))
                    }
                    placeholder="UUID"
                    {...p}
                  />
                )}
              </Field>
              <Field
                label="Find associate"
                hint="Audit rows key actors by user ID (not searchable by name), so picking someone here fills their email into Entity ID — the key auth and onboarding events are logged under."
              >
                {() => (
                  <AssociatePicker
                    value={helperAssociate}
                    onChange={onPickHelperAssociate}
                    placeholder="Search by name…"
                  />
                )}
              </Field>
              <Field label="Since">
                {(p) => (
                  <div className="space-y-2">
                    <Input
                      type="datetime-local"
                      value={isoToLocal(filters.since)}
                      onChange={(e) =>
                        setFilters((f) => ({
                          ...f,
                          since: localToIso(e.target.value),
                        }))
                      }
                      {...p}
                    />
                    <div className="flex gap-1.5">
                      {[
                        { label: 'Last 24h', hours: 24 },
                        { label: '7 days', hours: 7 * 24 },
                        { label: '30 days', hours: 30 * 24 },
                      ].map((preset) => (
                        <Button
                          key={preset.hours}
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => applyPreset(preset.hours)}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </Field>
              <Field label="Before">
                {(p) => (
                  <Input
                    type="datetime-local"
                    value={isoToLocal(filters.before)}
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        before: localToIso(e.target.value),
                      }))
                    }
                    {...p}
                  />
                )}
              </Field>
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

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

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
            <EmptyState
              icon={FileSearch}
              title="No audit rows match these filters"
              description="Loosen the date range, clear the entity-type filter, or reset the search to see recent activity."
              action={
                <Button variant="ghost" onClick={reset}>
                  <RefreshCw className="h-4 w-4" />
                  Reset filters
                </Button>
              }
            />
          )}
          {entries && entries.length > 0 && (
            <div className="divide-y divide-navy-secondary">
              {groupByDay(entries).map((group, idx) => (
                <details
                  key={group.key}
                  open={idx === 0}
                  className="[&[open]>summary>svg.chev]:rotate-90"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm hover:bg-navy-secondary/40">
                    <ChevronRight className="chev h-4 w-4 text-silver transition-transform" />
                    <span className="font-medium text-white">
                      {dayHeading(group.key)}
                    </span>
                    <span className="text-xs text-silver/70">
                      · {group.key}
                    </span>
                    <span className="ml-auto text-xs text-silver">
                      {group.entries.length} event
                      {group.entries.length === 1 ? '' : 's'}
                    </span>
                  </summary>
                  <Table caption="Audit log">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap w-24">
                          Time
                        </TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead className="hidden md:table-cell">Actor</TableHead>
                        <TableHead>Entity</TableHead>
                        <TableHead className="hidden lg:table-cell">Metadata</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.entries.map((e) => (
                        <TableRow
                          key={e.id}
                          className="cursor-pointer"
                          onClick={() => setDetail(e)}
                        >
                          <TableCell
                            className="text-silver text-xs whitespace-nowrap tabular-nums"
                            title={fmtDateTime(e.createdAt)}
                          >
                            {fmtTimeOnly(e.createdAt)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className="font-mono text-xs2"
                            >
                              {e.action}
                            </Badge>
                            <div className="text-xs2 text-silver/70 md:hidden truncate max-w-[20ch]">
                              {e.actorEmail ?? 'system'}
                            </div>
                          </TableCell>
                          <TableCell className="text-silver text-xs truncate max-w-[16ch] hidden md:table-cell">
                            {e.actorEmail ?? (
                              <span className="text-silver/70">system</span>
                            )}
                          </TableCell>
                          <TableCell className="text-silver text-xs">
                            <div className="text-white">{e.entityType}</div>
                            <div className="font-mono text-2xs text-silver/70 truncate max-w-[20ch]">
                              {e.entityId}
                            </div>
                          </TableCell>
                          <TableCell className="text-silver text-xs font-mono truncate max-w-[44ch] hidden lg:table-cell">
                            {metaPreview(e.metadata)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </details>
              ))}
            </div>
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
        <p className="text-xs text-silver/70 mt-4 text-center">
          End of results — {entries.length} row{entries.length === 1 ? '' : 's'}.
        </p>
      )}

      <Drawer
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        width="max-w-lg"
      >
        {detail && (
          <>
            <DrawerHeader>
              <DrawerTitle className="font-mono text-base">
                {detail.action}
              </DrawerTitle>
            </DrawerHeader>
            <DrawerBody className="space-y-4 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="text-silver">When</dt>
                <dd className="text-white">{fmtDateTime(detail.createdAt)}</dd>
                <dt className="text-silver">Actor</dt>
                <dd className="text-white break-all">
                  {detail.actorEmail ?? (
                    <span className="text-silver/70">system</span>
                  )}
                  {detail.actorUserId && (
                    <div className="font-mono text-2xs text-silver/70">
                      {detail.actorUserId}
                    </div>
                  )}
                </dd>
                <dt className="text-silver">Entity</dt>
                <dd className="text-white break-all">
                  {detail.entityType}
                  <div className="font-mono text-2xs text-silver/70">
                    {detail.entityId}
                  </div>
                </dd>
                {detail.clientId && (
                  <>
                    <dt className="text-silver">Client ID</dt>
                    <dd className="font-mono text-xs text-white break-all">
                      {detail.clientId}
                    </dd>
                  </>
                )}
              </dl>
              <div>
                <div className="text-xs uppercase tracking-widest text-silver mb-1.5">
                  Metadata
                </div>
                {detail.metadata ? (
                  <pre className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 font-mono text-xs text-white overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(detail.metadata, null, 2)}
                  </pre>
                ) : (
                  <div className="text-silver/70 italic">
                    No metadata recorded for this event.
                  </div>
                )}
              </div>
            </DrawerBody>
          </>
        )}
      </Drawer>
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
