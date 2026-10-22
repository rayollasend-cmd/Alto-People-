import { useEffect, useState, type ReactNode } from 'react';
import { Building2, Pencil, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatus, ClientSummary, ClientUpdateInput } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { updateClient } from '@/lib/clientsApi';
import { statusLabel, StatusBadge } from '@/lib/status';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';

/**
 * Basics, read first: who the client is on paper — name, legal name,
 * industry, status, contact email, billing address, PO and payment terms —
 * as a definition list. Edit (manage:clients) turns it into the form;
 * Save stays off until something changed, Cancel puts the record back.
 * The configuration that used to crowd this card lives in Settings.
 */

const STATUSES: ClientStatus[] = ['PROSPECT', 'ACTIVE', 'INACTIVE'];

interface Form {
  name: string;
  legalName: string;
  industry: string;
  status: ClientStatus;
  contactEmail: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  zip: string;
  poNumber: string;
  paymentTermsDays: string;
}

const formOf = (c: ClientSummary): Form => ({
  name: c.name,
  legalName: c.legalName ?? '',
  industry: c.industry ?? '',
  status: c.status,
  contactEmail: c.contactEmail ?? '',
  addressLine1: c.addressLine1 ?? '',
  addressLine2: c.addressLine2 ?? '',
  city: c.city ?? '',
  zip: c.zip ?? '',
  poNumber: c.poNumber ?? '',
  paymentTermsDays: String(c.paymentTermsDays ?? 30),
});

/** "Net 30", or "Due on receipt" at zero. */
export function termsLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  return days === 0 ? 'Due on receipt' : `Net ${days}`;
}

/** The billing address as lines: street, suite, "City, ST 12345". */
export function addressLines(c: Pick<ClientSummary, 'addressLine1' | 'addressLine2' | 'city' | 'state' | 'zip'>): string[] {
  const place = [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [c.addressLine1, c.addressLine2, place].filter((l): l is string => !!l && l.trim().length > 0);
}

export function ClientBasicsCard({
  client,
  canManage,
  editing,
  onEditingChange,
  onSaved,
}: {
  client: ClientSummary;
  canManage: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSaved: (c: ClientSummary) => void;
}) {
  const [form, setForm] = useState<Form>(() => formOf(client));
  const [saving, setSaving] = useState(false);
  const initial = formOf(client);

  // A fresh record (a save elsewhere, another client's URL) resets the form while it is closed.
  useEffect(() => {
    if (!editing) setForm(formOf(client));
  }, [client, editing]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = (Object.keys(form) as Array<keyof Form>).some((k) => form[k].trim() !== initial[k].trim());
  const terms = Number(form.paymentTermsDays);

  const cancel = () => {
    setForm(formOf(client));
    onEditingChange(false);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('A client needs a name.');
      return;
    }
    if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
      toast.error('Payment terms are a whole number of days, 0 to 365.');
      return;
    }
    const n = (s: string) => s.trim() || null;
    const body: ClientUpdateInput = {
      name: form.name.trim(),
      legalName: n(form.legalName),
      industry: n(form.industry),
      status: form.status,
      contactEmail: n(form.contactEmail),
      addressLine1: n(form.addressLine1),
      addressLine2: n(form.addressLine2),
      city: n(form.city),
      zip: n(form.zip),
      poNumber: n(form.poNumber),
      paymentTermsDays: terms,
    };
    setSaving(true);
    try {
      const updated = await updateClient(client.id, body);
      onSaved(updated);
      onEditingChange(false);
      toast.success('Client saved.');
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
    }
  };

  const address = addressLines(client);

  return (
    <Card>
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle
          icon={Building2}
          title="Basics"
          description={editing ? 'Who the client is on paper. Work-site state, the scheduling week and exports are in Settings.' : undefined}
          trailing={
            canManage && !editing ? (
              <Button size="sm" variant="outline" onClick={() => onEditingChange(true)}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            ) : undefined
          }
        />
        {!editing ? (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 text-sm sm:grid-cols-2" data-testid="client-basics-read">
            <Item label="Name">{client.name}</Item>
            <Item label="Legal name">{client.legalName || <Missing>Same as the name</Missing>}</Item>
            <Item label="Industry">{client.industry || <Missing>Not set</Missing>}</Item>
            <Item label="Status">
              <StatusBadge status={client.status} />
            </Item>
            <Item label="Contact email">
              {client.contactEmail ? (
                <a href={`mailto:${client.contactEmail}`} className="break-all text-accent hover:underline">
                  {client.contactEmail}
                </a>
              ) : (
                <Missing>None on file</Missing>
              )}
            </Item>
            <Item label="Billing address">
              {address.length ? (
                <span className="whitespace-pre-line">{address.join('\n')}</span>
              ) : (
                <Missing>None on file</Missing>
              )}
            </Item>
            <Item label="PO number">{client.poNumber || <Missing>No standing PO</Missing>}</Item>
            <Item label="Payment terms">{termsLabel(client.paymentTermsDays)}</Item>
          </dl>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name" required>
                {(p) => <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus {...p} />}
              </Field>
              <Field label="Legal name" hint="As registered; prints on statements and tax forms.">
                {(p) => <Input value={form.legalName} onChange={(e) => set('legalName', e.target.value)} maxLength={255} {...p} />}
              </Field>
              <Field label="Industry">
                {(p) => <Input value={form.industry} onChange={(e) => set('industry', e.target.value)} maxLength={80} {...p} />}
              </Field>
              <Field label="Status">
                {(p) => (
                  <Select value={form.status} onChange={(e) => set('status', e.target.value as ClientStatus)} {...p}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Contact email" hint="The account's general address. People go under Contacts.">
                {(p) => <Input type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} maxLength={254} {...p} />}
              </Field>
              <Field label="Address line 1">
                {(p) => <Input value={form.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} maxLength={255} autoComplete="address-line1" {...p} />}
              </Field>
              <Field label="Address line 2">
                {(p) => <Input value={form.addressLine2} onChange={(e) => set('addressLine2', e.target.value)} maxLength={255} autoComplete="address-line2" {...p} />}
              </Field>
              <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
                <Field label="City">
                  {(p) => <Input value={form.city} onChange={(e) => set('city', e.target.value)} maxLength={120} autoComplete="address-level2" {...p} />}
                </Field>
                <Field label="ZIP">
                  {(p) => <Input value={form.zip} onChange={(e) => set('zip', e.target.value)} maxLength={10} inputMode="numeric" autoComplete="postal-code" {...p} />}
                </Field>
              </div>
              <Field label="PO number" hint="Prints on every statement unless a statement carries its own.">
                {(p) => <Input value={form.poNumber} onChange={(e) => set('poNumber', e.target.value)} maxLength={60} {...p} />}
              </Field>
              <Field label="Payment terms (days)" hint="0 is due on receipt. Each statement falls due this many days after it is finalized.">
                {(p) => <Input type="number" min={0} max={365} step={1} inputMode="numeric" value={form.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} {...p} />}
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" disabled={!dirty} loading={saving}>
                <Save className="h-4 w-4" />
                Save
              </Button>
              <Button type="button" variant="outline" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs2 font-medium uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="mt-1 break-words text-ink">{children}</dd>
    </div>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-ink-muted">{children}</span>;
}
