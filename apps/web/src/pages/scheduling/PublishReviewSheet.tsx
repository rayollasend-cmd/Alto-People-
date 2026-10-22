import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, ChevronRight, Send, ShieldAlert } from 'lucide-react';
import type { PublishLaborFinding, PublishPreflightResponse } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { Textarea } from '@/components/ui/Input';
import { fmtMoneyCompact, fmtShiftTz } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * The publish confirm as a review sheet (role walk, ops 10). The text
 * confirm listed the week's problems as bullets; fixing one meant Cancel,
 * then hunt for the row. Here every issue is a row that opens the thing
 * to fix — unfilled opens Assign, overtime lands on the person's row, a
 * rest gap opens the shift — and the labor-rules engine's findings sit in
 * the same list: blocks (publish refused until fixed) above warnings
 * (publish allowed). The late-notice reason stays inline.
 */

export interface PublishReviewProps {
  open: boolean;
  draftsInWeek: number;
  /** Null while the preflight is loading or when it failed (the sheet says so). */
  preflight: PublishPreflightResponse | null;
  preflightFailed: boolean;
  /** Labor findings the server answered a publish attempt with (409). */
  blockedBy?: PublishLaborFinding[] | null;
  truncated: boolean;
  initialReason: string;
  workersLabel: string;
  publishing: boolean;
  onCancel: () => void;
  /** Publish with the late-notice reason (empty = skip the notice-window drafts). */
  onPublish: (lateNoticeReason: string) => void;
  onOpenShift: (shiftId: string) => void;
  onOpenAssociate: (associateId: string, shiftIds: string[]) => void;
}

function Row({ tone, children, onClick, testId }: { tone: 'block' | 'warn' | 'info'; children: React.ReactNode; onClick?: () => void; testId?: string }) {
  const cls = cn(
    'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm',
    tone === 'block' && 'border-alert/40 bg-alert/[0.07] text-ink',
    tone === 'warn' && 'border-warning/40 bg-warning/[0.07] text-ink',
    tone === 'info' && 'border-navy-secondary bg-navy-secondary/30 text-silver',
    onClick && 'hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40',
  );
  const Icon = tone === 'block' ? ShieldAlert : AlertTriangle;
  const body = (
    <>
      <Icon className={cn('h-4 w-4 shrink-0', tone === 'block' ? 'text-alert' : 'text-warning')} aria-hidden="true" />
      <span className="min-w-0 flex-1">{children}</span>
      {onClick && <ChevronRight className="h-4 w-4 shrink-0 text-silver/60" aria-hidden="true" />}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cls} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

export function PublishReviewSheet(p: PublishReviewProps) {
  const [reason, setReason] = useState(p.initialReason);
  useEffect(() => {
    if (p.open) setReason(p.initialReason);
  }, [p.open, p.initialReason]);

  const pf = p.preflight;
  const findings = [...(pf?.laborFindings ?? []), ...(p.blockedBy ?? [])];
  const seen = new Set<string>();
  const uniqueFindings = findings.filter((f) => {
    const k = `${f.rule}|${f.shiftId}|${f.associateId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const blocks = uniqueFindings.filter((f) => f.severity === 'block');
  const warns = uniqueFindings.filter((f) => f.severity === 'warn');
  const noticeDrafts = pf?.noticeWindowDrafts ?? 0;
  const issueCount = (pf?.open ?? 0) + (pf?.otProjected.length ?? 0) + (pf?.restGaps.length ?? 0) + uniqueFindings.length;
  const t = pf?.totals;

  return (
    <Drawer open={p.open} onOpenChange={(o) => !o && p.onCancel()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>
          Publish {p.draftsInWeek} draft shift{p.draftsInWeek === 1 ? '' : 's'}?
        </DrawerTitle>
        <DrawerDescription>
          Assigned {p.workersLabel} are notified when you publish. Review the week first — each line opens the thing to fix.
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {p.truncated && (
          <Row tone="warn">
            This range shows a truncated shift list — narrow the range first so you can see everything you are publishing.
          </Row>
        )}

        {/* Totals */}
        {t && (
          <dl className="grid grid-cols-3 gap-2 text-center" data-testid="publish-totals">
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 px-2 py-2">
              <dt className="text-3xs uppercase tracking-wider text-silver/70">Shifts</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">{t.shifts}</dd>
            </div>
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 px-2 py-2">
              <dt className="text-3xs uppercase tracking-wider text-silver/70">Hours</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">
                {Math.round(t.hours)}h
                {t.deltaHoursVsLastWeek != null && (
                  <span className={cn('ml-1 text-2xs font-normal', t.deltaHoursVsLastWeek > 0 ? 'text-warning' : 'text-silver/70')}>
                    {t.deltaHoursVsLastWeek > 0 ? '+' : ''}
                    {Math.round(t.deltaHoursVsLastWeek)}h vs last wk
                  </span>
                )}
              </dd>
            </div>
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/30 px-2 py-2">
              <dt className="text-3xs uppercase tracking-wider text-silver/70">Cost</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">
                {fmtMoneyCompact(t.costCents / 100)}
                {t.deltaCostCentsVsLastWeek != null && (
                  <span className={cn('ml-1 text-2xs font-normal', t.deltaCostCentsVsLastWeek > 0 ? 'text-warning' : 'text-silver/70')}>
                    {t.deltaCostCentsVsLastWeek > 0 ? '+' : '−'}
                    {fmtMoneyCompact(Math.abs(t.deltaCostCentsVsLastWeek) / 100)}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        )}
        {pf?.notifyCount != null && (
          <p className="inline-flex items-center gap-1.5 text-sm text-silver" data-testid="publish-notify">
            <Bell className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
            {pf.notifyCount} {pf.notifyCount === 1 ? 'person' : 'people'} will be notified.
          </p>
        )}

        {p.preflightFailed && (
          <Row tone="warn">The week health report could not be loaded — you can still publish, and fix problems after.</Row>
        )}
        {!pf && !p.preflightFailed && <p className="text-sm text-silver/70">Checking the week…</p>}

        {/* Labor-rules blocks */}
        {blocks.length > 0 && (
          <section className="space-y-1.5" data-testid="publish-blocks">
            <h3 className="text-xs2 font-medium uppercase tracking-wider text-alert">
              Publish is blocked until these are fixed
            </h3>
            {blocks.map((f) => (
              <Row key={`${f.rule}-${f.shiftId}`} tone="block" onClick={() => p.onOpenShift(f.shiftId)}>
                <span className="block font-medium">{f.associateName ?? 'Unassigned'}</span>
                <span className="block text-xs text-silver">{f.reason}</span>
              </Row>
            ))}
          </section>
        )}

        {/* Issues that publish allows */}
        {pf && (issueCount - blocks.length > 0 || noticeDrafts > 0) && (
          <section className="space-y-1.5" data-testid="publish-issues">
            <h3 className="text-xs2 font-medium uppercase tracking-wider text-silver/70">Worth a look</h3>
            {pf.open > 0 && (
              <Row
                tone="warn"
                onClick={pf.openShiftIds && pf.openShiftIds.length > 0 ? () => p.onOpenShift(pf.openShiftIds![0]!) : undefined}
                testId="publish-open"
              >
                {pf.open} shift{pf.open === 1 ? '' : 's'} still unfilled
                {pf.openShiftIds && pf.openShiftIds.length > 0 ? ' — open Assign' : ''}
              </Row>
            )}
            {pf.otProjected.map((o) => (
              <Row
                key={`ot-${o.associateId ?? o.name}`}
                tone="warn"
                onClick={o.associateId ? () => p.onOpenAssociate(o.associateId!, o.shiftIds ?? []) : undefined}
                testId="publish-ot"
              >
                {o.name} projected over 40h ({o.hours}h)
                {o.projectedCostCents != null ? ` · ${fmtMoneyCompact(o.projectedCostCents / 100)}` : ''}
              </Row>
            ))}
            {pf.restGaps.map((r, i) => (
              <Row
                key={`rest-${i}`}
                tone="warn"
                onClick={r.shiftIds && r.shiftIds.length > 0 ? () => p.onOpenShift(r.shiftIds![r.shiftIds!.length - 1]!) : undefined}
                testId="publish-rest"
              >
                {r.name}: {r.gapHours}h rest before {fmtShiftTz(r.startsAt, r.timezone)}
              </Row>
            ))}
            {warns.map((f) => (
              <Row key={`w-${f.rule}-${f.shiftId}`} tone="warn" onClick={() => p.onOpenShift(f.shiftId)}>
                <span className="block font-medium">{f.associateName ?? 'Unassigned'}</span>
                <span className="block text-xs text-silver">{f.reason}</span>
              </Row>
            ))}
            {noticeDrafts > 0 && (
              <div className="space-y-1.5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
                <label htmlFor="publish-late-notice-reason" className="block text-xs2 font-medium text-ink">
                  {noticeDrafts} draft{noticeDrafts === 1 ? ' is' : 's are'} inside a fair-workweek notice window
                </label>
                <p className="text-xs text-silver/70">
                  Give one reason to publish {noticeDrafts === 1 ? 'it' : 'them'} too, or leave it blank to skip {noticeDrafts === 1 ? 'it' : 'them'} (add reasons individually via Edit).
                </p>
                <Textarea
                  id="publish-late-notice-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Volume spike — coverage added after the posting deadline"
                  maxLength={500}
                  rows={3}
                />
              </div>
            )}
          </section>
        )}
        {pf && issueCount === 0 && noticeDrafts === 0 && !p.preflightFailed && (
          <p className="inline-flex items-center gap-1.5 text-sm text-success" data-testid="publish-clean">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Clean week: every shift filled, no projected overtime, no short turnarounds.
          </p>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button type="button" variant="ghost" onClick={p.onCancel}>
          Not yet
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={p.publishing}
          disabled={blocks.length > 0 || p.publishing}
          onClick={() => p.onPublish(reason.trim())}
          title={blocks.length > 0 ? 'Fix the blocked shifts first.' : undefined}
          data-testid="publish-confirm"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          Publish week
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
