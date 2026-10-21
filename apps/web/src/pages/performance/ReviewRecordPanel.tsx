import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Heart, Target, Timer, FileText } from 'lucide-react';
import { getReviewContext } from '@/lib/performanceApi';
import { fmtDate, parseYmd } from '@/lib/format';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';

/**
 * The record beside the review form: goals and how far they got, kudos in
 * the period, what the 1:1s covered, attendance, and the last review — so
 * the reviewer writes from what happened, then rates.
 */
export function ReviewRecordPanel({ associateId, from, to }: { associateId: string; from: string; to: string }) {
  const q = useQuery({
    queryKey: ['performance', 'review-context', associateId, from, to],
    queryFn: () => getReviewContext(associateId, from || undefined, to || undefined),
    enabled: !!associateId,
  });
  if (q.isPending) return <Skeleton className="h-80" />;
  if (q.isError) return <QueryError what="their record" query={q} />;
  const c = q.data;
  const a = c.attendance;
  const attendanceTotal = a.late + a.noCallNoShow + a.callOut + a.earlyOut;
  return (
    <aside className="space-y-4 text-sm" aria-label={`${c.associate.name}'s record for the period`}>
      <Section icon={Target} title="Goals">
        {c.goals.length === 0 ? (
          <Muted>No goals on file.</Muted>
        ) : (
          <ul className="space-y-2">
            {c.goals.slice(0, 6).map((g) => (
              <li key={g.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink" title={g.title}>
                    {g.title}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-muted">{g.progressPct}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <div className={g.status === 'AT_RISK' ? 'h-full bg-warning' : 'h-full bg-success'} style={{ width: `${Math.min(100, g.progressPct)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section icon={Timer} title="Attendance">
        {attendanceTotal === 0 ? (
          <Muted>No late arrivals, no-shows, call-outs or early outs in the period.</Muted>
        ) : (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
            <Stat label="Late" value={a.late} />
            <Stat label="No-call no-shows" value={a.noCallNoShow} bad />
            <Stat label="Call-outs" value={a.callOut} />
            <Stat label="Left early" value={a.earlyOut} />
          </dl>
        )}
        <p className="mt-1 text-xs text-ink-muted">Excused events are left out.</p>
      </Section>
      <Section icon={CalendarCheck} title={`1:1s held · ${c.oneOnOnes.length}`}>
        {c.oneOnOnes.length === 0 ? (
          <Muted>No 1:1s held in the period.</Muted>
        ) : (
          <ul className="space-y-2">
            {c.oneOnOnes.slice(0, 4).map((m) => (
              <li key={m.id}>
                <span className="text-xs text-ink-muted">{fmtDate(m.at)}</span>
                <p className="line-clamp-3 text-ink">{m.notes || m.agenda || 'No notes.'}</p>
                {m.itemsOpen + m.itemsDone > 0 && (
                  <p className="text-xs text-ink-muted">
                    {m.itemsDone} of {m.itemsOpen + m.itemsDone} action items done
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section icon={Heart} title={`Kudos · ${c.kudos.length}`}>
        {c.kudos.length === 0 ? (
          <Muted>None in the period.</Muted>
        ) : (
          <ul className="space-y-1.5">
            {c.kudos.slice(0, 3).map((k) => (
              <li key={k.id} className="line-clamp-2 text-ink">
                “{k.message}” <span className="text-xs text-ink-muted">— {k.from}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section icon={FileText} title="Last review">
        {c.lastReview ? (
          <>
            <p className="text-ink">
              {c.lastReview.overallRating} of 5 · {fmtDate(parseYmd(c.lastReview.periodStart))} – {fmtDate(parseYmd(c.lastReview.periodEnd))}
            </p>
            <p className="line-clamp-3 text-ink-muted">{c.lastReview.summary}</p>
          </>
        ) : (
          <Muted>Their first review.</Muted>
        )}
      </Section>
    </aside>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Target; title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ink-muted">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {title}
      </h4>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-muted">{children}</p>;
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className={bad && value > 0 ? 'text-right text-alert' : 'text-right text-ink'}>{value}</dd>
    </>
  );
}
