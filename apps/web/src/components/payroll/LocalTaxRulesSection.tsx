import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { createLocalTaxRule, listLocalTaxRules, type LocalTaxRule } from '@/lib/payrollApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * City and county taxes payroll sets by hand (audit Tier 3): a flat rate
 * on gross for a place the engine doesn't work out from an address. A rule
 * is put on a person from their Pay tab, where it replaces the engine's
 * local taxes for them.
 *
 * Tax tables › Hand-set rules (F500 G3): the list on its own tab, and adding
 * one in a dialog with EMPTY fields — the inline form's placeholders ("PA",
 * "Philadelphia wage tax", "3.75") read like a rule already saved.
 */
export function LocalTaxRulesSection({ onAdd }: { onAdd?: () => void }) {
  const q = useQuery({ queryKey: ['payroll', 'local-tax-rules'], queryFn: listLocalTaxRules });
  const cols: GridColumn<LocalTaxRule>[] = [
    { key: 'name', header: 'City or county', accessor: (r) => r.name, primary: true, sortable: true },
    { key: 'state', header: 'State', accessor: (r) => r.state, sortable: true, cardMeta: true },
    { key: 'rate', header: 'Rate', accessor: (r) => r.rate, sortable: true, className: 'tabular-nums', cell: (r) => `${(r.rate * 100).toFixed(3)}%` },
    { key: 'people', header: 'People on it', accessor: (r) => r.assignedCount, sortable: true, className: 'tabular-nums', cardMeta: true },
    { key: 'active', header: 'Status', accessor: (r) => (r.isActive ? 'Active' : 'Off'), cell: (r) => (r.isActive ? <Badge variant="success" size="sm">Active</Badge> : <Badge size="sm">Off</Badge>) },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        A flat city or county rate on gross, for a place the address can’t decide. Put a rule on a person from their Pay tab; it replaces the local
        taxes worked out for them.
      </p>
      <DataGrid
        id="local-tax-rules"
        caption="Local tax rules set by hand"
        rows={q.data?.rules ?? null}
        loading={q.isLoading}
        error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load the rules.') : null}
        onRetry={() => void q.refetch()}
        rowKey={(r) => r.id}
        columns={cols}
        noun={{ one: 'rule', many: 'rules' }}
        defaultSort={{ key: 'state', direction: 'asc' }}
        empty={{
          title: 'No local rules set by hand',
          description: 'The engine works out local taxes from addresses; add a rule only where it can’t.',
          action: onAdd ? (
            <Button onClick={onAdd}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add local rule
            </Button>
          ) : undefined,
        }}
      />
    </div>
  );
}

/** Add a hand-set local rule: empty fields, the format in the hints, never a value that looks saved. */
export function AddLocalRuleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState('');
  const [name, setName] = useState('');
  const [ratePct, setRatePct] = useState('');
  const rate = Number(ratePct) / 100;
  const valid = /^[A-Za-z]{2}$/.test(state) && name.trim().length > 1 && Number.isFinite(rate) && rate > 0 && rate < 0.2;
  const reset = () => {
    setState('');
    setName('');
    setRatePct('');
  };
  const create = useMutation({
    mutationFn: () => createLocalTaxRule({ state: state.toUpperCase(), name: name.trim(), rate }),
    onSuccess: () => {
      toast.success(`${name.trim()} added. Put it on a person from their Pay tab.`);
      reset();
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ['payroll', 'local-tax-rules'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add the rule.'),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a local tax rule</DialogTitle>
          <DialogDescription>A flat rate on gross for one city or county. It applies to the people you put it on, from their Pay tab.</DialogDescription>
        </DialogHeader>
        <form
          id="add-local-rule"
          className="grid gap-3 sm:grid-cols-[6rem_1fr]"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) create.mutate();
          }}
        >
          <Field label="State" hint="Two letters">
            {(p) => <Input value={state} onChange={(e) => setState(e.target.value.slice(0, 2))} maxLength={2} autoComplete="off" {...p} />}
          </Field>
          <Field label="City or county" hint="As the tax is named, with its city">
            {(p) => <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" {...p} />}
          </Field>
          <Field label="Rate (%)" hint="Of gross pay, under 20%" className="sm:col-span-2 sm:max-w-[12rem]">
            {(p) => <Input type="number" inputMode="decimal" step="0.001" min="0" value={ratePct} onChange={(e) => setRatePct(e.target.value)} {...p} />}
          </Field>
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-local-rule" disabled={!valid} loading={create.isPending}>
            Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
