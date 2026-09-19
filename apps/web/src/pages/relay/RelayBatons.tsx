import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ChevronDown, Flag } from 'lucide-react';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui/Card';
import { DeskChip, OwnerControl, SectionHead } from './RelayParts';
import { claimKey, type Baton, type Claim, type Desk, type DeskPerson } from './relayTypes';

/**
 * The batons — every cross-department queue with its desk, count, age
 * and who holds it. Loud ones first; the clear ones fold into a single
 * line so the board says "quiet" without a wall of zeros.
 */

const DAY_MS = 86_400_000;

function when(b: Baton): { text: string; late: boolean } | null {
  if (b.dueOn) {
    const due = Date.parse(`${b.dueOn}T23:59:00`);
    const days = Math.round((due - Date.now()) / DAY_MS);
    if (days < 0) return { text: `${-days}d late`, late: true };
    if (days === 0) return { text: 'due today', late: false };
    return { text: `due ${fmtDate(`${b.dueOn}T12:00:00Z`)}`, late: false };
  }
  if (b.oldestAt) {
    const days = Math.floor((Date.now() - Date.parse(b.oldestAt)) / DAY_MS);
    return { text: days < 1 ? 'oldest today' : `oldest ${days}d`, late: b.status === 'overdue' };
  }
  return null;
}

export function RelayBatons({
  batons,
  lens,
  claims,
  desks,
  meId,
  onChanged,
}: {
  batons: Baton[];
  lens: Desk | 'ALL';
  claims: Record<string, Claim>;
  desks: Record<Desk, DeskPerson[]> | undefined;
  meId: string | undefined;
  onChanged: () => void;
}) {
  const [showClear, setShowClear] = useState(false);
  const inLens = batons.filter((b) => lens === 'ALL' || b.desk === lens);
  const active = inLens.filter((b) => b.count > 0);
  const clear = inLens.filter((b) => b.count === 0);
  const overdue = active.filter((b) => b.status === 'overdue').length;

  return (
    <section aria-labelledby="relay-batons">
      <SectionHead
        icon={Flag}
        title="Batons"
        meta={
          active.length === 0 ? 'all clear' : `${active.length} open${overdue ? ` · ${overdue} late` : ''}`
        }
        id="relay-batons"
      />
      <Card className="overflow-hidden p-0">
        {active.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-success">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Nothing waiting{lens === 'ALL' ? '' : ' on this desk'} — silence means green.
          </p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {active.map((b) => {
              const w = when(b);
              return (
                <li key={b.key} id={b.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-2.5 w-2.5 shrink-0 rounded-full',
                      b.status === 'overdue' ? 'bg-alert shadow-[0_0_0_3px_rgb(var(--color-alert)/0.2)]' : b.status === 'atRisk' ? 'bg-warning' : 'bg-silver/40',
                    )}
                  />
                  <Link to={b.link} className="group flex min-w-0 flex-1 items-center gap-2 focus:outline-none focus-visible:underline">
                    <span
                      className={cn(
                        'w-9 shrink-0 text-right text-lg font-semibold tabular-nums',
                        b.status === 'overdue' ? 'text-alert' : b.status === 'atRisk' ? 'text-warning' : 'text-white',
                      )}
                    >
                      {b.count}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-white group-hover:text-gold-bright">{b.label}</span>
                      {w && <span className={cn('block text-xs tabular-nums', w.late ? 'text-alert' : 'text-silver/70')}>{w.text}</span>}
                    </span>
                  </Link>
                  {lens === 'ALL' && <DeskChip desk={b.desk} />}
                  <OwnerControl
                    subjectType="BATON"
                    subjectKey={b.key}
                    what={`“${b.label}”`}
                    claim={claims[claimKey('BATON', b.key)]}
                    desks={desks}
                    meId={meId}
                    onChanged={onChanged}
                    compact
                  />
                  <Link to={b.link} aria-label={`Work ${b.label}`} className="rounded p-1 text-silver/50 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {clear.length > 0 && (
          <div className="border-t border-navy-secondary/60 bg-navy/40 px-4 py-2">
            <button
              type="button"
              onClick={() => setShowClear((v) => !v)}
              aria-expanded={showClear}
              className="flex w-full items-center gap-2 text-left text-xs text-silver/70 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              <span className="flex-1">{clear.length} clear</span>
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showClear && 'rotate-180')} aria-hidden="true" />
            </button>
            {showClear && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {clear.map((b) => (
                  <li key={b.key}>
                    <Link to={b.link} className="inline-flex items-center gap-1 rounded-full border border-navy-secondary px-2 py-0.5 text-2xs text-silver hover:text-white">
                      {b.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
