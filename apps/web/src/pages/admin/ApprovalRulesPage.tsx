import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth, useTenant } from '@/lib/auth';
import { errorText } from '@/lib/errorText';
import { getOrgBranding, patchOrgBranding } from '@/lib/brandingApi';
import { ORG_SETTINGS_KEY } from '@/lib/orgSettingsKey';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsSection } from '@/components/templates';
import { SettingsSaveBar } from '@/pages/settings/SettingsSaveBar';

type Rules = {
  payChangeApprovalPct: number;
  payChangeAlwaysApprove: boolean;
  billRateApproval: boolean;
  separationSecondPerson: boolean;
  selfServiceApproval: boolean;
  roleChangeApproval: boolean;
  requisitionApproval: boolean;
  payrollReviewRequired: boolean;
};
const SWITCHES: ReadonlyArray<readonly [keyof Rules, string, string]> = [
  ['payrollReviewRequired', 'Paying a payroll run', 'Someone reads the review report and signs off before money moves.'],
  ['billRateApproval', 'Bill-rate changes', 'A dated rate card, approved by Finance.'],
  ['separationSecondPerson', 'Completing a separation', 'Access ends only when a second person says so.'],
  ['roleChangeApproval', 'Granting more access', 'A role elevation, or a new staff account, waits for a second administrator.'],
  ['requisitionApproval', 'Opening a seat', 'A requisition carries its budget to a second person.'],
  ['selfServiceApproval', 'Self-service address and dependents', 'Off by default: a person changes their own record at once.'],
];

/**
 * Settings & trust › Approval rules (F500 G4). Which changes take a second
 * person before they land — the maker-checker switches. They used to sit
 * on Branding, where nobody looking for approvals thought to look; the
 * record of every request they produce is the Approval record next door.
 */
export function ApprovalRulesPage() {
  const { can } = useAuth();
  // Bill rates are a module; with it off the switch is not this organization's business.
  const billRates = useTenant().moduleOn('billRates');
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ORG_SETTINGS_KEY, queryFn: () => getOrgBranding() });
  const saved = useMemo<Rules | null>(
    () =>
      q.data
        ? {
            payChangeApprovalPct: q.data.payChangeApprovalPct,
            payChangeAlwaysApprove: q.data.payChangeAlwaysApprove,
            billRateApproval: q.data.billRateApproval,
            separationSecondPerson: q.data.separationSecondPerson,
            selfServiceApproval: q.data.selfServiceApproval,
            roleChangeApproval: q.data.roleChangeApproval,
            requisitionApproval: q.data.requisitionApproval,
            payrollReviewRequired: q.data.payrollReviewRequired,
          }
        : null,
    [q.data],
  );
  const [rules, setRules] = useState<Rules | null>(null);
  useEffect(() => setRules(saved), [saved]);
  const [saving, setSaving] = useState(false);
  const dirty = saved && rules ? (Object.keys(saved) as Array<keyof Rules>).filter((k) => saved[k] !== rules[k]).length : 0;

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    try {
      const updated = await patchOrgBranding(rules);
      qc.setQueryData(ORG_SETTINGS_KEY, updated);
      toast.success('Approval rules saved.');
    } catch (err) {
      toast.error(errorText(err, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Approval rules"
        subtitle="Which changes take a second person before they land. The person who asks never decides; where no second person exists, the change lands and the audit says so."
        related={[
          { label: 'Approval record', to: '/audit/approvals' },
          { label: 'Roles & permissions', to: '/admin/roles' },
        ]}
      />
      {q.isError ? (
        <QueryError what="the approval rules" query={q} />
      ) : !rules ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <SettingsSection title="Pay-rate changes" description="A change this far from the current rate goes to a second person.">
            <Field label="Threshold" hint="In percent. 0 sends every change.">
              {(p) => (
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    {...p}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    className="w-24"
                    value={rules.payChangeApprovalPct}
                    onChange={(e) => setRules((r) => r && { ...r, payChangeApprovalPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                    disabled={!canManage || rules.payChangeAlwaysApprove}
                  />
                  <span className="text-sm text-ink-muted">%</span>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={rules.payChangeAlwaysApprove} disabled={!canManage} onChange={(e) => setRules((r) => r && { ...r, payChangeAlwaysApprove: e.target.checked })} />
                    Every change
                  </label>
                </div>
              )}
            </Field>
          </SettingsSection>
          <SettingsSection title="Other changes that need a second person">
            <div className="grid gap-2 sm:grid-cols-2">
              {SWITCHES.filter(([key]) => key !== 'billRateApproval' || billRates).map(([key, label, hint]) => (
                <label key={key} className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={rules[key] as boolean} disabled={!canManage} onChange={(e) => setRules((r) => r && { ...r, [key]: e.target.checked })} aria-label={label} />
                  <span>
                    <span className="block text-ink">{label}</span>
                    <span className="block text-xs2 text-ink-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </SettingsSection>
          {canManage ? (
            <SettingsSaveBar dirty={dirty} saving={saving} onSave={() => void save()} onDiscard={() => setRules(saved)} />
          ) : (
            <p className="text-sm text-ink-muted">
              Only an administrator of the organization changes these. Every request they produce is on the{' '}
              <Link to="/audit/approvals" className="text-accent underline-offset-2 hover:underline">
                Approval record
              </Link>
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}
