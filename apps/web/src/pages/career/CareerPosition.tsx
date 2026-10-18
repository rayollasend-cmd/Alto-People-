import { Check, Circle } from 'lucide-react';
import type { CareerPosition, CareerRequirement, SkillLevel } from '@/lib/career126Api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Badge, Card, CardContent, SectionTitle } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * A ladder drawn as a ladder: every rung from the top down, "You are here"
 * on theirs, and under the next rung what it asks for — each requirement
 * met or not, with what they have against what it needs. Used on Career
 * (for the reader) and on a person's record (for HR or their manager).
 */

const SKILL_KEY: Record<SkillLevel, MessageKey> = {
  BEGINNER: 'career.skill.BEGINNER',
  INTERMEDIATE: 'career.skill.INTERMEDIATE',
  ADVANCED: 'career.skill.ADVANCED',
  EXPERT: 'career.skill.EXPERT',
};

function RequirementRow({ r }: { r: CareerRequirement }) {
  const { t } = useI18n();
  const label =
    r.kind === 'tenure' ? t('career.reqTenure') : r.kind === 'review' ? t('career.reqReview') : r.kind === 'certification' ? t('career.reqCert', { name: r.label }) : r.label;
  const fmt = (v: CareerRequirement['have']): string => {
    if (v === null) return r.kind === 'review' ? t('career.noReview') : t('career.notYet');
    if (r.kind === 'skill') return t(SKILL_KEY[v as SkillLevel]);
    if (r.kind === 'tenure') return t('career.months', { n: v as number });
    if (r.kind === 'review') return t('career.rating', { n: v as number });
    return String(v);
  };
  return (
    <li className="flex items-start gap-2.5 py-2">
      <span
        className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full', r.met ? 'bg-success/15 text-success' : 'bg-surface-raised text-ink-muted')}
        aria-hidden="true"
      >
        {r.met ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-2.5 w-2.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">
          {label}
          <span className="sr-only">: {r.met ? t('career.met') : t('career.notMet')}</span>
        </div>
        {r.kind !== 'certification' && (
          <div className="text-xs text-ink-muted">
            {t('career.haveNeed', { have: fmt(r.have), need: fmt(r.need) })}
          </div>
        )}
      </div>
    </li>
  );
}

export function CareerLadderView({ position, self }: { position: CareerPosition; self: boolean }) {
  const { t } = useI18n();
  const ladder = position.ladder;
  if (!ladder) {
    return (
      <Card>
        <CardContent className="text-sm text-ink-muted">{self ? t('career.noLadderSelf') : t('career.noLadderOther')}</CardContent>
      </Card>
    );
  }
  const currentRank = ladder.levels.find((l) => l.id === position.currentLevelId)?.rank ?? 0;
  const rungs = [...ladder.levels].sort((a, b) => b.rank - a.rank);
  return (
    <Card>
      <CardContent>
        <SectionTitle
          as="h3"
          title={ladder.name}
          trailing={position.placedBy === 'role' ? <span className="text-xs text-ink-muted">{t('career.placedByRole')}</span> : undefined}
          className="mb-3"
        />
        <ol className="relative space-y-2 border-l-2 border-line pl-5" aria-label={ladder.name}>
          {rungs.map((lv) => {
            const here = lv.id === position.currentLevelId;
            const isNext = position.next?.id === lv.id;
            const done = lv.rank < currentRank;
            return (
              <li key={lv.id} className="relative" aria-current={here ? 'step' : undefined}>
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute -left-[1.6rem] top-3 h-3 w-3 rounded-full border-2',
                    here ? 'border-accent bg-accent' : done ? 'border-success bg-success' : isNext ? 'border-accent bg-surface' : 'border-line bg-surface',
                  )}
                />
                <div className={cn('rounded-lg border px-3 py-2.5', here ? 'border-accent bg-accent-fill/10' : 'border-line')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{lv.title}</span>
                    {here && (
                      <Badge size="sm" variant="accent">
                        {self ? t('career.youAreHere') : t('career.theyAreHere')}
                      </Badge>
                    )}
                    {isNext && <span className="text-2xs font-medium text-accent">{t('career.nextRung')}</span>}
                  </div>
                  {lv.description && <p className="mt-0.5 text-xs text-ink-muted">{lv.description}</p>}
                  {isNext && position.next && (
                    <div className="mt-2">
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={position.next.progressPct}
                        aria-label={t('career.progressLabel', { title: lv.title })}
                        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
                      >
                        <div className="h-full rounded-full bg-accent" style={{ width: `${position.next.progressPct}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">{t('career.progress', { pct: position.next.progressPct })}</p>
                      {position.next.requirements.length > 0 ? (
                        <ul className="mt-1 divide-y divide-line">
                          {position.next.requirements.map((r, i) => (
                            <RequirementRow key={`${r.kind}-${r.label}-${i}`} r={r} />
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-xs text-ink-muted">{t('career.noRequirements')}</p>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {!position.next && <p className="mt-3 text-sm text-ink-muted">{self ? t('career.topSelf') : t('career.topOther')}</p>}
      </CardContent>
    </Card>
  );
}
