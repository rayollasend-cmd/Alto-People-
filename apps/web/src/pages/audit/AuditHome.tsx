import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, Download, FileSearch, RefreshCw, SlidersHorizontal } from '@/components/ui/icons';
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_DEFS,
  auditActionLabel,
  auditEntityTypeLabel,
  type AuditCategory,
  type AuditSearchEntry,
} from '@alto-people/shared';
import { AUDIT_ARCHIVE_URL, auditCsvUrl, searchAuditLogs, type AuditFilters } from '@/lib/auditApi';
import { useAuth } from '@/lib/auth';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { urlBoolean, urlDay, useUrlParam, useUrlState, useUrlWriter } from '@/lib/useUrlState';
import { fmtCount, fmtDateOnly, fmtDateTime, ymdToIsoEndExclusive, ymdToIsoStart } from '@/lib/format';
import { dayHeading, dayKey, fmtTimeOnly, isRelativeDayHeading } from '@/lib/dayGroup';
import { SavedViewsMenu } from '@/components/SavedViewsMenu';
import { Button } from '@/components/ui/Button';
import { DataGrid } from '@/components/ui/DataGrid';
import { Drawer, DrawerBody, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { DateRangeField } from '@/components/ui/DateField';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { ActorPicker } from './ActorPicker';

// Brief 2-3 step 4: the chain's status line and the trail's settings, in their own chunk.
const AuditIntegrityLine = lazy(() => import('./AuditIntegrity').then((m) => ({ default: m.AuditIntegrityLine })));
const AuditSettings = lazy(() => import('./AuditIntegrity').then((m) => ({ default: m.AuditSettings })));

const PAGE_SIZE = 100;

/** The windows a review starts from. An unbounded first query on years of rows is slow and nobody reads it. */
const RANGES = ['24h', '7d', '30d', '90d', '1y'] as const;
type Range = (typeof RANGES)[number];
const RANGE_HOURS: Record<Range, number> = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24, '90d': 90 * 24, '1y': 365 * 24 };
const RANGE_LABELS: Record<Range, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '1y': 'Last 12 months' };

/** Record types the app writes audit rows for, as a reviewer says them. */
const KNOWN_ENTITY_TYPES = ['User', 'Associate', 'Application', 'PayrollRun', 'Agreement', 'DocumentRecord', 'TimeEntry', 'Shift', 'Client', 'Location', 'OrgUnit', 'Tenant'] as const;

/** Every filter the page keeps in its URL — counted, cleared and saved as one. */
const FILTER_KEYS = ['q', 'actor', 'cat', 'range', 'from', 'to', 'system', 'type', 'id', 'action'] as const;

function metaPreview(m: Record<string, unknown> | null): string {
  if (!m) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === 'ip' || k === 'userAgent') continue;
    parts.push(`${k}=${typeof v === 'string' ? v : v === null ? 'null' : JSON.stringify(v)}`);
    if (parts.join(' · ').length > 140) break;
  }
  const joined = parts.join(' · ');
  return joined.length > 160 ? `${joined.slice(0, 157)}…` : joined;
}

const shortId = (id: string) => (id.length > 13 ? `${id.slice(0, 8)}…` : id);
/** A row about the actor's own account (a sign-in, a password change). */
const isOwnAccount = (e: AuditSearchEntry) => e.entityType === 'User' && !!e.actorUserId && e.entityId === e.actorUserId;
/** What a row's record is called: its name, or its kind and a short id; a sign-in's account is the actor's own. */
const recordName = (e: AuditSearchEntry) =>
  isOwnAccount(e) ? 'Own account' : (e.entityLabel ?? `${auditEntityTypeLabel(e.entityType)} ${shortId(e.entityId)}`);
const actorOf = (e: AuditSearchEntry) => e.actorName ?? e.actorEmail ?? null;

/**
 * The audit log (Phase 40; F500 G4): status first — one line on the hash
 * chain — then the log, filtered the way a reviewer asks ("what did Maria
 * do last week", "every export this month"), with the settings at the
 * foot. Every filter lives in the URL, so an investigation can be linked,
 * reloaded and saved as a view.
 */
export function AuditHome() {
  const { can } = useAuth();
  const location = useLocation();
  const write = useUrlWriter();
  const [q, setQ] = useUrlParam<string>('q', '');
  const [actor, setActor] = useUrlParam<string>('actor', '');
  const [cat, setCat] = useUrlParam<AuditCategory | ''>('cat', '', ['', ...AUDIT_CATEGORIES]);
  const [range] = useUrlParam<Range>('range', '7d', RANGES);
  const [from, setFrom] = useUrlState('from', '', urlDay);
  const [to, setTo] = useUrlState('to', '', urlDay);
  const [showSystem, setShowSystem] = useUrlState('system', false, urlBoolean);
  const [entityType, setEntityType] = useUrlParam<string>('type', '');
  const [entityId, setEntityId] = useUrlParam<string>('id', '');
  const [action, setAction] = useUrlParam<string>('action', '');
  const [moreOpen, setMoreOpen] = useState(() => !!(entityType || entityId || action || from || to));
  const [detail, setDetail] = useState<AuditSearchEntry | null>(null);

  // The search box types freely; the URL (and the query) follow a beat later.
  const [typed, setTyped] = useState<string>(q);
  const debounced = useDebouncedValue(typed.trim(), 300);
  useEffect(() => setTyped(q), [q]);
  useEffect(() => {
    if (debounced !== q) setQ(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // The window: explicit days win over the preset. `since` is fixed when the
  // preset changes, so the query key (and the cache) holds still meanwhile.
  const since = useMemo(
    () => (from ? ymdToIsoStart(from) : new Date(Date.now() - RANGE_HOURS[range] * 3_600_000).toISOString()),
    [from, range],
  );
  const applied = useMemo<AuditFilters>(
    () => ({
      limit: PAGE_SIZE,
      since,
      before: to ? ymdToIsoEndExclusive(to) : undefined,
      q: q || undefined,
      actorUserId: actor || undefined,
      category: cat || undefined,
      hideSystem: showSystem ? undefined : '1',
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      action: action || undefined,
    }),
    [since, to, q, actor, cat, showSystem, entityType, entityId, action],
  );

  // A cursor-paged list: one cache entry per applied filter set, so Back
  // restores the scrolled-through log and "Load older" appends a page.
  const auditQuery = useInfiniteQuery({
    queryKey: ['audit', 'logs', applied],
    queryFn: ({ pageParam }) => searchAuditLogs(pageParam ? { ...applied, before: pageParam } : applied),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = useMemo(() => (auditQuery.data ? auditQuery.data.pages.flatMap((pg) => pg.entries) : []), [auditQuery.data]);

  const params = new URLSearchParams(location.search);
  const viewQuery = Object.fromEntries(FILTER_KEYS.filter((k) => params.get(k)).map((k) => [k, params.get(k)!]));
  const activeFilters = Object.keys(viewQuery).length;
  const clearFilters = () =>
    write((p) => {
      for (const k of [...FILTER_KEYS, 'sv']) p.delete(k);
    });
  const applySavedView = (id: string | null, query: Record<string, string>) =>
    write((p) => {
      for (const k of [...FILTER_KEYS, 'sv']) p.delete(k);
      for (const [k, v] of Object.entries(query)) if ((FILTER_KEYS as readonly string[]).includes(k)) p.set(k, v);
      if (id) p.set('sv', id);
    });

  const windowWords = from || to ? `${from ? fmtDateOnly(from) : 'the start'} to ${to ? fmtDateOnly(to) : 'now'}` : RANGE_LABELS[range].toLowerCase();

  const exportMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          <Download className="h-4 w-4" aria-hidden="true" />
          Export
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[15rem]">
        <DropdownMenuItem asChild>
          <a href={auditCsvUrl(applied)} download>
            <span className="flex flex-col">
              <span>This view (CSV)</span>
              <span className="text-xs text-silver">The rows these filters find, up to 50,000</span>
            </span>
          </a>
        </DropdownMenuItem>
        {can('manage:org') && (
          <DropdownMenuItem asChild>
            <a href={AUDIT_ARCHIVE_URL} download>
              <span className="flex flex-col">
                <span>Full archive (CSV)</span>
                <span className="text-xs text-silver">Every row, with the chain’s hashes</span>
              </span>
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <ListTemplate
      title="Audit log"
      subtitle="Every sign-in, change, export and payroll event, on a chain you can verify. For SOC 2, compliance reviews and investigations."
      secondaryActions={exportMenu}
      summary={
        <Suspense fallback={null}>
          <AuditIntegrityLine />
        </Suspense>
      }
      filters={
        <FilterBar
          urlKey={FILTER_KEYS as unknown as string[]}
          onClearFilters={clearFilters}
          search={<SearchInput value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search events, people, IDs…" aria-label="Search the audit log" className="h-8 text-xs" wrapperClassName="min-w-0 w-full" />}
          actions={<SavedViewsMenu scope="audit.log" current={viewQuery} activeId={params.get('sv')} onApply={applySavedView} allLabel="Saved views" />}
          sheetDescription="Narrow the log by who, what and when."
        >
          <ActorPicker value={actor || null} onChange={(id) => setActor(id ?? '')} className="w-full sm:w-56" />
          <Select size="sm" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value as AuditCategory | '')} className="w-full sm:w-48">
            <option value="">Every category</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {AUDIT_CATEGORY_DEFS[c].label}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            aria-label="When"
            value={from || to ? 'custom' : range}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'custom') {
                setMoreOpen(true);
                return;
              }
              write((p) => {
                p.delete('from');
                p.delete('to');
                if (v === '7d') p.delete('range');
                else p.set('range', v);
              });
            }}
            className="w-full sm:w-44"
          >
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {RANGE_LABELS[r]}
              </option>
            ))}
            <option value="custom">Pick dates…</option>
          </Select>
          {/* On by default: the API's own request trail and the assistant's
              question-and-reply pairs are routine, not changes — they buried
              the sign-ins and edits a reviewer is looking for. */}
          <FilterChip active={!showSystem} aria-pressed={!showSystem} onClick={() => setShowSystem(!showSystem)} title="Hides the system’s own request trail and the assistant’s questions and replies">
            Hide routine activity
          </FilterChip>
          <FilterChip active={moreOpen} aria-expanded={moreOpen} aria-controls="audit-more-filters" onClick={() => setMoreOpen((o) => !o)}>
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            More filters
          </FilterChip>
          {moreOpen && (
            <div id="audit-more-filters" className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2">
              <DateRangeField
                size="sm"
                from={from}
                to={to}
                fromLabel="From"
                toLabel="To"
                onChange={(r) => {
                  if (r.from !== from) setFrom(r.from);
                  if (r.to !== to) setTo(r.to);
                }}
              />
              <Select size="sm" aria-label="Record type" value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-full sm:w-44">
                <option value="">Any record type</option>
                {KNOWN_ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {auditEntityTypeLabel(t)}
                  </option>
                ))}
              </Select>
              <Input aria-label="Record ID" placeholder="Record ID or email" className="h-8 w-full text-xs sm:w-56" value={entityId} onChange={(e) => setEntityId(e.target.value.trim())} />
              <Input aria-label="Exact event key" placeholder="Event key, e.g. auth.login" className="h-8 w-full font-mono text-xs sm:w-56" value={action} onChange={(e) => setAction(e.target.value.trim())} />
            </div>
          )}
        </FilterBar>
      }
      drawer={
        <Drawer open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} width="max-w-lg">
          {detail && <AuditDetail entry={detail} />}
        </Drawer>
      }
    >
      {auditQuery.isError ? (
        <QueryError what="the audit log" query={auditQuery} />
      ) : (
        <DataGrid<AuditSearchEntry>
          id="audit-log"
          caption="Audit log"
          noun={{ one: 'event', many: 'events' }}
          rows={auditQuery.data ? entries : null}
          loading={auditQuery.isPending}
          rowKey={(e) => e.id}
          search={false}
          urlState={false}
          exportCsv={false}
          activeFilters={activeFilters}
          onClearFilters={clearFilters}
          empty={{ icon: FileSearch, title: 'No events in this window', description: `Nothing was recorded in the ${windowWords}. Pick a longer window to look further back.` }}
          onRowClick={(e) => setDetail(e)}
          rowActionLabel={(e) => `Open ${auditActionLabel(e.action)} on ${recordName(e)}`}
          groupBy={{
            key: (e) => dayKey(e.createdAt),
            header: (key, rows) => (
              <span className="flex items-center gap-2">
                <span>{dayHeading(key)}</span>
                {isRelativeDayHeading(dayHeading(key)) && <span className="text-xs font-normal text-silver/70">· {fmtDateOnly(key)}</span>}
                <span className="ml-auto text-xs font-normal text-silver">{fmtCount(rows.length, 'event')}</span>
              </span>
            ),
          }}
          columns={[
            {
              key: 'time',
              header: 'Time',
              accessor: (e) => e.createdAt,
              csv: (e) => e.createdAt,
              sortable: true,
              searchable: false,
              width: '7.5rem',
              className: 'text-silver text-xs whitespace-nowrap tabular-nums',
              cell: (e) => <span title={fmtDateTime(e.createdAt)}>{fmtTimeOnly(e.createdAt, { seconds: true })}</span>,
            },
            {
              key: 'action',
              header: 'Event',
              accessor: (e) => auditActionLabel(e.action),
              csv: (e) => e.action,
              sortable: true,
              primary: true,
              width: '28%',
              cell: (e) => (
                <span className="text-ink" title={e.action}>
                  {auditActionLabel(e.action)}
                </span>
              ),
            },
            {
              key: 'actor',
              header: 'Who',
              accessor: (e) => actorOf(e) ?? 'System',
              csv: (e) => e.actorEmail ?? '',
              sortable: true,
              cardMeta: true,
              width: '22%',
              className: 'text-xs',
              cell: (e) =>
                actorOf(e) ? (
                  <span className="block max-w-[22ch] truncate text-ink" title={e.actorEmail ?? undefined}>
                    {actorOf(e)}
                  </span>
                ) : (
                  <span className="text-silver/70">System</span>
                ),
            },
            {
              key: 'entity',
              header: 'Record',
              accessor: (e) => recordName(e),
              csv: (e) => `${e.entityType}:${e.entityId}`,
              sortable: true,
              cardMeta: true,
              className: 'text-xs',
              // The record takes the room the short event and actor columns
              // leave (it was the narrowest column holding the longest text).
              cell: (e) => (
                <span className="block min-w-0">
                  {e.entityHref ? (
                    <Link to={e.entityHref} onClick={(ev) => ev.stopPropagation()} className="block max-w-[64ch] truncate text-ink underline-offset-2 hover:text-accent hover:underline">
                      {recordName(e)}
                    </Link>
                  ) : (
                    <span className="block max-w-[64ch] truncate text-ink">{recordName(e)}</span>
                  )}
                  {/* "Own account" already says what it is. */}
                  {!isOwnAccount(e) && <span className="block text-2xs text-silver/70">{auditEntityTypeLabel(e.entityType)}</span>}
                </span>
              ),
            },
            {
              key: 'metadata',
              header: 'Details',
              accessor: (e) => metaPreview(e.metadata),
              defaultHidden: true,
              className: 'text-silver text-xs font-mono truncate max-w-[44ch]',
            },
          ]}
        />
      )}

      {auditQuery.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => void auditQuery.fetchNextPage()} loading={auditQuery.isFetchingNextPage}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Load older events
          </Button>
        </div>
      ) : entries.length > 0 ? (
        <p className="text-center text-xs text-silver/70">End of the {windowWords} · {fmtCount(entries.length, 'event')}.</p>
      ) : null}

      <Suspense fallback={null}>
        <AuditSettings />
      </Suspense>
    </ListTemplate>
  );
}

function AuditDetail({ entry }: { entry: AuditSearchEntry }) {
  return (
    <>
      <DrawerHeader>
        <DrawerTitle className="text-base">{auditActionLabel(entry.action)}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-silver">When</dt>
          <dd className="text-ink">{fmtDateTime(entry.createdAt)}</dd>
          <dt className="text-silver">Who</dt>
          <dd className="break-all text-ink">
            {actorOf(entry) ?? <span className="text-silver/70">System</span>}
            {entry.actorEmail && entry.actorEmail !== actorOf(entry) && <div className="text-xs text-silver">{entry.actorEmail}</div>}
          </dd>
          <dt className="text-silver">Record</dt>
          <dd className="break-all text-ink">
            {entry.entityHref ? (
              <Link to={entry.entityHref} className="underline underline-offset-2 hover:text-accent">
                {recordName(entry)}
              </Link>
            ) : (
              recordName(entry)
            )}
            {!isOwnAccount(entry) && <div className="text-xs text-silver">{auditEntityTypeLabel(entry.entityType)}</div>}
          </dd>
        </dl>
        {/* The identifiers and the raw record an auditor samples, behind one
            disclosure: the plain answer (when, who, what) reads first. */}
        <details className="rounded-md border border-line px-3 py-2">
          <summary className="cursor-pointer select-none text-sm font-medium text-ink">Technical details</summary>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-silver">Event key</dt>
            <dd className="break-all font-mono text-ink">{entry.action}</dd>
            {entry.actorUserId && (
              <>
                <dt className="text-silver">User ID</dt>
                <dd className="break-all font-mono text-ink">{entry.actorUserId}</dd>
              </>
            )}
            <dt className="text-silver">Record ID</dt>
            <dd className="break-all font-mono text-ink">{entry.entityId}</dd>
            {entry.clientId && (
              <>
                <dt className="text-silver">Client ID</dt>
                <dd className="break-all font-mono text-ink">{entry.clientId}</dd>
              </>
            )}
          </dl>
          {entry.metadata ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-raised p-3 font-mono text-xs text-ink">{JSON.stringify(entry.metadata, null, 2)}</pre>
          ) : (
            <p className="mt-2 text-xs text-silver/70">No other details were recorded for this event.</p>
          )}
        </details>
      </DrawerBody>
    </>
  );
}
