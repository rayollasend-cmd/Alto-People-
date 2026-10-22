import type { AutoFillCandidate } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { fmtMoney } from '@/lib/format';

/**
 * The facts a scheduler decides on, on the Assign dialog's row (role
 * walk, ops 7). The row used to show a name, an email and "0h wk";
 * checking cost or reliability meant three more page loads. Each line
 * renders only when the server sent the fact, so an older API still
 * gets a row.
 *
 *   Front Beach · 32h → 40h this wk · +$18 OT
 *   $96 this shift · 2 late · 0 no-shows · 90d
 *   Avail Mon–Fri 4:00 PM–11:00 PM · 4 shifts here · 3.2 mi
 *   Missing: Food handler
 */

const h = (min: number) => `${Math.round((min / 60) * 10) / 10}h`;

export function AssignCandidateFacts({ c, className }: { c: AutoFillCandidate; className?: string }) {
  const projected = c.projectedWeeklyMinutes;
  // Whether this shift adds overtime is the server's answer — its labor-rules
  // engine splits the week as the paycheck will (past 40, or a state's daily
  // rule). Only an older API without it falls back to the 40-hour line.
  const overForty = c.wouldBeOvertime ?? (projected != null && projected > 40 * 60);
  const top: string[] = [];
  if (c.homeLocationName) top.push(c.homeLocationName);
  const rel = c.reliability;
  const second: string[] = [];
  if (c.shiftCostCents != null) second.push(`${fmtMoney(c.shiftCostCents / 100)} this shift`);
  if (rel) second.push(`${rel.late} late · ${rel.noShow} no-show${rel.noShow === 1 ? '' : 's'} · ${rel.callOut} call-out${rel.callOut === 1 ? '' : 's'} · ${rel.days}d`);
  const third: string[] = [];
  if (c.availabilityLabel) third.push(c.availabilityLabel);
  if (c.siteShiftsWorked != null) third.push(`${c.siteShiftsWorked} shift${c.siteShiftsWorked === 1 ? '' : 's'} here`);
  if (c.distanceMiles != null) third.push(`${c.distanceMiles < 10 ? c.distanceMiles.toFixed(1) : Math.round(c.distanceMiles)} mi`);
  const missing = c.credentials?.missing ?? [];
  return (
    <div className={cn('text-2xs leading-tight text-silver/80', className)} data-testid="candidate-facts">
      <div className="flex flex-wrap items-center gap-x-1.5">
        {top.map((t) => (
          <span key={t} className="truncate">{t}</span>
        ))}
        {top.length > 0 && <span className="text-silver/40">·</span>}
        <span className={cn('tabular-nums', overForty && 'text-alert font-medium')}>
          {h(c.weeklyMinutesScheduled)}
          {projected != null && (
            <>
              {' → '}
              {h(projected)}
            </>
          )}{' '}
          this wk
        </span>
        {overForty && c.otPremiumCents != null && c.otPremiumCents > 0 && (
          <span className="text-alert tabular-nums">+{fmtMoney(c.otPremiumCents / 100)} OT</span>
        )}
      </div>
      {second.length > 0 && <div className="truncate tabular-nums">{second.join(' · ')}</div>}
      {third.length > 0 && <div className="truncate">{third.join(' · ')}</div>}
      {missing.length > 0 && (
        <div className="text-alert truncate">Missing: {missing.join(', ')}</div>
      )}
    </div>
  );
}
