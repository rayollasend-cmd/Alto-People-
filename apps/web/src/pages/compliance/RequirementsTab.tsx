import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  createCredentialRequirement,
  listCredentialRequirements,
  removeCredentialRequirement,
  type RequirementKind,
} from '@/lib/credentialRequirementsApi';
import { listSites } from '@/lib/orgApi';
import { listQualifications } from '@/lib/qualApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';

/**
 * Site requirements (agent families step 5): what a site requires everyone
 * placed there to hold. The Compliance agent measures each one weekly,
 * puts the gaps on the desk and asks each person missing it. Nothing is
 * required until it is set here.
 */

const VACCINATIONS = [
  ['TB_TEST', 'TB test'],
  ['INFLUENZA_FLU', 'Flu'],
  ['COVID19', 'COVID-19'],
  ['HEPATITIS_B', 'Hepatitis B'],
  ['TDAP', 'Tdap'],
  ['MMR', 'MMR'],
] as const;
const TRAININGS = [
  ['FOOD_HANDLER', 'Food handler'],
  ['OSHA_SAFETY', 'OSHA safety'],
  ['EEO_HARASSMENT', 'Harassment prevention'],
  ['WALMART_CADE', 'Customer-required training'],
] as const;
const KIND_LABEL: Record<RequirementKind, string> = { VACCINATION: 'Vaccination', TRAINING: 'Training', QUALIFICATION: 'Qualification' };

export function RequirementsTab({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['credentialRequirements', 'list'], queryFn: listCredentialRequirements });
  const sites = useQuery({ queryKey: ['credentialRequirements', 'sites'], queryFn: listSites, enabled: canManage });
  const quals = useQuery({ queryKey: ['credentialRequirements', 'qualifications'], queryFn: () => listQualifications(), enabled: canManage });

  const [locationId, setLocationId] = useState('');
  const [kind, setKind] = useState<RequirementKind>('VACCINATION');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');

  const add = useMutation({
    mutationFn: () =>
      createCredentialRequirement({
        locationId,
        kind,
        label: label.trim(),
        vaccinationKind: kind === 'VACCINATION' ? target : null,
        complianceTag: kind === 'TRAINING' ? target : null,
        qualificationId: kind === 'QUALIFICATION' ? target : null,
      }),
    onSuccess: async () => {
      toast.success('Requirement added. The Compliance agent measures it this week.');
      setTarget('');
      setLabel('');
      await qc.invalidateQueries({ queryKey: ['credentialRequirements', 'list'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not add the requirement.'),
  });

  const remove = async (id: string, name: string) => {
    if (!(await confirm({ title: `Stop requiring ${name}?`, description: 'Past weeks stay on record. Nobody is asked for it again.', confirmLabel: 'Stop requiring it', destructive: true }))) return;
    try {
      await removeCredentialRequirement(id);
      await qc.invalidateQueries({ queryKey: ['credentialRequirements', 'list'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the requirement.');
    }
  };

  const options: ReadonlyArray<readonly [string, string]> =
    kind === 'VACCINATION' ? VACCINATIONS : kind === 'TRAINING' ? TRAININGS : (quals.data?.qualifications ?? []).map((q) => [q.id, q.name] as const);
  const pick = (value: string) => {
    setTarget(value);
    // The label starts as the target's name; it stays editable.
    const found = options.find(([v]) => v === value);
    if (found && !label.trim()) setLabel(found[1]);
  };
  const rows = list.data?.requirements ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Site requirements</CardTitle>
          <CardDescription>What everyone placed at a site must hold. The Compliance agent measures each requirement weekly and asks each person missing it.</CardDescription>
        </CardHeader>
        <CardContent>
          {list.error ? (
            <QueryError what="the requirements" query={list} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing required yet" description={canManage ? 'Add a requirement below.' : 'A compliance manager sets these.'} />
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white">
                      {r.label} <span className="text-silver">· {KIND_LABEL[r.kind]} · {r.place}</span>
                    </p>
                    <p className="text-xs2 text-silver">
                      {r.latest
                        ? r.latest.missing === 0
                          ? `Everyone covered (${r.latest.population}), week of ${r.latest.weekOf}`
                          : `${r.latest.missing} of ${r.latest.population} without it, week of ${r.latest.weekOf}`
                        : 'Not measured yet'}
                    </p>
                  </div>
                  {canManage && (
                    <Button size="sm" variant="secondary" onClick={() => void remove(r.id, r.label)}>
                      Stop requiring
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Add a requirement</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (locationId && target && label.trim()) add.mutate();
              }}
            >
              <Field label="Site" required>
                {(p) => (
                  <Select {...p} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Choose a site</option>
                    {(sites.data?.sites ?? []).filter((s) => s.isActive).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.clientName ? `${s.clientName} · ${s.name}` : s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Kind" required>
                {(p) => (
                  <Select
                    {...p}
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value as RequirementKind);
                      setTarget('');
                    }}
                  >
                    <option value="VACCINATION">Vaccination</option>
                    <option value="TRAINING">Training</option>
                    <option value="QUALIFICATION">Qualification</option>
                  </Select>
                )}
              </Field>
              <Field label="Required" required>
                {(p) => (
                  <Select {...p} value={target} onChange={(e) => pick(e.target.value)}>
                    <option value="">Choose</option>
                    {options.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="What people read" required hint="Shown to the person asked and on the desk.">
                {(p) => <Input {...p} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" loading={add.isPending} disabled={!locationId || !target || !label.trim() || add.isPending}>
                  Add requirement
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
