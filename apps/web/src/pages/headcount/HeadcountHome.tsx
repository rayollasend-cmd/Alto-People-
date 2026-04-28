import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Users, Activity, ArrowDown, ArrowUp } from 'lucide-react';
import {
  getHeadcountSnapshot,
  getTurnover,
  type HeadcountSnapshot,
  type TurnoverSummary,
} from '@/lib/headcount110Api';
import { listOrgAssociates } from '@/lib/orgApi';
import type { AssociateOrgSummary } from '@alto-people/shared';
import {
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

type Drill =
  | { kind: 'department'; departmentId: string | null; label: string }
  | { kind: 'employmentType'; employmentType: string; label: string };

/**
 * Phase 110 — Headcount & turnover dashboard.
 *
 * KPI cards on top (total, hires, terminations, turnover %), then
 * three breakdown panels: by department, by client, by employment
 * type. By-client rows link straight to /clients/:id; by-department
 * and by-employment-type open a drawer that lists matching associates.
 */
export function HeadcountHome() {
  const [snap, setSnap] = useState<HeadcountSnapshot | null>(null);
  const [turn, setTurn] = useState<TurnoverSummary | null>(null);
  const [days, setDays] = useState<30 | 90 | 365>(90);
  const [drill, setDrill] = useState<Drill | null>(null);

  useEffect(() => {
    getHeadcountSnapshot().then(setSnap).catch(() => setSnap(null));
  }, []);
  useEffect(() => {
    setTurn(null);
    getTurnover(days).then(setTurn).catch(() => setTurn(null));
  }, [days]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Headcount & turnover"
        subtitle="Active associates, hires and separations across the company."
        breadcrumbs={[{ label: 'Headcount' }]}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Active headcount"
          value={snap?.total ?? null}
          icon={Users}
          accent="text-cyan-400"
        />
        <KpiCard
          label="Hires"
          sub={`Last ${days} days`}
          value={turn?.hires ?? null}
          icon={ArrowUp}
          accent="text-emerald-400"
        />
        <KpiCard
          label="Separations"
          sub={`Last ${days} days`}
          value={turn?.terminations ?? null}
          icon={ArrowDown}
          accent="text-rose-400"
        />
        <KpiCard
          label="Annualized turnover"
          sub={`Last ${days} days`}
          value={turn ? `${turn.annualizedTurnoverRate}%` : null}
          icon={turn && turn.annualizedTurnoverRate >= 25 ? TrendingUp : TrendingDown}
          accent={turn && turn.annualizedTurnoverRate >= 25 ? 'text-rose-400' : 'text-emerald-400'}
        />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-silver">Window:</span>
        {[30, 90, 365].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d as 30 | 90 | 365)}
            className={`px-3 py-1 rounded-full border transition ${
              days === d
                ? 'bg-cyan-600 border-cyan-500 text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownCard
          title="By department"
          rows={snap?.byDepartment.map((r) => ({
            label: r.departmentName,
            count: r.count,
            onClick: () =>
              setDrill({
                kind: 'department',
                departmentId: r.departmentId,
                label: r.departmentName,
              }),
          })) ?? null}
        />
        <BreakdownCard
          title="By client"
          rows={snap?.byClient.map((r) => ({
            label: r.clientName,
            count: r.count,
            href: `/clients/${r.clientId}`,
          })) ?? null}
        />
        <BreakdownCard
          title="By employment type"
          rows={snap?.byEmploymentType.map((r) => ({
            label: r.employmentType,
            count: r.count,
            onClick: () =>
              setDrill({
                kind: 'employmentType',
                employmentType: r.employmentType,
                label: r.employmentType,
              }),
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
          <div className="text-xs uppercase tracking-wider text-silver">{label}</div>
          <Icon className={`h-4 w-4 ${accent}`} />
        </div>
        <div className={`text-3xl font-display mt-2 ${accent}`}>
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

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: BreakdownRow[] | null;
}) {
  return (
    <Card>
      <CardContent>
        <div className="text-sm uppercase tracking-wider text-silver mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4" />
          {title}
        </div>
        {rows === null ? (
          <SkeletonRows count={3} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-silver">No data.</div>
        ) : (
          <div className="space-y-2">
            {rows.slice(0, 12).map((r) => {
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
                      className="h-full bg-cyan-500"
                      style={{ width: `${(r.count / max) * 100}%` }}
                    />
                  </div>
                  <div className="w-10 text-right text-white">{r.count}</div>
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
            {rows.length > 12 && (
              <div className="text-xs text-silver pt-1">
                +{rows.length - 12} more
              </div>
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

  useEffect(() => {
    listOrgAssociates()
      .then((r) => {
        if (drill.kind === 'department') {
          setRows(
            r.associates.filter((a) => a.departmentId === drill.departmentId),
          );
        } else {
          // Employment type isn't in AssociateOrgSummary today, so we can't
          // filter further client-side. Fall back to "all" with a warning.
          setRows(r.associates);
        }
      })
      .catch(() => setRows([]));
  }, [drill]);

  const subtitle =
    drill.kind === 'department'
      ? `Associates in ${drill.label}`
      : `${drill.label} (showing all associates — employment-type filter not available client-side)`;

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{drill.label}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className="text-xs text-silver mb-3">{subtitle}</div>
        {rows === null ? (
          <SkeletonRows count={4} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-silver italic">
            No associates in this segment.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Job profile</TableHead>
                <TableHead>Manager</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium text-white">
                    {a.firstName} {a.lastName}
                  </TableCell>
                  <TableCell className="text-xs text-silver">{a.email}</TableCell>
                  <TableCell className="text-sm">
                    {a.jobProfileTitle ?? <span className="text-silver">—</span>}
                  </TableCell>
                  <TableCell className="text-sm">
                    {a.managerName ?? <span className="text-silver">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="text-xs text-silver mt-3">
          {rows ? `${rows.length} associates` : ''}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
