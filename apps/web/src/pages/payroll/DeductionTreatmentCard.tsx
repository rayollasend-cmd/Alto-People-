import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * How pre-tax deductions are taxed in the states this company's people live
 * in (apps/api/src/lib/deductionTaxability.ts): where a state taxes what the
 * federal rules don't (PA 401(k), NJ cafeteria plans and HSA, CA HSA), and
 * where the treatment is still the federal fallback awaiting the tax
 * adviser's confirmation.
 */

interface Treatment {
  differences: Array<{ state: string; code: string; label: string; base: 'Income tax' | 'Unemployment' }>;
  unverified: Array<{ state: string; scope: 'SUI' | 'PROGRAM' | 'LOCAL'; note: string; people: number }>;
}

const SCOPE_LABEL: Record<Treatment['unverified'][number]['scope'], string> = {
  SUI: 'Unemployment',
  PROGRAM: 'Disability / paid leave',
  LOCAL: 'Local taxes',
};

export function DeductionTreatmentCard() {
  const q = useQuery({ queryKey: ['payroll', 'deduction-treatment'], queryFn: () => apiFetch<Treatment>('/payroll/deduction-treatment') });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return null;
  const byState = new Map<string, Treatment['differences']>();
  for (const d of q.data.differences) byState.set(d.state, [...(byState.get(d.state) ?? []), d]);
  const relevant = q.data.unverified.filter((u) => u.people > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>How deductions are taxed by state</CardTitle>
        <CardDescription>
          Pre-tax deductions lower federal taxes, but some states tax them anyway. Payroll withholds and reports each state on its own wages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {byState.size === 0 ? (
          <p className="text-sm text-ink-muted">Every state where your people live follows the federal treatment of their deductions.</p>
        ) : (
          <ul className="divide-y divide-line">
            {[...byState.entries()].map(([state, rows]) => (
              <li key={state} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
                <span className="w-10 shrink-0 text-sm font-medium text-ink">{state}</span>
                <span className="flex flex-wrap gap-1.5">
                  {rows.map((r) => (
                    <Badge key={`${r.code}-${r.base}`} size="sm" withDot={false} variant="outline">
                      {r.label} taxed for {r.base.toLowerCase()}
                    </Badge>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        {relevant.length > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
            <p className="text-sm font-medium text-ink">To confirm with your tax adviser</p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {relevant.map((u) => (
                <li key={`${u.state}-${u.scope}`} className="text-ink-muted">
                  <span className="font-medium text-ink">
                    {u.state} · {SCOPE_LABEL[u.scope]}
                  </span>{' '}
                  ({u.people} {u.people === 1 ? 'person' : 'people'}): {u.note}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
