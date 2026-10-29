import { useState } from 'react';
import { Activity, ArrowRight, Calculator, SlidersHorizontal } from '@/components/ui/icons';
import { Link } from 'react-router-dom';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { PeriodBar } from '@/components/executive/PeriodBar';
import { Button } from '@/components/ui/Button';
import { LiveNow } from '@/components/ui/LiveNow';
import { useAuth } from '@/lib/auth';
import { execHref, useExecFrame, useExecOverview, type ExecFrame } from '@/lib/executiveApi';
import { greetingName, useGreeting } from '@/lib/greeting';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { BoardPackButton } from '@/pages/executive/home/BoardPackButton';
import { DecisionsForYou } from '@/pages/executive/home/DecisionQueueCard';
import { Previews } from '@/pages/executive/home/Previews';
import { PlanPrompt, Scorecard } from '@/pages/executive/home/Scorecard';
import { SetPlanDrawer } from '@/pages/executive/home/SetPlanDrawer';
import { WhatChanged } from '@/pages/executive/home/WhatChanged';

/**
 * The executive chairman's home (rebuilt 2026-10-27): "how is the company
 * doing against plan?" in five seconds, on one screen.
 *
 *   1. The greeting and the frame — the period, what it is compared with,
 *      as of when — with the board pack and "Set the plan" beside it.
 *   2. The scorecard: eight measures, each against the comparison and the
 *      plan, each opening its drill-down (the frame kept).
 *   3. What changed, and the decisions waiting on the chairman.
 *   4. One look at each board topic — Financials, Client portfolio,
 *      Workforce, Risk — loaded after the scorecard, with the way in.
 *   5. Scenarios and the operations pulse, then the definitions.
 *
 * Everything the old home carried beyond this (the floor, batons, the
 * store league, receivables aging…) lives on the drill-down pages now.
 */
export function ExecutiveDashboard() {
  const { t } = useI18n();
  const greet = useGreeting();
  const { user, can } = useAuth();
  const frame = useExecFrame();
  const overview = useExecOverview(frame);
  const [planOpen, setPlanOpen] = useState(false);
  const canSetPlan = can('set:exec-targets') || can('manage:org');
  const data = overview.data;
  const name = greetingName(user, '');

  return (
    <HomeTemplate
      title={
        <>
          <LiveNow render={(now) => greet(now.getHours())} />
          {name && (
            <>
              , <span className="text-accent">{name}</span>
            </>
          )}
          .
        </>
      }
      subtitle={t('execPortal.home.subtitle')}
      hero={
        <div className="space-y-3">
          <PeriodBar
            frame={frame}
            period={data?.period}
            comparison={data?.comparison}
            actions={
              <>
                {canSetPlan && (
                  <Button size="sm" variant="secondary" onClick={() => setPlanOpen(true)} data-testid="exec-set-plan">
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                    {t('execPortal.setPlan')}
                  </Button>
                )}
                <BoardPackButton frame={frame} />
              </>
            }
          />
          {data && !data.plan.set && <PlanPrompt quarter={data.plan.quarter} canSet={canSetPlan} onSet={() => setPlanOpen(true)} />}
          <Scorecard overview={overview} frame={frame} />
        </div>
      }
      assistant={<HugoSeat />}
    >
      <div className="grid items-start gap-x-6 gap-y-8 lg:grid-cols-2">
        <WhatChanged changes={data?.changes} loading={overview.isPending} frame={frame} />
        <DecisionsForYou />
      </div>
      <Previews frame={frame} scorecardSettled={!!data || overview.isError} />
      <MoreLinks frame={frame} />
      {data && data.notes.length > 0 && (
        <div className="space-y-1 text-xs2 leading-relaxed text-ink-muted" data-testid="exec-notes">
          {data.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
      <SetPlanDrawer open={planOpen} onOpenChange={setPlanOpen} />
    </HomeTemplate>
  );
}

/** The two pages that are not a board topic: modelling a what-if, and today on the floor. */
function MoreLinks({ frame }: { frame: ExecFrame }) {
  const { t } = useI18n();
  const links = [
    { to: execHref('/executive/scenarios', frame), Icon: Calculator, name: t('execPortal.home.linkScenarios'), what: t('execPortal.home.linkScenariosWhat') },
    { to: '/executive/operations', Icon: Activity, name: t('execPortal.home.linkOps'), what: t('execPortal.home.linkOpsWhat') },
  ];
  return (
    <nav aria-label={t('execPortal.home.moreAria')} className="grid gap-3 sm:grid-cols-2">
      {links.map(({ to, Icon, name, what }) => (
        <Link
          key={to}
          to={to}
          className="group flex items-center gap-3 rounded-lg border border-line-subtle bg-surface px-4 py-3 text-sm transition-colors hover:border-line hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11"
        >
          <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="font-medium text-ink">{name}</span>
            <span className="text-ink-muted"> — {what}</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
      ))}
    </nav>
  );
}
