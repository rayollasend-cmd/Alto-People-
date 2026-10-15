import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  INTEGRATION_CAPABILITY_LABELS,
  type IntegrationCapability,
  type IntegrationConnectionSummary,
  type IntegrationMapping,
  type IntegrationMappingGroup,
  type IntegrationVendor,
  type IntegrationVendorInfo,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { createIntegrationConnection, patchIntegrationConnection, testIntegrationConnection } from '@/lib/integrationsApi';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SCHEDULE_OPTIONS, vendorLabel } from './shared';

/**
 * Connect a vendor, or change a connection: the vendor and a name, sandbox
 * or live (with the vendor's credential fields, secrets never echoed back),
 * which capabilities run, the schedule, and the field mapping group by
 * group over the vendor's defaults. Saving a new connection runs the sandbox
 * test at once, so the first thing the admin sees is the log.
 */
export function ConnectDrawer({
  open,
  onOpenChange,
  vendors,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendors: IntegrationVendorInfo[];
  /** Editing an existing connection. */
  existing?: IntegrationConnectionSummary;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const [vendor, setVendor] = useState<IntegrationVendor>(existing?.vendor ?? 'FIELDGLASS');
  const info = useMemo(() => vendors.find((v) => v.vendor === vendor) ?? null, [vendors, vendor]);
  const [name, setName] = useState(existing?.name ?? '');
  const [sandbox, setSandbox] = useState(existing?.sandbox ?? true);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState<IntegrationCapability[]>(existing?.capabilities ?? []);
  const [schedule, setSchedule] = useState(existing?.scheduleMinutes ? String(existing.scheduleMinutes) : '');
  const [eventDriven, setEventDriven] = useState(existing?.eventDriven ?? true);
  const [mapping, setMapping] = useState<IntegrationMapping>(existing?.mapping ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new vendor brings its own name, capabilities and mapping.
  useEffect(() => {
    if (existing || !info) return;
    setName((n) => n || info.label);
    setCapabilities(info.capabilities);
    setMapping({});
    setCredentials({});
  }, [info, existing]);

  const groups = (Object.keys(info?.defaultMapping ?? {}) as IntegrationMappingGroup[]);
  const dirty = name !== (existing?.name ?? '') || Object.keys(credentials).length > 0 || JSON.stringify(mapping) !== JSON.stringify(existing?.mapping ?? {});

  const setMapped = (group: IntegrationMappingGroup, alto: string, vendorField: string) => {
    setMapping((m) => {
      const next = { ...m, [group]: { ...(m[group] ?? {}) } };
      const def = info?.defaultMapping[group]?.[alto];
      if (!vendorField.trim() || vendorField.trim() === def) delete next[group]![alto];
      else next[group]![alto] = vendorField.trim();
      if (Object.keys(next[group]!).length === 0) delete next[group];
      return next;
    });
  };

  const save = async (runTest: boolean) => {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim() || info.label,
        sandbox,
        ...(Object.keys(credentials).length ? { credentials } : {}),
        mapping,
        capabilities,
        scheduleMinutes: schedule ? Number(schedule) : null,
        eventDriven,
      };
      const saved = existing ? await patchIntegrationConnection(existing.id, body) : await createIntegrationConnection({ vendor, ...body });
      const id = saved.connection.id;
      if (runTest) {
        const t = await testIntegrationConnection(id);
        const failed = t.results.reduce((a, r) => a + r.failed, 0);
        toast[failed ? 'warning' : 'success'](failed ? `Sandbox test ran: ${failed} record${failed === 1 ? '' : 's'} rejected — see the log.` : 'Sandbox test ran clean.');
      } else {
        toast.success(existing ? 'Connection updated.' : 'Connected.');
      }
      onSaved();
      onOpenChange(false);
      if (!existing) navigate(`/integrations/connections/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} width="max-w-lg" confirmDiscard={dirty}>
      <DrawerHeader>
        <DrawerTitle>{existing ? `Edit ${existing.name}` : 'Connect a system'}</DrawerTitle>
        <DrawerDescription>
          {info ? info.what : 'Pick the vendor to connect.'}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {!existing && (
          <Field label="Vendor" required>
            {(p) => (
              <Select {...p} value={vendor} onChange={(e) => setVendor(e.target.value as IntegrationVendor)}>
                {vendors.map((v) => (
                  <option key={v.vendor} value={v.vendor}>{v.label}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Name" required hint="How this connection is listed; a customer may have more than one of a vendor.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={info?.label} />}
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Mode</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
            <input type="radio" name="mode" className="mt-1 accent-gold" checked={sandbox} onChange={() => setSandbox(true)} />
            <span>
              <span className="block">Sandbox</span>
              <span className="block text-xs text-ink-muted">Replays recorded vendor responses. Proves the mapping; never calls the vendor.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
            <input type="radio" name="mode" className="mt-1 accent-gold" checked={!sandbox} onChange={() => setSandbox(false)} />
            <span>
              <span className="block">Live</span>
              <span className="block text-xs text-ink-muted">{info?.apiNote}</span>
            </span>
          </label>
        </fieldset>

        {!sandbox && info && (
          <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
            <p className="text-xs text-ink-muted">
              {existing?.hasCredentials ? 'Credentials are on file and never shown. Fill a field to replace them all.' : 'Stored encrypted; never shown again.'}
            </p>
            {info.credentialFields.map((f) => (
              <Field key={f.key} label={f.label}>
                {(p) => (
                  <Input
                    {...p}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={credentials[f.key] ?? ''}
                    onChange={(e) => setCredentials((c) => ({ ...c, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
        )}

        {info && (
          <fieldset className="space-y-2">
            <legend className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">What runs</legend>
            {info.capabilities.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-gold"
                  checked={capabilities.includes(c)}
                  onChange={(e) => setCapabilities((caps) => (e.target.checked ? [...caps, c] : caps.filter((x) => x !== c)))}
                />
                {INTEGRATION_CAPABILITY_LABELS[c]}
              </label>
            ))}
          </fieldset>
        )}

        <Field label="Schedule" hint="Events (a shift changed, time approved, payroll finalized) run their capability within a minute either way.">
          {(p) => (
            <Select {...p} value={schedule} onChange={(e) => setSchedule(e.target.value)}>
              {SCHEDULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" className="h-5 w-5 accent-gold" checked={eventDriven} onChange={(e) => setEventDriven(e.target.checked)} />
          Run on events
        </label>

        {info && groups.length > 0 && (
          <div className="space-y-3">
            <div>
              <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-ink-muted">Field mapping</div>
              <p className="mt-1 text-xs text-ink-muted">Alto’s field on the left, {vendorLabel(info.vendor)}’s on the right. The defaults are the vendor’s documented names; change one only where the customer’s instance differs. A dotted name reaches into a nested object.</p>
            </div>
            {groups.map((g) => (
              <div key={g} className="rounded-lg border border-line">
                <div className="border-b border-line px-3 py-1.5 text-xs font-medium capitalize text-ink">{g === 'workOrder' ? 'Work order' : g}</div>
                <div className="divide-y divide-line">
                  {Object.entries(info.defaultMapping[g] ?? {}).map(([alto, def]) => {
                    const current = mapping[g]?.[alto] ?? def;
                    return (
                      <div key={alto} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2 px-3 py-1.5">
                        <span className="truncate font-mono text-xs text-ink-muted">{alto}</span>
                        <Input
                          aria-label={`${g} ${alto} vendor field`}
                          className="h-8 font-mono text-xs"
                          value={current}
                          onChange={(e) => setMapped(g, alto, e.target.value)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <p role="alert" className="text-sm text-alert">{error}</p>}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        {!existing && (
          <Button variant="secondary" onClick={() => void save(false)} loading={busy} disabled={!info}>Save</Button>
        )}
        <Button onClick={() => void save(!existing)} loading={busy} disabled={!info}>
          {existing ? 'Save changes' : 'Save and run sandbox test'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
