import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MFA_REQUIREMENT_VALUES, type MfaRequirement } from '@alto-people/shared';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { errorText } from '@/lib/errorText';
import { getOrgBranding, patchOrgBranding } from '@/lib/brandingApi';
import { ORG_SETTINGS_KEY } from '@/lib/orgSettingsKey';
import { Badge } from '@/components/ui/Badge';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsSection } from '@/components/templates';

const LABELS: Record<MfaRequirement, string> = { OFF: 'Off', ADMINS: 'Admins', ALL: 'Everyone' };
const STATUS: Record<MfaRequirement, string> = { OFF: 'Optional', ADMINS: 'Required for admins', ALL: 'Required for everyone' };

/**
 * Sign-in › Two-step sign-in (F500 G4: it lived on Branding, where a search
 * for "two-step" or "MFA" found nothing). Saves the moment it is changed —
 * one switch, one decision, said back in a toast.
 */
export function TwoStepSection() {
  const { can } = useAuth();
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ORG_SETTINGS_KEY, queryFn: () => getOrgBranding() });
  const [saving, setSaving] = useState(false);
  const current = q.data?.mfaRequirement ?? 'OFF';

  const change = async (next: MfaRequirement) => {
    if (next === current || saving) return;
    setSaving(true);
    try {
      const updated = await patchOrgBranding({ mfaRequirement: next });
      qc.setQueryData(ORG_SETTINGS_KEY, updated);
      toast.success(next === 'OFF' ? 'Two-step sign-in is now optional for everyone.' : `Two-step sign-in is now required for ${next === 'ALL' ? 'everyone' : 'admin roles'}.`);
    } catch (err) {
      toast.error(errorText(err, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      id="two-step"
      title="Two-step sign-in"
      description={
        <>
          Who must set up an authenticator app before a password sign-in completes. “Admins” covers every role that can manage other people’s data (including finance and shift
          supervisors); {term('workers').toLowerCase()}
          {hasClients ? ' and client portal accounts are' : ' are'} exempt. Passkeys already count as strong sign-in and are never blocked.
        </>
      }
      status={q.data ? <Badge variant={current === 'OFF' ? 'default' : 'success'}>{STATUS[current]}</Badge> : undefined}
    >
      {q.isError ? (
        <QueryError what="the two-step setting" query={q} />
      ) : !q.data ? (
        <Skeleton className="h-9 w-64" />
      ) : (
        <SegmentedControl<MfaRequirement>
          options={MFA_REQUIREMENT_VALUES.map((v) => ({ value: v, label: LABELS[v] }))}
          value={current}
          onChange={(v) => can('manage:org') && void change(v)}
          ariaLabel="Require two-step sign-in"
        />
      )}
    </SettingsSection>
  );
}
