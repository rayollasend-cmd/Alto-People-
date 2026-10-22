import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { listClients } from '@/lib/clientsApi';
import { getVtoPolicy, setVtoPolicy, type VtoPolicy } from '@/lib/vto130Api';
import { Badge, Button, Card, CardContent, ErrorBanner, Field, Input, Select, SkeletonRows } from '@/components/ui';

/**
 * The VTO policy editor (audit Tier 3): the routes (`GET/PUT /vto-policy`)
 * existed and nothing wrote them, so the annual cap and the employer
 * match were settings nobody could set. The org default is one policy;
 * a client can carry its own, which wins for that client's people.
 */

const ORG = '__org__';

export function VtoPolicyEditor() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<string>(ORG);
  const clientId = scope === ORG ? undefined : scope;

  const clientsQuery = useQuery({ queryKey: ['clients', 'vto-policy-picker'], queryFn: () => listClients({ limit: 200 }), retry: false });
  const policyQuery = useQuery({ queryKey: ['vto', 'policy', clientId ?? null], queryFn: () => getVtoPolicy(clientId) });

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">Volunteer time policy</div>
            <p className="mt-1 text-sm text-silver">
              The yearly cap on paid volunteer hours and the employer match per hour. A client policy overrides the org default for that client's people.
            </p>
          </div>
          <div className="w-56">
            <Field label="Applies to">
              {(p) => (
                <Select {...p} size="sm" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value={ORG}>Org default</option>
                  {(clientsQuery.data?.clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </div>
        {policyQuery.isError ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void policyQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {policyQuery.error instanceof ApiError ? policyQuery.error.message : 'Could not load the policy.'}
          </ErrorBanner>
        ) : !policyQuery.data ? (
          <SkeletonRows count={3} />
        ) : (
          <PolicyForm
            key={scope}
            clientId={clientId ?? null}
            policy={policyQuery.data}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ['vto', 'policy'] });
              void qc.invalidateQueries({ queryKey: ['VtoHome'] });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PolicyForm({ clientId, policy, onSaved }: { clientId: string | null; policy: VtoPolicy; onSaved: () => void }) {
  const own = policy.policy;
  const [cap, setCap] = useState(own?.annualHoursCap ?? policy.effective.annualHoursCap);
  const [ratio, setRatio] = useState(own?.matchRatio ?? policy.effective.matchRatio);
  const [currency, setCurrency] = useState(own?.matchCurrency ?? policy.effective.matchCurrency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCap(own?.annualHoursCap ?? policy.effective.annualHoursCap);
    setRatio(own?.matchRatio ?? policy.effective.matchRatio);
    setCurrency(own?.matchCurrency ?? policy.effective.matchCurrency);
  }, [own, policy.effective]);

  const capNum = Number(cap);
  const ratioNum = Number(ratio);
  const capError = !Number.isFinite(capNum) || capNum <= 0 ? 'Enter the yearly cap in hours (more than 0).' : null;
  const ratioError = !Number.isFinite(ratioNum) || ratioNum < 0 ? 'Enter the match per hour (0 for none).' : null;
  const currencyError = !/^[A-Za-z]{3}$/.test(currency) ? 'Three-letter currency code, like USD.' : null;

  const save = async () => {
    if (capError || ratioError || currencyError || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setVtoPolicy({ clientId, annualHoursCap: capNum, matchRatio: ratioNum, matchCurrency: currency.toUpperCase() });
      toast.success(clientId ? 'Client policy saved.' : 'Org default saved.');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the policy.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="vto-policy-form"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-silver">
        {own ? (
          <Badge variant="success">{clientId ? 'Client policy set' : 'Org default set'}</Badge>
        ) : (
          <Badge variant="default">{clientId ? 'Using the org default' : 'Built-in default'}</Badge>
        )}
        <span>
          In effect: {policy.effective.annualHoursCap} h/year · {policy.effective.matchCurrency} {policy.effective.matchRatio}/hour
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Annual hours cap" required error={capError ?? undefined}>
          {(p) => <Input {...p} type="number" min={1} max={9999} step="0.5" value={cap} onChange={(e) => setCap(e.target.value)} />}
        </Field>
        <Field label="Match per hour" required hint="Paid to the cause for each approved hour." error={ratioError ?? undefined}>
          {(p) => <Input {...p} type="number" min={0} max={9999} step="0.01" value={ratio} onChange={(e) => setRatio(e.target.value)} />}
        </Field>
        <Field label="Currency" required error={currencyError ?? undefined}>
          {(p) => <Input {...p} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}
        </Field>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex justify-end">
        <Button type="submit" loading={saving} disabled={saving || !!capError || !!ratioError || !!currencyError}>
          {clientId ? 'Save client policy' : 'Save org default'}
        </Button>
      </div>
    </form>
  );
}
