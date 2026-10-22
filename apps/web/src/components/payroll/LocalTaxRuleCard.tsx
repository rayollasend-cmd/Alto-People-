import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { listLocalTaxRules, setAssociateLocalTaxRule } from '@/lib/payrollApi';
import { getPaySummary } from '@/lib/payrollDeskApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

/**
 * A city or county tax set by hand on one person (audit Tier 3): it
 * replaces the local taxes the engine would work out from their address.
 * The rules themselves are kept on Payroll → Tax jurisdictions.
 */
export function LocalTaxRuleCard({ associateId }: { associateId: string }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['payroll', 'local-tax-rules'], queryFn: listLocalTaxRules });
  const summary = useQuery({ queryKey: ['payroll', 'pay-summary', associateId], queryFn: () => getPaySummary(associateId) });
  const currentRuleId = summary.data?.localTaxRuleId ?? null;
  const set = useMutation({
    mutationFn: (ruleId: string | null) => setAssociateLocalTaxRule(associateId, ruleId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payroll', 'local-tax-rules'] });
      void qc.invalidateQueries({ queryKey: ['tax-profile', associateId] });
      void qc.invalidateQueries({ queryKey: ['payroll', 'pay-summary', associateId] });
      toast.success('Local tax rule saved.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const active = (rules.data?.rules ?? []).filter((r) => r.isActive);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local tax set by hand</CardTitle>
        <CardDescription>Use when the address can’t decide the city or county tax. It replaces the local taxes worked out from where they live and work.</CardDescription>
      </CardHeader>
      <CardContent>
        <Field label="Local tax rule" hint={active.length === 0 ? 'Add a city or county rule on Payroll → Tax jurisdictions first.' : undefined}>
          {(p) => (
            <Select value={currentRuleId ?? ''} disabled={set.isPending || rules.isLoading} onChange={(e) => set.mutate(e.target.value || null)} {...p}>
              <option value="">From their address (no rule)</option>
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.state} · {r.name} · {(r.rate * 100).toFixed(3)}%
                </option>
              ))}
            </Select>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}
