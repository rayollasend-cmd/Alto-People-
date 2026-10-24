import { useQuery } from '@tanstack/react-query';
import { PiggyBank } from '@/components/ui/icons';
import { fmtMoney } from '@/lib/format';
import { getPersonRothCatchUp, ROTH_STATUS_LABEL, type RothCatchUpStatus } from '@/lib/payComplianceApi';
import { Badge, Card, CardContent, SectionTitle } from '@/components/ui';

/**
 * The person's catch-up position under SECURE 2.0 (Roth catch-up for higher
 * earners, from 2026), per 401(k)/403(b) plan. Nothing renders for someone
 * with no retirement plan or under 50.
 */

const VARIANT: Record<RothCatchUpStatus, 'default' | 'success' | 'pending' | 'destructive' | 'info'> = {
  NOT_ELIGIBLE: 'default',
  AGE_UNKNOWN: 'pending',
  PRE_TAX_OR_ROTH: 'success',
  ROTH_BY_ELECTION: 'info',
  ROTH_DEEMED: 'info',
  CATCH_UP_STOPPED: 'destructive',
};

export function RothCatchUpCard({ associateId }: { associateId: string }) {
  const q = useQuery({ queryKey: ['pay-compliance', 'roth', associateId], queryFn: () => getPersonRothCatchUp(associateId) });
  const plans = (q.data?.plans ?? []).filter((p) => p.status !== 'NOT_ELIGIBLE');
  if (q.isPending || q.isError || plans.length === 0) return null;
  return (
    <div className="space-y-3">
      <SectionTitle title={`Catch-up contributions, ${q.data!.year}`} />
      <Card>
        <CardContent className="space-y-3">
          {plans.map((p) => (
            <div key={p.plan} className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm text-ink">
                <PiggyBank className="h-4 w-4 text-gold" aria-hidden />
                {p.plan}
                {p.age != null && <span className="text-xs text-silver">age {p.age} at year end</span>}
              </div>
              <Badge variant={VARIANT[p.status]}>{ROTH_STATUS_LABEL[p.status]}</Badge>
            </div>
          ))}
          {plans[0]!.priorYearFicaWages != null && (
            <p className="text-xs text-silver">
              Last year’s Social Security wages here: {fmtMoney(plans[0]!.priorYearFicaWages)}. Over {fmtMoney(plans[0]!.threshold)}, catch-up must be Roth.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
