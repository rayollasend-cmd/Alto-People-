import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Users, Activity, ArrowDown, ArrowUp, Download } from 'lucide-react';
import {
  getHeadcountSnapshot,
  getTurnover,
  type HeadcountSnapshot,
  type TurnoverSummary,
} from '@/lib/headcount110Api';
import { listOrgAssociates } from '@/lib/orgApi';
import type { AssociateOrgSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { ymdLocal } from '@/lib/format';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import {
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  PageHeader,
  SearchInput,
  SegmentedControl,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

// By-employment-type drills route to the People directory (which
// filters server-side via ?employmentType=) because the org-associates
// payload used by the drawer has no employment type to filter on.
interface Drill {
  departmentId: string | null;
  label: string;
}

/**
 * Phase 110 — Headcount & turnover dashboard.
 *
 * KPI cards on top (total, hires, terminations, turnover %), then
 * three breakdown panels: by department, by client, by employment
 * type. By-client rows link straight to /clients/:id; by-employment-type
 * rows deep-link into the pre-filtered People directory; by-department
 * opens a drawer that lists matching associates.
 */
export function HeadcountHome() {
  const [snap, setSnap] = useState<HeadcountSnapshot | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [turn, setTurn] = useState<TurnoverSummary | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [days, setDays] = useState<30 | 90 | 365>(90);
  const [turnRetry, setTurnRetry] = useState(0);
  const [drill, setDrill] = useState<Drill | null>(null);

  const loadSnap = () => {
    setSnap(null);
    setSnapError(null);
    getHeadcountSnapshot()
      .then(setSnap)
      .catch((err) =>
        setSnapError(
          err instanceof ApiError ? err.message : 'Could not load headcount.',
        ),
      );
  };
  useEffect(loadSnap, []);

  useEffect(() => {
    setTurn(null);
    setTurnError(null);
    getTurnover(days)
      .then(setTurn)
      .catch((err) =>
        setTurnError(
          err instanceof ApiError ? err.message : 'Could not load turnover.',
        ),
      );
  }, [days, turnRetry]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Headcount & turnover"
        subtitle="Active associates, hires and separations across the company."
        breadcrumbs={[{ label: 'Headcount' }]}
      />

      {snapError && (
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{snapError}</span>
            <Button variant="outline" size="sm" onClick={loadSnap}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}
      {turnError && (
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{turnError}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTurnRetry((n) => n + 1)}
            >
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Active headcount"
          value={snap?.total ?? null}
          icon={Users}
          accent="text-gold"
        />
        <KpiCard
          label="Hires"
          sub={`Last ${days} days`}
          value={turn?.hires ?? null}
          icon={ArrowUp}
          accent="text-success"
        />
        <KpiCard
          label="Separations"
          sub={`Last ${days} days`}
          value={turn?.terminations ?? null}
          icon={ArrowDown}
          accent="text-alert"
        />
        <KpiCard
          label="Annualized turnover"
          sub={`Last ${days} days`}
          value={turn ? `${turn.annualizedTurnoverRate}%` : null}
          icon={turn && turn.annualizedTurnoverRate >= 25 ? TrendingUp : TrendingDown}
          accent={turn && turn.annualizedTurnoverRate >= 25 ? 'text-alert' : 'text-success'}
        />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-silver">Window:</span>
        <SegmentedControl
          ariaLabel="Turnover window"
          options={([30, 90, 365] as const).map((d) => ({ value: d, label: `${d}d` }))}
          value={days}
          onChange={(d) => setDays(d)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownCard
          title="By department"
          loading={!snap && !snapError}
          csvName={`headcount-by-department-${ymdLocal()}.csv`}
          rows={snap?.byDepartment.map((r) => ({
            label: r.departmentName,
            count: r.count,
            onClick: () =>
              setDrill({
                departmentId: r.departmentId,
                label: r.departmentName,
              }),
          })) ?? null}
        />
        <BreakdownCard
          title="By client"
          loading={!snap && !snapError}
          csvName={`headcount-by-client-${ymdLocal()}.csv`}
          rows={snap?.byClient.map((r) => ({
            label: r.clientName,
            count: r.count,
            href: `/clients/${r.clientId}`,
          })) ?? null}
        />
        <BreakdownCard
          title="By employment type"
          loading={!snap && !snapError}
          csvName={`headcount-by-employment-type-${ymdLocal()}.csv`}
          rows={snap?.byEmploymentType.map((r) => ({
            label: EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType,
            count: r.count,
            href: `/people?employmentType=${encodeURIComponent(r.employmentType)}`,
          })) ?? null}
        />
      </div>

      {drill && (
        <DrillDrawer drill={drill} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number | null;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">{label}</div>
          <Icon className={`h-4 w-4 ${accent}`} />
        </div>
        <div className={`text-3xl font-display mt-2 tabular-nums ${accent}`}>
          {value === null ? '—' : value}
        </div>
        {sub && <div className="text-xs text-silver mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

interface BreakdownRow {
  label: string;
  count: number;
  href?: string;
  onClick?: () => void;
}

const BREAKDOWN_VISIBLE_ROWS = 12;

function BreakdownCard({
  title,
  rows,
  loading,
  csvName,
}: {
  title: string;
  rows: BreakdownRow[] | null;
  loading: boolean;
  csvName: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible =
    rows === null ? null : showAll ? rows : rows.slice(0, BREAKDOWN_VISIBLE_ROWS);
  return (
    <Card>
      <CardContent>
        <div className="text-sm uppercase tracking-wider text-silver mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <span className="flex-1">{title}</span>
          {rows && rows.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                downloadCsv(csvName, [
                  ['Segment', 'Count'],
                  ...rows.map((r) => [r.label, r.count]),
                ])
              }
              title="Export this breakdown as CSV"
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          )}
        </div>
        {rows === null ? (
          loading ? (
            <SkeletonRows count={3} />
          ) : (
            <div className="text-sm text-silver">Not loaded.</div>
          )
        ) : rows.length === 0 ? (
          <div className="text-sm text-silver">No data.</div>
        ) : (
          <div className="space-y-2">
            {visible!.map((r) => {
              const max = Math.max(1, ...rows.map((x) => x.count));
              const interactive = r.href || r.onClick;
              const inner = (
                <div
                  className={`flex items-center gap-3 text-sm rounded px-1 py-0.5 ${
                    interactive
                      ? 'cursor-pointer hover:bg-navy-secondary/30 transition'
                      : ''
                  }`}
                >
                  <div className="w-44 truncate text-silver">{r.label}</div>
                  <div className="flex-1 h-3 rounded bg-navy-secondary/40 overflow-hidden">
                    <div
                      className="h-full bg-gold"
                      style={{ width: `${(r.count / max) * 100}%` }}
                    />
                  </div>
                  <div className="w-10 text-right tabular-nums text-white">{r.count}</div>
                </div>
              );
              if (r.href) {
                return (
                  <Link key={r.label} to={r.href}>
                    {inner}
                  </Link>
                );
              }
              if (r.onClick) {
                return (
                  <button
                    key={r.label}
                    onClick={r.onClick}
                    className="block w-full text-left"
                  >
                    {inner}
                  </button>
                );
              }
              return <div key={r.label}>{inner}</div>;
            })}
            {rows.length > BREAKDOWN_VISIBLE_ROWS && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll((s) => !s)}
              >
                {showAll ? 'Show fewer' : `Show all ${rows.length}`}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DrillDrawer({
  drill,
  onClose,
}: {
  drill: Drill;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<AssociateOrgSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setRows(null);
    setError(null);
    listOrgAssociates()
      .then((r) => {
        setRows(
          r.associates.filter((a) => a.departmentId === drill.departmentId),
        );
      })
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load associates.',
        ),
      );
  }, [drill, retry]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (a) =>
        `${a.firstName} ${a.lastName}`.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const exportCsv = () => {
    if (!filtered || filtered.length === 0) return;
    downloadCsv(
      `headcount-${drill.label.replace(/[^a-z0-9]+/gi, '-')}-${ymdLocal()}.csv`.toLowerCase(),
      [
        ['Name', 'Email', 'Job profile', 'Manager'],
        ...filtered.map((a) => [
          `${a.firstName} ${a.lastName}`,
          a.email,
          a.jobProfileTitle ?? '',
          a.managerName ?? '',
        ]),
      ],
    );
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{drill.label}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex-1 min-w-[200px] max-w-sm">
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email"
              className="h-8 text-sm"
              aria-label="Search associates in this segment"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={!filtered || filtered.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
        {error && (
          <ErrorBanner>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry
              </Button>
            </div>
          </ErrorBanner>
        )}
        {!error && rows === null && <SkeletonRows count={4} />}
        {!error && filtered && filtered.length === 0 && (
          <div className="text-sm text-silver italic">
            {search.trim()
              ? 'No associates match the search.'
              : 'No associates in this segment.'}
          </div>
        )}
        {!error && filtered && filtered.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead>Job profile</TableHead>
                <TableHead className="hidden md:table-cell">Manager</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium text-white">
                    <div className="min-w-0">
                      <Link
                        to={`/people?associateId=${a.id}`}
                        className="truncate block hover:text-gold"
                      >
                        {a.firstName} {a.lastName}
                      </Link>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {a.email}{a.managerName ? ` · ${a.managerName}` : ''}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-silver">{a.email}</TableCell>
                  <TableCell className="text-sm">
                    {a.jobProfileTitle ?? <span className="text-silver">—</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm">
                    {a.managerName ?? <span className="text-silver">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="text-xs text-silver mt-3 tabular-nums">
          {rows && filtered
            ? search.trim()
              ? `${filtered.length} of ${rows.length} associates`
              : `${rows.length} associates`
            : ''}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
