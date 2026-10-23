import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UNVERIFIED_PAYOUT_POLICY_LABELS, type UnverifiedPayoutPolicy } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { errorText } from '@/lib/errorText';
import { getOrgBranding, patchOrgBranding } from '@/lib/brandingApi';
import { ORG_SETTINGS_KEY } from '@/lib/orgSettingsKey';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsSection } from '@/components/templates';
import { SettingsSaveBar } from '@/pages/settings/SettingsSaveBar';

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

interface Draft {
  financeMailbox: string;
  unverifiedPayoutPolicy: UnverifiedPayoutPolicy;
  remitToName: string;
  remitToAddress: string;
  remitToInstructions: string;
  cashMinimum: string;
}

/**
 * Settings & trust › Finance (F500 G4): where Finance's own settings live —
 * the mailbox every financial alert also goes to, what payroll does with an
 * unverified bank change, the remit-to printed on invoices, and the cash
 * floor the forecast draws. They used to sit on Branding.
 */
export function FinanceSettingsPage() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ORG_SETTINGS_KEY, queryFn: () => getOrgBranding() });
  const saved = useMemo<Draft | null>(
    () =>
      q.data
        ? {
            financeMailbox: q.data.financeMailbox ?? '',
            unverifiedPayoutPolicy: q.data.unverifiedPayoutPolicy,
            remitToName: q.data.remitToName ?? '',
            remitToAddress: q.data.remitToAddress ?? '',
            remitToInstructions: q.data.remitToInstructions ?? '',
            cashMinimum: q.data.cashMinimum === null || q.data.cashMinimum === undefined ? '' : String(q.data.cashMinimum),
          }
        : null,
    [q.data],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => setDraft(saved), [saved]);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => d && { ...d, [k]: v });

  const dirty = saved && draft ? (Object.keys(saved) as Array<keyof Draft>).filter((k) => String(saved[k]).trim() !== String(draft[k]).trim()).length : 0;
  const mailboxOk = !draft || draft.financeMailbox.trim() === '' || EMAIL.test(draft.financeMailbox.trim());
  const cash = draft && draft.cashMinimum.trim() !== '' ? Number(draft.cashMinimum) : null;
  const cashOk = cash === null || (Number.isFinite(cash) && cash >= 0);

  const save = async () => {
    if (!draft || !mailboxOk || !cashOk) return;
    setSaving(true);
    try {
      const updated = await patchOrgBranding({
        financeMailbox: draft.financeMailbox.trim() || null,
        unverifiedPayoutPolicy: draft.unverifiedPayoutPolicy,
        remitToName: draft.remitToName.trim() || null,
        remitToAddress: draft.remitToAddress.trim() || null,
        remitToInstructions: draft.remitToInstructions.trim() || null,
        cashMinimum: cash,
      });
      qc.setQueryData(ORG_SETTINGS_KEY, updated);
      toast.success('Finance settings saved.');
    } catch (err) {
      toast.error(errorText(err, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  };

  const off = !canManage || saving;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Finance"
        subtitle="Where financial alerts go, what payroll does with an unverified bank change, what invoices print to be paid, and the cash floor."
        related={[{ label: 'Approval rules', to: '/admin/approvals' }]}
      />
      {q.isError ? (
        <QueryError what="the finance settings" query={q} />
      ) : !draft ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <SettingsSection title="Alerts" description="Every financial-change alert (bank, pay card, W-4, name, SSN, address) and every payroll packet download is also emailed here, so an alert never depends on one person's inbox.">
            <Field label="Finance mailbox" error={!mailboxOk ? 'Use a bare address like finance@example.com.' : undefined}>
              {(p) => <Input {...p} type="email" value={draft.financeMailbox} onChange={(e) => set('financeMailbox', e.target.value)} placeholder="finance@example.com" disabled={off} className="max-w-md" />}
            </Field>
          </SettingsSection>

          <SettingsSection title="Unverified bank change at the payroll cutoff" description="A new pay account is not used until Finance verifies it by phone. If that has not happened by the cutoff, payroll pays the previous verified account or holds that person's pay. A high-risk change is always held.">
            <SegmentedControl<UnverifiedPayoutPolicy>
              options={(['PREVIOUS_VERIFIED', 'HOLD'] as const).map((v) => ({ value: v, label: UNVERIFIED_PAYOUT_POLICY_LABELS[v] }))}
              value={draft.unverifiedPayoutPolicy}
              onChange={(v) => !off && set('unverifiedPayoutPolicy', v)}
              ariaLabel="Unverified bank change policy"
            />
          </SettingsSection>

          <SettingsSection title="Remit to" description="Printed on every invoice and statement, and on the stub returned with a check.">
            <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
              <Field label="Pay to the order of" hint="Empty: the employer of record's legal name.">
                {(p) => <Input {...p} value={draft.remitToName} maxLength={255} placeholder="Your company LLC" onChange={(e) => set('remitToName', e.target.value)} disabled={off} />}
              </Field>
              <Field label="How to pay" hint="Printed under “How to pay” on each invoice: the bank and routing for ACH, for example.">
                {(p) => <Input {...p} value={draft.remitToInstructions} maxLength={500} placeholder="ACH to Gulf Bank, routing 011000015, account ending 4410" onChange={(e) => set('remitToInstructions', e.target.value)} disabled={off} />}
              </Field>
              <Field label="Remit-to address" hint="One line per row: where checks go. Empty: the employer of record's address.">
                {(p) => <Textarea {...p} rows={3} maxLength={500} value={draft.remitToAddress} placeholder={'PO Box 12\nSpringfield, IL 62701'} onChange={(e) => set('remitToAddress', e.target.value)} disabled={off} />}
              </Field>
            </div>
          </SettingsSection>

          <SettingsSection title="Cash floor" description="The cash forecast shades the band under this amount and says when the balance dips below it.">
            <Field label="Amount" hint="Empty: no floor." error={!cashOk ? 'An amount of zero or more.' : undefined}>
              {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="100" className="w-48" value={draft.cashMinimum} placeholder="25000" onChange={(e) => set('cashMinimum', e.target.value)} disabled={off} />}
            </Field>
          </SettingsSection>

          {canManage ? (
            <SettingsSaveBar dirty={dirty} saving={saving} disabled={!mailboxOk || !cashOk} onSave={() => void save()} onDiscard={() => setDraft(saved)} />
          ) : (
            <p className="text-sm text-ink-muted">Only an administrator of the organization changes these.</p>
          )}
        </>
      )}
    </div>
  );
}
