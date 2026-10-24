import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, ChevronRight, Info, Users } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import {
  downloadYearEndWorkbook,
  getPersonVariances,
  getYearEndReconciliation,
  type ChecklistItem,
  type PersonMetric,
  type ReconRow,
  type ReconSection,
} from '@/lib/yearEndApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';

/**
 * Year-end reconciliation: before W-2s and the year's last returns go out,
 * the paychecks, the four 941s, the deposits and the W-2s side by side —
 * federal, FUTA, every state, unemployment, every locality and the paid-
 * leave programs — with the variance on each row, the people behind a
 * variance one tap away, and the checklist of what would get a W-2 rejected.
 */

const SEVERITY: Record<ChecklistItem['severity'], { label: string; tone: 'destructive' | 'pending' | 'info'; Icon: typeof AlertTriangle }> = {
  BLOCKING: { label: 'Blocking', tone: 'destructive', Icon: AlertTriangle },
  WARNING: { label: 'Check', tone: 'pending', Icon: AlertTriangle },
  INFO: { label: 'Note', tone: 'info', Icon: Info },
};

/** Download the year's reconciliation workbook (the Year-end page's header action on this tab). */
export async function downloadReconWorkbook(year: number): Promise<void> {
  try {
    await downloadYearEndWorkbook(year);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Could not download the workbook.');
  }
}

/**
 * The Year-end page's Reconcile tab. (It was its own page,
 * /payroll/year-end/reconciliation — F500 G3: one home for year-end.)
 */
export function YearEndReconcile({ year }: { year: number }) {
  const [drill, setDrill] = useState<{ metric: PersonMetric; label: string } | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'year-end-recon', year], queryFn: () => getYearEndReconciliation(year) });
  const d = q.data;
  // The 941 quarters with no return on file are already a "Before you file" item; only the
  // yearly 940 (no checklist item of its own) gets this note.
  const generatedYearly = (d?.generatedQuarters ?? []).filter((g) => !g.includes('-Q'));
  const nothingPaid = !!d && d.people === 0 && d.summary.variances === 0;

  return (
    <div className="space-y-[var(--d-stack)]">
      {d && !nothingPaid ? (
        <MetricStrip label={`${year} reconciliation`}>
          <MetricCard label="People paid" value={String(d.people)} hint={`${d.w2Count} W-2${d.w2Count === 1 ? '' : 's'} · ${d.storedW2s} generated`} />
          <MetricCard label="Figures compared" value={String(d.summary.rows)} hint={`Prepared ${fmtDateTime(d.generatedAt)}`} />
          <MetricCard label="Variances" value={String(d.summary.variances)} tone={d.summary.variances > 0 ? 'warning' : 'default'} hint={d.summary.variances ? 'Over $1 apart' : 'Everything agrees to the dollar'} />
          <MetricCard label="Blocking items" value={String(d.summary.blocking)} tone={d.summary.blocking > 0 ? 'alert' : 'default'} hint={`${d.summary.warnings} to check`} />
        </MetricStrip>
      ) : q.isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : null}
      {q.isError ? (
        <EmptyState
          title="We couldn’t reconcile this year"
          description={q.error instanceof ApiError ? q.error.message : undefined}
          action={
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      ) : !d ? (
        <Skeleton className="h-96" />
      ) : nothingPaid ? (
        // Nothing was paid: not a page of $0 tables each marked "Agrees".
        <EmptyState title={`No pay in ${year}`} description="Nothing was paid this year, so there is nothing to reconcile." />
      ) : (
        <>
          {generatedYearly.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-raised p-3 text-sm text-ink-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              No Form 940 on file for {generatedYearly.join(', ')}: its figures are generated from paychecks for this view.
            </p>
          )}
          <Checklist items={d.checklist} />
          {d.sections.map((s) => (
            <SectionCard key={s.key} section={s} onDrill={(metric, label) => setDrill({ metric, label })} />
          ))}
        </>
      )}
      <PeopleDrawer year={year} drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}

function Checklist({ items }: { items: ChecklistItem[] }) {
  if (!items.length) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardContent className="flex items-center gap-2 py-4 text-sm text-success">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          Ready to file: every W-2 has an SSN and address, and no box is negative or over its limit.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Before you file</CardTitle>
        <CardDescription>What would get a W-2 rejected or a return questioned, blocking items first.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-line">
          {items.map((c) => {
            const s = SEVERITY[c.severity];
            return (
              <li key={c.code} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start">
                <Badge variant={s.tone} size="sm" withDot={false} className="shrink-0 self-start">
                  {s.label}
                </Badge>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="text-ink">{c.message}</p>
                  {c.people && c.people.length > 0 && (
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {c.people.slice(0, 6).map((p) => p.name).join(', ')}
                      {c.count > 6 && ` and ${c.count - 6} more`}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs tabular-nums text-ink-muted">{c.count}</span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : fmtMoney(v));

function SectionCard({ section, onDrill }: { section: ReconSection; onDrill: (metric: PersonMetric, label: string) => void }) {
  const off = section.rows.filter((r) => !r.ok).length;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>{section.title}</CardTitle>
          <CardDescription>{off ? `${off} figure${off === 1 ? '' : 's'} disagree by more than a dollar.` : 'Every figure agrees.'}</CardDescription>
        </div>
        {off ? (
          <Badge variant="pending" size="sm" withDot={false}>
            {off} to check
          </Badge>
        ) : (
          <Badge variant="success" size="sm" withDot={false}>
            Agrees
          </Badge>
        )}
      </CardHeader>
      {/* Desktop: the sources as columns. */}
      <CardContent className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Figure</TableHead>
              {section.sources.map((s) => (
                <TableHead key={s.key} className="text-right">
                  {s.label}
                </TableHead>
              ))}
              <TableHead className="text-right">Variance</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.rows.map((r) => (
              <TableRow key={r.key} className={cn(!r.ok && 'bg-warning/5')}>
                <TableCell className="text-ink">
                  {r.label}
                  {r.note && <span className="mt-0.5 block text-xs text-ink-muted">{r.note}</span>}
                </TableCell>
                {section.sources.map((s) => (
                  <TableCell key={s.key} className="text-right tabular-nums">
                    {money(r.values[s.key])}
                  </TableCell>
                ))}
                <TableCell className={cn('text-right tabular-nums', r.ok ? 'text-ink-muted' : 'font-medium text-warning')}>{r.ok ? '—' : fmtMoney(r.variance)}</TableCell>
                <TableCell className="text-right">
                  {r.drill && (
                    <Button size="xs" variant="ghost" onClick={() => onDrill(r.drill!, r.label)} aria-label={`People behind ${r.label}`}>
                      <Users className="h-3.5 w-3.5" aria-hidden="true" />
                      People
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {/* Phone: one block per figure. */}
      <CardContent className="space-y-3 md:hidden">
        {section.rows.map((r) => (
          <RowBlock key={r.key} row={r} sources={section.sources} onDrill={onDrill} />
        ))}
      </CardContent>
    </Card>
  );
}

function RowBlock({ row, sources, onDrill }: { row: ReconRow; sources: ReconSection['sources']; onDrill: (metric: PersonMetric, label: string) => void }) {
  return (
    <div className={cn('rounded-lg border p-3', row.ok ? 'border-line' : 'border-warning/40 bg-warning/5')}>
      <p className="text-sm font-medium text-ink">{row.label}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {sources.map((s) => (
          <div key={s.key} className="contents">
            <dt className="text-ink-muted">{s.label}</dt>
            <dd className="text-right tabular-nums text-ink">{money(row.values[s.key])}</dd>
          </div>
        ))}
        <dt className="text-ink-muted">Variance</dt>
        <dd className={cn('text-right tabular-nums', row.ok ? 'text-ink-muted' : 'font-medium text-warning')}>{row.ok ? 'Agrees' : fmtMoney(row.variance)}</dd>
      </dl>
      {row.drill && (
        <button type="button" className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm text-accent" onClick={() => onDrill(row.drill!, row.label)}>
          People behind it
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function PeopleDrawer({ year, drill, onClose }: { year: number; drill: { metric: PersonMetric; label: string } | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['payroll', 'year-end-people', year, drill?.metric], queryFn: () => getPersonVariances(year, drill!.metric), enabled: !!drill });
  const people = q.data?.people ?? [];
  const off = people.filter((p) => Math.abs(p.difference) > 1);
  return (
    <Drawer open={!!drill} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>{drill?.label ?? 'People'}</DrawerTitle>
        <DrawerDescription>Each person’s paychecks next to their W-2, largest difference first.{off.length ? ` ${off.length} disagree.` : ''}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {q.isLoading ? (
          <Skeleton className="h-64" />
        ) : q.isError ? (
          <EmptyState size="sm" title="Couldn’t load the people" />
        ) : (
          <ul className="divide-y divide-line">
            {people.map((p) => (
              <li key={p.associateId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-ink">{p.name}</span>
                  <span className="block text-xs text-ink-muted">
                    {p.checks.length} check{p.checks.length === 1 ? '' : 's'} · W-2 {p.w2Source === 'stored' ? 'on file' : p.w2Source === 'computed' ? 'not generated' : 'none'}
                  </span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="block text-ink">{fmtMoney(p.paychecks)} paid</span>
                  <span className={cn('block text-xs', Math.abs(p.difference) > 1 ? 'font-medium text-warning' : 'text-ink-muted')}>
                    {fmtMoney(p.w2)} on W-2{Math.abs(p.difference) > 1 ? ` · ${p.difference > 0 ? '+' : '−'}${fmtMoney(Math.abs(p.difference))}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DrawerBody>
    </Drawer>
  );
}
