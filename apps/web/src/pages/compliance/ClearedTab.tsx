import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CLEARED_STANDING_LABELS,
  type ClearedCell,
  type ClearedException,
  type ClearedRow,
  type ClearedShift,
  type ClearedStanding,
  type WorkWarning,
} from '@alto-people/shared';
import { ArrowLeft, ShieldCheck } from '@/components/ui/icons';
import { Avatar, Badge, Button, ErrorBanner, SkeletonRows } from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { FilterChip } from '@/components/ui/FilterBar';
import { PeopleStatusBadge, workStatusEnglish } from '@/components/ui/PeopleStatusBadge';
import { ApiError } from '@/lib/api';
import { listCleared } from '@/lib/clearedToWorkApi';
import { fmtDate, fmtDateTime, fmtDateTz, fmtShiftRangeTz, ymdLocal } from '@/lib/format';
import { personPhotoUrl } from '@/lib/photoUrl';
import type { BadgeVariant } from '@/lib/status';
import { DirectorateHeader, Kpi, KpiStrip, TableShell } from './DirectorateShell';
import { sanitizeReturnPath } from './section2Verification';
import { WORKFORCE_PARAM, WorkforceFilter, useComplianceWorkforce } from './WorkforceFilter';

/**
 * CLEARED TO WORK (owner, 2026-11-03).
 *
 * One row per person — Cleared · Needs attention · Not cleared — with the
 * I-9, E-Verify, work authorization, J-1 program, background check and drug
 * test, each done / due by a date / missing / not required (the rule is
 * apps/api/src/lib/workAuthorization.ts; scheduling refuses a shift on a
 * day someone is not cleared). Above it, the exceptions queue: what stops
 * people working and anyone still booked past it first, then what is late
 * or due soon, each linking to the tab that fixes it. Below, the
 * "Assign anyway" overrides of the last 90 days.
 *
 * Links: ?tab=cleared&status=not_cleared|attention|cleared|scheduled (the
 * Inbox sends ?workforce=current&status=scheduled), ?associateId= opens on
 * that one person on All, ?return= offers the way back.
 */

export const CLEARED_STATUSES = ['all', 'not_cleared', 'attention', 'cleared', 'scheduled'] as const;
export type ClearedStatus = (typeof CLEARED_STATUSES)[number];
const isClearedStatus = (v: unknown): v is ClearedStatus => CLEARED_STATUSES.some((s) => s === v);

type Column = 'i9' | 'everify' | 'workAuth' | 'j1' | 'background' | 'drugTest';

const STANDING_TONE: Readonly<Record<ClearedStanding, BadgeVariant>> = {
  CLEARED: 'success',
  NEEDS_ATTENTION: 'pending',
  NOT_CLEARED: 'destructive',
};

/** A cell in words, and how loud it is. Exported for the tests. */
export function cellWords(col: Column, c: ClearedCell): { text: string; tone: BadgeVariant | null } {
  const d = c.date ? fmtDate(c.date) : '';
  const screening = col === 'background' || col === 'drugTest';
  switch (c.state) {
    case 'done':
      return { text: col === 'everify' ? 'Authorized' : screening ? `Passed ${d}` : d ? `Done ${d}` : 'Done', tone: 'success' };
    case 'due':
      return { text: screening ? `Repeat by ${d}` : `Due by ${d}`, tone: 'pending' };
    case 'late':
      return { text: screening ? (d ? `Too old since ${d}` : 'Missing') : `Late, was due ${d}`, tone: 'destructive' };
    case 'missing':
      return { text: col === 'workAuth' ? 'Not on file' : col === 'i9' ? 'No I-9' : col === 'everify' ? 'No case' : 'Missing', tone: col === 'workAuth' ? 'pending' : 'destructive' };
    case 'not_required':
      return { text: 'Not required', tone: null };
    case 'ends':
      return { text: `Ends ${d}`, tone: 'default' };
    case 'ending':
      return { text: `Ends ${d}`, tone: 'pending' };
    case 'ended':
      return { text: `Ended ${d}`, tone: 'destructive' };
    case 'in_progress':
      return { text: col === 'everify' ? (d ? `Case open since ${d}` : 'Case open') : d ? `Ordered ${d}` : 'Ordered', tone: 'info' };
    case 'issue':
      return { text: col === 'everify' ? 'Mismatch to act on' : 'Needs review', tone: 'pending' };
    case 'blocked':
      return { text: 'Final nonconfirmation', tone: 'destructive' };
  }
}

function CellBadge({ col, cell }: { col: Column; cell: ClearedCell }) {
  const w = cellWords(col, cell);
  if (!w.tone) return <span className="text-xs text-silver/60">{w.text}</span>;
  return (
    <Badge variant={w.tone} size="sm">
      {w.text}
    </Badge>
  );
}

const shiftLink = (s: ClearedShift) => `/scheduling?shift=${s.id}`;
const shiftWords = (s: ClearedShift) => `${fmtDateTz(s.startsAt, s.timezone)} · ${fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)} · ${s.position}${s.place ? ` at ${s.place}` : ''}`;

const SEVERITY_LABEL: Readonly<Record<ClearedException['severity'], { text: string; tone: BadgeVariant }>> = {
  blocker: { text: 'Not cleared', tone: 'destructive' },
  scheduled: { text: 'Booked past it', tone: 'destructive' },
  warning: { text: 'Needs attention', tone: 'pending' },
  upcoming: { text: 'Due soon', tone: 'info' },
};

function matchesStatus(r: ClearedRow, s: ClearedStatus): boolean {
  if (s === 'not_cleared') return r.standing === 'NOT_CLEARED';
  if (s === 'attention') return r.standing === 'NEEDS_ATTENTION';
  if (s === 'cleared') return r.standing === 'CLEARED';
  if (s === 'scheduled') return r.scheduledAfterBlock.length > 0;
  return true;
}

export function ClearedTab() {
  // Deep-link params are read once, then removed from the URL (tab switches
  // copy the search params; lingering ones would re-arm on every visit).
  const [params, setParams] = useSearchParams();
  const [focusId, setFocusId] = useState<string | null>(() => params.get('associateId'));
  const [returnPath] = useState<string | null>(() => sanitizeReturnPath(params.get('return')));
  const [status, setStatus] = useState<ClearedStatus>(() => {
    const v = params.get('status');
    return isClearedStatus(v) ? v : 'all';
  });
  const { workforce, setWorkforce } = useComplianceWorkforce({ wide: !!focusId });
  const consumed = useRef(false);
  useEffect(() => {
    if (consumed.current) return;
    if (!['associateId', 'return', 'status', WORKFORCE_PARAM].some((k) => params.has(k))) return;
    consumed.current = true;
    const next = new URLSearchParams(params);
    for (const k of ['associateId', 'return', 'status', WORKFORCE_PARAM]) next.delete(k);
    setParams(next, { replace: true });
  }, [params, setParams]);

  // 'clearedToWork' keeps it off the disk (lib/queryPersist): it says whose work authorization ended.
  const q = useQuery({ queryKey: ['compliance', 'clearedToWork', workforce], queryFn: () => listCleared({ workforce }) });
  const data = q.data;
  const [showAllExceptions, setShowAllExceptions] = useState(false);

  const counts = useMemo(() => {
    const rows = data?.rows ?? [];
    return {
      cleared: rows.filter((r) => r.standing === 'CLEARED').length,
      attention: rows.filter((r) => r.standing === 'NEEDS_ATTENTION').length,
      notCleared: rows.filter((r) => r.standing === 'NOT_CLEARED').length,
      scheduled: rows.filter((r) => r.scheduledAfterBlock.length > 0).length,
    };
  }, [data]);
  const focus = focusId ? data?.rows.find((r) => r.associateId === focusId) ?? null : null;
  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => (focusId ? r.associateId === focusId : matchesStatus(r, status))),
    [data, focusId, status],
  );
  const exceptions = (data?.exceptions ?? []).filter((e) => !focusId || e.associateId === focusId);
  const shownExceptions = showAllExceptions ? exceptions : exceptions.slice(0, 8);
  const tile = (s: Exclude<ClearedStatus, 'all'>) => ({
    active: status === s && !focusId,
    onClick: () => {
      setFocusId(null);
      setStatus(status === s ? 'all' : s);
    },
  });
  const error = q.error ? (q.error instanceof ApiError ? q.error.message : 'Could not load who is cleared to work.') : null;

  return (
    <section>
      <DirectorateHeader
        icon={ShieldCheck}
        title="Cleared to work"
        blurb="Who may work: the right to work (I-9, E-Verify, J-1) and the checks each site requires. Scheduling refuses a shift on a day someone is not cleared."
        actions={
          returnPath ? (
            <Link to={returnPath} className="inline-flex items-center gap-1 text-xs text-gold hover:underline">
              <ArrowLeft className="h-3 w-3" />
              Back
            </Link>
          ) : undefined
        }
      />

      {data && (
        <KpiStrip>
          <Kpi label="Not cleared" value={counts.notCleared} tone={counts.notCleared ? 'text-alert' : undefined} hint="People who may not work today: work authorization or J-1 program ended, or an E-Verify final nonconfirmation." {...tile('not_cleared')} />
          <Kpi
            label="Booked past their end"
            value={counts.scheduled}
            tone={counts.scheduled ? 'text-alert' : undefined}
            hint="People with a shift ahead on or after the day their work authorization or J-1 program ends."
            {...tile('scheduled')}
          />
          <Kpi label="Needs attention" value={counts.attention} tone={counts.attention ? 'text-warning' : undefined} hint="May work, but something is late or ending soon: an I-9 or E-Verify deadline, an ending authorization, a required check." {...tile('attention')} />
          <Kpi label="Cleared" value={counts.cleared} tone="text-success" hint="Nothing stops them working and nothing is late." {...tile('cleared')} />
        </KpiStrip>
      )}

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {exceptions.length > 0 && (
        <div className="mb-4 rounded-lg border border-navy-secondary bg-navy/40 p-4" data-testid="cleared-exceptions">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Exceptions</h3>
            <p className="text-2xs text-silver/70">What stops people working first, then what is late or due soon, by date.</p>
          </div>
          <ul className="divide-y divide-navy-secondary">
            {shownExceptions.map((e, i) => (
              <ExceptionItem key={`${e.associateId}-${e.kind}-${i}`} e={e} />
            ))}
          </ul>
          {exceptions.length > 8 && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAllExceptions((v) => !v)}>
              {showAllExceptions ? 'Show fewer' : `Show all ${exceptions.length}`}
            </Button>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <WorkforceFilter value={workforce} onChange={setWorkforce} counts={data?.workforceCounts} />
        {focusId && (
          <FilterChip active onClick={() => setFocusId(null)} title="Show everyone in this group">
            {focus ? `Only ${focus.associateName}` : 'One person'} · Show everyone
          </FilterChip>
        )}
      </div>

      {!data && !error && <SkeletonRows count={6} rowHeight="h-12" />}
      {data && (
        <TableShell>
          <DataGrid<ClearedRow>
            id="compliance-cleared"
            caption="Cleared to work"
            noun={{ one: 'person', many: 'people' }}
            rows={rows}
            rowKey={(r) => r.associateId}
            search={{ placeholder: 'Name or email…' }}
            urlState={false}
            exportCsv={{ filename: `cleared-to-work-${workforce}-${ymdLocal()}` }}
            activeFilters={status === 'all' && !focusId ? 0 : 1}
            onClearFilters={() => {
              setStatus('all');
              setFocusId(null);
            }}
            empty={{
              icon: ShieldCheck,
              title: workforce === 'current' ? 'Nobody in the current workforce' : 'Nobody in this group',
              description: workforce === 'current' ? 'People appear here once they are hired. Starting soon shows who is onboarding.' : 'Pick another group above.',
            }}
            expandable={{ render: (r) => <PersonDetail row={r} />, label: (r) => `What ${r.associateName} needs` }}
            columns={[
              {
                key: 'person',
                header: 'Person',
                primary: true,
                sortable: true,
                accessor: (r) => r.associateName,
                className: 'font-medium',
                cell: (r) => (
                  <div className="flex items-center gap-2.5">
                    <Avatar src={personPhotoUrl({ photoUrl: r.associatePhotoUrl, associateId: r.associateId })} name={r.associateName} email={r.associateEmail} size="sm" />
                    <div className="truncate">{r.associateName}</div>
                  </div>
                ),
              },
              {
                key: 'employment',
                header: 'Employment',
                sortable: true,
                cardMeta: true,
                accessor: (r) => (r.workStatus ? workStatusEnglish(r.workStatus) : 'No longer on file'),
                cell: (r) => (r.workStatus ? <PeopleStatusBadge status={r.workStatus} size="sm" /> : <span className="text-xs text-silver/60">No longer on file</span>),
              },
              {
                key: 'standing',
                header: 'Cleared',
                sortable: true,
                cardMeta: true,
                accessor: (r) => CLEARED_STANDING_LABELS[r.standing],
                cell: (r) => (
                  <Badge variant={STANDING_TONE[r.standing]} withDot>
                    {CLEARED_STANDING_LABELS[r.standing]}
                  </Badge>
                ),
              },
              cellColumn('i9', 'I-9'),
              cellColumn('everify', 'E-Verify'),
              cellColumn('workAuth', 'Work authorization'),
              cellColumn('j1', 'J-1 program'),
              cellColumn('background', 'Background'),
              cellColumn('drugTest', 'Drug test'),
              {
                key: 'nextShift',
                header: 'Next shift',
                sortable: true,
                searchable: false,
                hideBelow: 1280,
                accessor: (r) => r.nextShift?.startsAt ?? null,
                csv: (r) => (r.nextShift ? shiftWords(r.nextShift) : ''),
                cell: (r) =>
                  r.nextShift ? (
                    <Link to={shiftLink(r.nextShift)} className={r.scheduledAfterBlock.length ? 'text-xs text-alert hover:underline' : 'text-xs text-silver hover:underline'}>
                      {fmtDateTz(r.nextShift.startsAt, r.nextShift.timezone)}
                      {r.scheduledAfterBlock.length > 0 && ' · past their end'}
                    </Link>
                  ) : (
                    <span className="text-xs text-silver/60">None</span>
                  ),
              },
            ]}
          />
        </TableShell>
      )}

      {data && data.overrides.length > 0 && (
        <div className="mt-4 rounded-lg border border-navy-secondary bg-navy/40 p-4" data-testid="cleared-overrides">
          <h3 className="mb-1 text-sm font-semibold text-ink">Overrides in the last 90 days</h3>
          <p className="mb-2 text-2xs text-silver/70">Shifts assigned anyway, past a work-authorization block, and the reason given.</p>
          <ul className="divide-y divide-navy-secondary">
            {data.overrides.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
                <span className="tabular-nums text-silver">{fmtDateTime(o.at)}</span>
                <span className="text-ink">{o.associateName ?? 'Someone'}</span>
                <span className="text-silver">by {o.actorName ?? 'someone'}</span>
                <span className="min-w-0 flex-1 text-silver">“{o.reason}”</span>
                {o.shiftId && (
                  <Link to={`/scheduling?shift=${o.shiftId}`} className="text-gold hover:underline">
                    Open shift
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function cellColumn(col: Column, header: string) {
  return {
    key: col,
    header,
    sortable: true,
    searchable: false,
    accessor: (r: ClearedRow) => cellWords(col, r[col]).text,
    cell: (r: ClearedRow) => <CellBadge col={col} cell={r[col]} />,
  };
}

function ExceptionItem({ e }: { e: ClearedException }) {
  const sev = SEVERITY_LABEL[e.severity];
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      <Badge variant={sev.tone} size="sm" className="mt-0.5 shrink-0">
        {sev.text}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{e.message}</p>
        {e.shift && <p className="text-2xs text-silver/70">{shiftWords(e.shift)}</p>}
      </div>
      {e.date && <span className="shrink-0 text-xs tabular-nums text-silver">{fmtDate(e.date)}</span>}
      <span className="flex shrink-0 items-center gap-3 text-xs">
        {e.shift && (
          <Link to={shiftLink(e.shift)} className="text-gold hover:underline">
            Open shift
          </Link>
        )}
        <Link to={e.fixLink} className="text-gold hover:underline">
          Fix
        </Link>
      </span>
    </li>
  );
}

function PersonDetail({ row }: { row: ClearedRow }) {
  const items: Array<{ key: string; tone: BadgeVariant; label: string; text: string; link: string; date: string | null }> = [
    ...row.blockers.map((b, i) => ({ key: `b${i}`, tone: 'destructive' as const, label: 'Not cleared', text: b.message, link: b.fixLink, date: b.endsOn })),
    ...row.warnings.map((w: WorkWarning, i) => ({ key: `w${i}`, tone: 'pending' as const, label: 'Needs attention', text: w.message, link: w.fixLink, date: w.dueBy })),
    ...row.upcoming.map((w: WorkWarning, i) => ({ key: `u${i}`, tone: 'info' as const, label: 'Due soon', text: w.message, link: w.fixLink, date: w.dueBy })),
  ];
  return (
    <div className="space-y-2 px-2 py-1">
      {items.length === 0 ? (
        <p className="text-xs text-silver">Nothing stops {row.associateName} working and nothing is due.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.key} className="flex flex-wrap items-start gap-2 text-xs">
              <Badge variant={it.tone} size="sm">
                {it.label}
              </Badge>
              <span className="min-w-0 flex-1 text-silver">{it.text}</span>
              {it.date && <span className="tabular-nums text-silver/70">{fmtDate(it.date)}</span>}
              <Link to={it.link} className="text-gold hover:underline">
                Fix
              </Link>
            </li>
          ))}
        </ul>
      )}
      {row.scheduledAfterBlock.length > 0 && (
        <div className="text-xs">
          <p className="mb-1 text-alert">Booked on a day they may not work:</p>
          <ul className="space-y-1">
            {row.scheduledAfterBlock.map((s) => (
              <li key={s.id}>
                <Link to={shiftLink(s)} className="text-gold hover:underline">
                  {shiftWords(s)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
