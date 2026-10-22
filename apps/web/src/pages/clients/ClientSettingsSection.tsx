import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, FileOutput, MapPin, Percent, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getClientDunning, setClientState, updateClient, updateClientBillingTerms } from '@/lib/clientsApi';
import { clientOverviewKey, getClientOverview } from '@/lib/clientAccountApi';
import { setClientMargin } from '@/lib/marketRatesApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';

/**
 * Settings: how the client is configured, apart from who it is (Basics)
 * and how it is doing (Overview). The scheduling week, the work-site state
 * the labor rules key on, billing (sales tax, the margin its rates are
 * priced to) and the exports (Fieldglass). ?section=state lands here.
 */

// Index = the 0=Sunday…6=Saturday convention Client.weekStartsOn uses.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Two-letter US state codes that have either OT/break rules or predictive
// scheduling; the select doubles as a shortcut for the states the engine
// actually does something with.
const POLICY_STATES = ['CA', 'NY', 'IL', 'MA', 'NJ', 'PA', 'WA', 'CO', 'AZ', 'GA', 'NC', 'VA', 'FL', 'TX', 'OR'] as const;

export function ClientSettingsSection({
  client,
  onSaved,
  onOpenTab,
}: {
  client: ClientSummary;
  onSaved: (c: ClientSummary) => void;
  onOpenTab: (key: string) => void;
}) {
  const { can } = useAuth();
  const canManage = can('manage:clients');
  const canSeeMoney = can('process:payroll') || can('view:executive');
  return (
    <div className="space-y-6" data-testid="client-settings">
      <div className="grid gap-6 lg:grid-cols-2">
        <WeekCard client={client} canManage={canManage} onSaved={onSaved} />
        <StateEditor client={client} canManage={canManage} onSaved={onSaved} />
      </div>
      {canSeeMoney && <BillingCard clientId={client.id} />}
      <ExportsCard client={client} canManage={canManage} canSeeMoney={canSeeMoney} onSaved={onSaved} onOpenTab={onOpenTab} />
    </div>
  );
}

function SaveButton({ dirty, saving, onClick }: { dirty: boolean; saving: boolean; onClick: () => void }) {
  return (
    <Button size="sm" onClick={onClick} disabled={!dirty} loading={saving}>
      <Save className="h-3.5 w-3.5" />
      Save
    </Button>
  );
}

/* ----- The scheduling week ------------------------------------------------- */

function WeekCard({ client, canManage, onSaved }: { client: ClientSummary; canManage: boolean; onSaved: (c: ClientSummary) => void }) {
  const current = client.weekStartsOn ?? 0;
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(current), [current]);
  const save = async () => {
    setSaving(true);
    try {
      onSaved(await updateClient(client.id, { weekStartsOn: value }));
      toast.success(`Weeks start on ${WEEKDAY_NAMES[value]}.`);
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle as="h3" icon={CalendarDays} title="Scheduling week" description="The day this client's week starts. Hours on the overview count from it, and associates get their week-ahead digest the evening before." />
        <div className="space-y-3">
          <Field label="Week starts on">
            {(p) => (
              <Select disabled={!canManage} value={String(value)} onChange={(e) => setValue(Number(e.target.value))} {...p}>
                {WEEKDAY_NAMES.map((label, i) => (
                  <option key={label} value={String(i)}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {canManage && <SaveButton dirty={value !== current} saving={saving} onClick={() => void save()} />}
        </div>
      </CardContent>
    </Card>
  );
}

/* ----- Work-site state ----------------------------------------------------- */

function StateEditor({ client, canManage, onSaved }: { client: ClientSummary; canManage: boolean; onSaved: (c: ClientSummary) => void }) {
  const [value, setValue] = useState(client.state ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(client.state ?? ''), [client.state]);
  const dirty = (value || null) !== (client.state || null);
  const save = async () => {
    setSaving(true);
    try {
      onSaved(await setClientState(client.id, { state: value ? value.toUpperCase() : null }));
      toast.success('Work-site state saved.');
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof Error ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card id="state" className="scroll-mt-24">
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle
          as="h3"
          icon={MapPin}
          title="Work-site state"
          description="Drives overtime thresholds, meal-break minimums, sick-leave accrual and fair-workweek notice. Blank is the federal default."
        />
        <div className="space-y-3">
          <Field label="State" hint={`States with policy templates: ${POLICY_STATES.join(', ')}.`}>
            {(p) => (
              <Select disabled={!canManage} value={value} onChange={(e) => setValue(e.target.value)} {...p}>
                <option value="">Federal default</option>
                {POLICY_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {canManage && <SaveButton dirty={dirty} saving={saving} onClick={() => void save()} />}
        </div>
      </CardContent>
    </Card>
  );
}

/* ----- Billing: sales tax and target margin (statements readers) ------------ */

function BillingCard({ clientId }: { clientId: string }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canEditTax = can('process:payroll');
  const canEditMargin = can('manage:clients') || can('process:payroll');
  const dunning = useQuery({ queryKey: ['clients', clientId, 'dunning'], queryFn: () => getClientDunning(clientId) });
  const overview = useQuery({ queryKey: clientOverviewKey(clientId), queryFn: () => getClientOverview(clientId) });

  const taxOn = !!dunning.data?.salesTaxable;
  const rateOn = dunning.data?.salesTaxRatePct ?? null;
  const [taxable, setTaxable] = useState(false);
  const [rate, setRate] = useState('');
  useEffect(() => {
    setTaxable(taxOn);
    setRate(rateOn !== null ? String(rateOn) : '');
  }, [taxOn, rateOn]);
  const taxDirty = taxable !== taxOn || (taxable && Number(rate) !== (rateOn ?? NaN));

  const target = overview.data?.kpis?.money?.targetMarginPct ?? null;
  const [margin, setMargin] = useState('');
  useEffect(() => setMargin(target !== null ? String(target) : ''), [target]);
  const marginValue = margin.trim() === '' ? null : Number(margin);
  const marginDirty = marginValue !== target;

  const [saving, setSaving] = useState<'tax' | 'margin' | null>(null);

  const saveTax = async () => {
    if (taxable && !(Number(rate) > 0 && Number(rate) <= 100)) {
      toast.error('A taxable client needs a sales tax rate above zero.');
      return;
    }
    setSaving('tax');
    try {
      await updateClientBillingTerms(clientId, { salesTaxable: taxable, salesTaxRatePct: taxable ? Number(rate) : null });
      toast.success(taxable ? `Sales tax ${Number(rate)}% on this client's statements.` : 'No sales tax on this client’s statements.');
      await queryClient.invalidateQueries({ queryKey: ['clients', clientId, 'dunning'] });
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(null);
    }
  };

  const saveMargin = async () => {
    if (marginValue !== null && !(marginValue >= 0 && marginValue < 100)) {
      toast.error('A target margin is a percent from 0 to 99.');
      return;
    }
    setSaving('margin');
    try {
      await setClientMargin(clientId, marginValue);
      toast.success(marginValue === null ? 'Target margin cleared.' : `Target margin ${marginValue}%.`);
      await queryClient.invalidateQueries({ queryKey: clientOverviewKey(clientId) });
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle as="h3" icon={Percent} title="Billing" description="Sales tax on this client's statements, and the margin its bill rates are priced to." />
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col items-start gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="h-4 w-4 accent-gold" disabled={!canEditTax || !dunning.data} checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
              Charge sales tax
            </label>
            {taxable && (
              <Field label="Sales tax rate (%)">
                {(p) => <Input type="number" min={0} max={100} step="0.001" inputMode="decimal" disabled={!canEditTax} value={rate} onChange={(e) => setRate(e.target.value)} className="max-w-[10rem]" {...p} />}
              </Field>
            )}
            {canEditTax ? (
              <SaveButton dirty={!!dunning.data && taxDirty} saving={saving === 'tax'} onClick={() => void saveTax()} />
            ) : (
              <p className="text-xs text-ink-muted">Payroll sets sales tax.</p>
            )}
          </div>
          <div className="flex flex-col items-start gap-3">
            <Field label="Target margin (%)" hint="What the bill rates are priced to; the overview's margin is read against it.">
              {(p) => <Input type="number" min={0} max={99} step="0.1" inputMode="decimal" disabled={!canEditMargin || !overview.data} value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="None set" className="max-w-[10rem]" {...p} />}
            </Field>
            {canEditMargin && <SaveButton dirty={!!overview.data && marginDirty} saving={saving === 'margin'} onClick={() => void saveMargin()} />}
          </div>
        </div>
        <p className="mt-4 border-t border-line pt-3 text-xs text-ink-muted">
          State unemployment (SUTA) rates are not set per client here; W-2 employers carry theirs on the employer record
          {can('view:org') ? (
            <>
              {' '}
              in{' '}
              <Link to="/admin/employers" className="text-accent hover:underline">
                Employers
              </Link>
            </>
          ) : null}
          .
        </p>
      </CardContent>
    </Card>
  );
}

/* ----- Exports: Fieldglass -------------------------------------------------- */

function ExportsCard({
  client,
  canManage,
  canSeeMoney,
  onSaved,
  onOpenTab,
}: {
  client: ClientSummary;
  canManage: boolean;
  canSeeMoney: boolean;
  onSaved: (c: ClientSummary) => void;
  onOpenTab: (key: string) => void;
}) {
  const [site, setSite] = useState(client.fieldglassSiteName ?? '');
  const [rate, setRate] = useState(client.fieldglassBillRate != null ? String(client.fieldglassBillRate) : '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSite(client.fieldglassSiteName ?? '');
    setRate(client.fieldglassBillRate != null ? String(client.fieldglassBillRate) : '');
  }, [client.fieldglassSiteName, client.fieldglassBillRate]);
  const rateParsed = rate.trim() === '' ? null : Number(rate);
  const dirty = (site.trim() || null) !== (client.fieldglassSiteName || null) || (canSeeMoney && rateParsed !== (client.fieldglassBillRate ?? null));

  const save = async () => {
    if (rateParsed !== null && !(rateParsed >= 0)) {
      toast.error('The Fieldglass bill rate is a number of dollars, 0 or more.');
      return;
    }
    setSaving(true);
    try {
      onSaved(await updateClient(client.id, { fieldglassSiteName: site.trim() || null, ...(canSeeMoney ? { fieldglassBillRate: rateParsed } : {}) }));
      toast.success('Export settings saved.');
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle as="h3" icon={FileOutput} title="Exports" description="How this client appears on files you hand to other systems." />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="Fieldglass site name"
            hint='The SAP Fieldglass "Site" label, letter for letter (e.g. "1 - Onsite - FL - Destin"). Blank uses the store or client name on the timesheet export.'
          >
            {(p) => <Input value={site} onChange={(e) => setSite(e.target.value)} maxLength={255} placeholder="1 - Onsite - FL - Destin" disabled={!canManage} {...p} />}
          </Field>
          {canSeeMoney && (
            <Field
              label="Fieldglass bill rate ($/h)"
              hint={
                <>
                  Only on the Fieldglass timesheet export (Amount = rate × hours). What you bill lives in{' '}
                  <button type="button" className="text-accent hover:underline" onClick={() => onOpenTab('rates')}>
                    Rates
                  </button>
                  .
                </>
              }
            >
              {(p) => <Input type="number" min={0} step="0.01" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="21.21" disabled={!canManage} {...p} />}
            </Field>
          )}
        </div>
        {canManage && (
          <div className="mt-4">
            <SaveButton dirty={dirty} saving={saving} onClick={() => void save()} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
