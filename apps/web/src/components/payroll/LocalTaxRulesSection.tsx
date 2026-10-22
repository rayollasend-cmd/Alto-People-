import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { createLocalTaxRule, listLocalTaxRules, type LocalTaxRule } from '@/lib/payrollApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * City and county taxes payroll sets by hand (audit Tier 3): a flat rate
 * on gross for a place the engine doesn't work out from an address. A rule
 * is put on a person from their Pay tab, where it replaces the engine's
 * local taxes for them.
 */
export function LocalTaxRulesSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll', 'local-tax-rules'], queryFn: listLocalTaxRules });
  const [state, setState] = useState('');
  const [name, setName] = useState('');
  const [ratePct, setRatePct] = useState('');
  const rate = Number(ratePct) / 100;
  const valid = /^[A-Za-z]{2}$/.test(state) && name.trim().length > 1 && Number.isFinite(rate) && rate > 0 && rate < 0.2;
  const create = useMutation({
    mutationFn: () => createLocalTaxRule({ state: state.toUpperCase(), name: name.trim(), rate }),
    onSuccess: () => {
      toast.success(`${name.trim()} added. Put it on a person from their Pay tab.`);
      setState('');
      setName('');
      setRatePct('');
      void qc.invalidateQueries({ queryKey: ['payroll', 'local-tax-rules'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add the rule.'),
  });
  const cols: GridColumn<LocalTaxRule>[] = [
    { key: 'name', header: 'City or county', accessor: (r) => r.name, primary: true, sortable: true },
    { key: 'state', header: 'State', accessor: (r) => r.state, sortable: true, cardMeta: true },
    { key: 'rate', header: 'Rate', accessor: (r) => r.rate, sortable: true, className: 'tabular-nums', cell: (r) => `${(r.rate * 100).toFixed(3)}%` },
    { key: 'people', header: 'People on it', accessor: (r) => r.assignedCount, sortable: true, className: 'tabular-nums', cardMeta: true },
    { key: 'active', header: 'Status', accessor: (r) => (r.isActive ? 'Active' : 'Off'), cell: (r) => (r.isActive ? <Badge variant="success" size="sm">Active</Badge> : <Badge size="sm">Off</Badge>) },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local tax rules set by hand</CardTitle>
        <CardDescription>A flat city or county rate on gross, for a place the address can’t decide. Put a rule on a person from their Pay tab; it replaces the local taxes worked out for them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-[6rem_1fr_8rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <Field label="State">{(p) => <Input value={state} onChange={(e) => setState(e.target.value.slice(0, 2))} placeholder="PA" maxLength={2} {...p} />}</Field>
          <Field label="City or county">{(p) => <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Philadelphia wage tax" {...p} />}</Field>
          <Field label="Rate %">{(p) => <Input type="number" inputMode="decimal" step="0.001" min="0" value={ratePct} onChange={(e) => setRatePct(e.target.value)} placeholder="3.75" {...p} />}</Field>
          <Button type="submit" disabled={!valid} loading={create.isPending}>
            Add rule
          </Button>
        </form>
        <DataGrid
          id="local-tax-rules"
          caption="Local tax rules"
          rows={q.data?.rules ?? []}
          loading={q.isLoading}
          rowKey={(r) => r.id}
          columns={cols}
          noun={{ one: 'rule', many: 'rules' }}
          defaultSort={{ key: 'state', direction: 'asc' }}
          empty={{ title: 'No local rules set by hand', description: 'The engine works out local taxes from addresses; add a rule only where it can’t.' }}
        />
      </CardContent>
    </Card>
  );
}
