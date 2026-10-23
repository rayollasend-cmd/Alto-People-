import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SettingsSection } from '@/components/templates';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * Brief 2-5 step 7 — who hears the security alerts by email: failed
 * sign-in bursts, a locked account under attack, two-step sign-in turned
 * off on an admin, privilege grants, unusual exports. The operator's org
 * admins also see them in the bell. A settings section at the foot of
 * Compliance evidence (F500 G4: status first, configuration last).
 */
export function SecurityContactCard({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['compliance-evidence', 'security-contact'], queryFn: () => apiFetch<{ email: string | null }>('/admin/security-contact') });
  const [email, setEmail] = useState('');
  useEffect(() => setEmail(q.data?.email ?? ''), [q.data?.email]);
  const save = async () => {
    try {
      await apiFetch('/admin/security-contact', { method: 'PUT', body: { email: email.trim() || null } });
      toast.success('Saved.');
      await qc.invalidateQueries({ queryKey: ['compliance-evidence'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    }
  };
  const set = !!q.data?.email;
  return (
    <SettingsSection
      id="security-contact"
      title="Security contact"
      description="Hears every security alert by email. Without one, the three alerting controls cannot pass."
      status={q.data ? <Badge variant={set ? 'success' : 'pending'} size="sm" withDot={false}>{set ? 'Set' : 'Not set'}</Badge> : undefined}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Email" className="w-full sm:w-72">
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!canManage} placeholder="security@yourcompany.com" />}
        </Field>
        {canManage && (
          <Button size="sm" onClick={() => void save()} disabled={(q.data?.email ?? '') === email.trim()}>
            Save
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}
