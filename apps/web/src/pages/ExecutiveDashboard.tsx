import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, TrendingUp } from 'lucide-react';
import type { FloorNowResponse, OtOutlookResponse } from '@alto-people/shared';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtMoney } from '@/lib/format';
import { floorNow, otOutlook } from '@/lib/schedulingApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The Executive/Chairman landing page — the numbers, not the queues.
 * One screen: workforce posture, last week's labor economics, the live
 * floor, OT exposure, attendance, and client placements, with the board
 * pack one click away. Everything read-only; deep links go to the
 * strategic surfaces the role can open.
 */

interface ExecWeek {
  start: string;
  end: string;
  workedHours: number;
  otHours: number;
  headsWorked: number;
  estBilled: number;
  estLaborCost: number;
  estMargin: number;
}
interface ExecSummary {
  generatedAt: string;
  workforce: {
    active: number;
    deactivated: number;
    hires30d: number;
    separations30d: number;
    onboardingInFlight: number;
  };
  lastWeek: ExecWeek;
  thisWeek: ExecWeek;
  attendance30d: Array<{ kind: string; count: number }>;
  clients: Array<{ clientId: string; clientName: string; activeAssociates: number }>;
}

const ATTENDANCE_LABEL: Record<string, string> = {
  LATE: 'Late arrivals',
  EARLY_OUT: 'Left early',
  CALL_OUT: 'Call-outs',
  NO_CALL_NO_SHOW: 'No-call no-shows',
};

function Tile({
  label,
  value,
  sub,
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
}) {
  const body = (
    <Card className={to ? 'transition-colors hover:border-gold/40' : undefined}>
      <CardContent className="p-4">
        <div className="text-xs text-silver">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-silver">{sub}</div>}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function ExecutiveDashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<ExecSummary | null>(null);
  const [floor, setFloor] = useState<FloorNowResponse | null>(null);
  const [ot, setOt] = useState<OtOutlookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [packBusy, setPackBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    apiFetch<ExecSummary>('/executive/summary')
      .then(setSummary)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the executive summary.'),
      );
    floorNow().then(setFloor).catch(() => setFloor(null));
    otOutlook().then(setOt).catch(() => setOt(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const downloadBoardPack = async () => {
    if (packBusy) return;
    setPackBusy(true);
    try {
      const res = await fetch('/api/executive/board-pack.pdf', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `board-pack-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not generate the board pack — try again.');
    } finally {
      setPackBusy(false);
    }
  };

  const onFloor = floor ? floor.rows.reduce((n, r) => n + r.clockedIn, 0) : null;
  const expected = floor
    ? floor.rows.reduce((n, r) => n + (r.expected ?? 0), 0)
    : null;
  const otRisk = ot ? ot.rows.filter((r) => r.projectedOtMinutes > 0) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">
            Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}
            {user ? `, ${user.email.split('@')[0]}` : ''}
          </h1>
          <p className="text-sm text-silver">
            Company posture at a glance — read-only, board-ready.
          </p>
        </div>
        <Button onClick={() => void downloadBoardPack()} loading={packBusy} disabled={packBusy}>
          <Download className="mr-2 h-4 w-4" />
          Download board pack
        </Button>
      </div>

      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {!summary && !error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px]" />
          ))}
        </div>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Active associates"
              value={String(summary.workforce.active)}
              sub={`${summary.workforce.deactivated} paused · ${summary.workforce.onboardingInFlight} onboarding`}
              to="/people"
            />
            <Tile
              label="Hires / separations (30d)"
              value={`${summary.workforce.hires30d} / ${summary.workforce.separations30d}`}
              to="/headcount"
            />
            <Tile
              label="On the floor now"
              value={onFloor === null ? '—' : String(onFloor)}
              sub={expected ? `expected ${expected}` : undefined}
              to="/labor-costs"
            />
            <Tile
              label="OT risk this week"
              value={otRisk === null ? '—' : String(otRisk.length)}
              sub={
                otRisk && otRisk.length > 0
                  ? `${(otRisk.reduce((n, r) => n + r.projectedOtMinutes, 0) / 60).toFixed(1)}h projected`
                  : 'no one projected past 40h'
              }
              to="/labor-costs"
            />
            <Tile
              label="Hours last week"
              value={`${summary.lastWeek.workedHours.toFixed(1)}h`}
              sub={`${summary.lastWeek.otHours.toFixed(1)}h OT · ${summary.lastWeek.headsWorked} associates`}
              to="/analytics"
            />
            <Tile
              label="Est. billed last week"
              value={fmtMoney(summary.lastWeek.estBilled)}
              sub="at standard SOW rates"
              to="/clients"
            />
            <Tile
              label="Est. margin last week"
              value={fmtMoney(summary.lastWeek.estMargin)}
              sub={`labor cost ${fmtMoney(summary.lastWeek.estLaborCost)}`}
              to="/labor-costs"
            />
            <Tile
              label="This week so far"
              value={`${summary.thisWeek.workedHours.toFixed(1)}h`}
              sub={`est. billed ${fmtMoney(summary.thisWeek.estBilled)}`}
              to="/labor-costs"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Client placements</CardTitle>
                  <Link to="/clients" className="text-xs text-gold hover:text-gold-bright">
                    All clients
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.clients.length === 0 ? (
                  <p className="text-sm text-silver">No open site placements on record.</p>
                ) : (
                  <ul className="divide-y divide-navy-secondary/60">
                    {summary.clients.slice(0, 6).map((c) => (
                      <li key={c.clientId} className="flex items-center justify-between py-2 text-sm">
                        <Link
                          to={`/clients/${c.clientId}`}
                          className="truncate text-white hover:text-gold"
                        >
                          {c.clientName}
                        </Link>
                        <span className="tabular-nums text-silver">
                          {c.activeAssociates} placed
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Attendance — last 30 days</CardTitle>
                  <Link to="/compliance" className="text-xs text-gold hover:text-gold-bright">
                    Compliance
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.attendance30d.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-silver">
                    <TrendingUp className="h-4 w-4" />
                    No unexcused attendance events — a clean month.
                  </p>
                ) : (
                  <ul className="divide-y divide-navy-secondary/60">
                    {summary.attendance30d.map((a) => (
                      <li key={a.kind} className="flex items-center justify-between py-2 text-sm">
                        <span className="text-white">{ATTENDANCE_LABEL[a.kind] ?? a.kind}</span>
                        <span className="tabular-nums text-silver">{a.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {otRisk && otRisk.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Overtime outlook — this week</CardTitle>
                  <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
                    Full radar
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-navy-secondary/60">
                  {otRisk.slice(0, 5).map((r) => (
                    <li
                      key={r.associateId}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate text-white">{r.associateName}</span>
                      <span className="tabular-nums text-silver">
                        {(r.projectedOtMinutes / 60).toFixed(1)}h OT projected
                        {r.estOtBilled !== null ? ` · ${fmtMoney(r.estOtBilled)} billed` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-silver/70">
            Dollar figures are estimates at org standard rates; finalized client statements
            are the invoice-grade record. Weeks run Saturday to Friday, Florida time.
          </p>
        </>
      )}
    </div>
  );
}
