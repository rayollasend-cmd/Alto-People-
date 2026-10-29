import { Link } from 'react-router-dom';
import type { ExecRiskSeverity, ExecRisks } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { execHref, useExecRisks, type ExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { Preview, PreviewBody } from './PreviewParts';

/**
 * Risk, in one look (2026-10-27): the five most serious entries on the
 * register — severity, what it is, who owns it — and the way into the
 * whole register. Severity is a chip from the palette's scales, the word
 * always beside the colour.
 */
const TOP = 5;

const SEVERITY: Record<ExecRiskSeverity, { variant: 'destructive' | 'pending' | 'default'; className?: string }> = {
  high: { variant: 'destructive' },
  medium: { variant: 'pending' },
  low: { variant: 'default', className: 'border-neutral-200 bg-neutral-100 text-neutral-800' },
};

export function RiskPreview({ frame }: { frame: ExecFrame }) {
  const { t } = useI18n();
  const q = useExecRisks();
  const d = q.data;
  return (
    <Preview
      id="exec-home-risk"
      title={t('execPortal.home.risk.title')}
      answer={d ? riskAnswer(d, t) : undefined}
      open={{ to: execHref('/executive/risk', frame), label: t('execPortal.home.risk.open') }}
      testId="exec-preview-risk"
    >
      {!d ? q.isError ? <QueryError what={t('execPortal.home.risk.what')} query={q} /> : <PreviewBody height={280} /> : <RiskBody d={d} frame={frame} />}
    </Preview>
  );
}

type T = ReturnType<typeof useI18n>['t'];

function riskAnswer(d: ExecRisks, t: T): string {
  const n = (s: ExecRiskSeverity) => d.risks.filter((r) => r.severity === s).length;
  if (d.risks.length === 0) return t('execPortal.home.risk.answerNone');
  const high = n('high');
  return high > 0
    ? t('execPortal.home.risk.answerHigh', { count: d.risks.length, high })
    : t('execPortal.home.risk.answerCalm', { count: d.risks.length });
}

const RANK: Record<ExecRiskSeverity, number> = { high: 0, medium: 1, low: 2 };

function RiskBody({ d, frame }: { d: ExecRisks; frame: ExecFrame }) {
  const { t } = useI18n();
  const top = [...d.risks].sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, TOP);
  if (top.length === 0) {
    return (
      <Card animate={false} className="p-4">
        <EmptyState size="sm" title={t('execPortal.home.risk.empty')} description={t('execPortal.home.risk.emptyBody')} />
      </Card>
    );
  }
  return (
    <Card animate={false} className="min-w-0 overflow-hidden">
      <ul role="list" className="divide-y divide-line-subtle" data-testid="exec-risks">
        {top.map((r) => {
          const sev = SEVERITY[r.severity];
          return (
            <li key={r.id}>
              <Link
                to={execHref(r.href, frame)}
                className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent coarse:min-h-11"
              >
                <Badge size="sm" variant={sev.variant} withDot={r.severity !== 'low'} className={`mt-0.5 w-[4.75rem] shrink-0 justify-center ${sev.className ?? ''}`}>
                  {t(`execPortal.home.risk.severity.${r.severity}`)}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-snug text-ink group-hover:text-accent">{r.title}</span>
                  <span className="mt-0.5 block text-xs2 text-ink-muted">
                    {t('execPortal.home.risk.owner', { owner: r.owner })}
                    {r.metric ? ` · ${r.metric}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
