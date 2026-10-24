import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { claimMySkill, listMySkills, withdrawMySkill, type SkillLevel } from '@/lib/skills111Api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import '@/lib/i18n/en/me';

/**
 * My skills, on my own profile (HR walk, wave 2): add what I can do from
 * the company's list; each one waits for HR to verify it before it counts
 * toward shifts. A claim nobody has verified yet can be taken back.
 */

const LEVELS: SkillLevel[] = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];

export function MySkillsCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'skills'], queryFn: listMySkills });
  const [adding, setAdding] = useState(false);
  const [skillId, setSkillId] = useState('');
  const [level, setLevel] = useState<SkillLevel>('INTERMEDIATE');
  const [years, setYears] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['me', 'skills'] });
  const levelWord = (l: SkillLevel) => t(`me.skills.level.${l}` as MessageKey);

  const add = useMutation({
    mutationFn: () => claimMySkill({ skillId, level, yearsExperience: years === '' ? null : Math.max(0, Math.min(60, Number(years) || 0)) }),
    onSuccess: () => {
      toast.success(t('me.skills.added'));
      setAdding(false);
      setSkillId('');
      setYears('');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('me.skills.failed')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => withdrawMySkill(id),
    onSuccess: () => {
      toast.success(t('me.skills.removed'));
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('me.skills.failed')),
  });

  const mine = q.data?.skills ?? [];
  const catalog = q.data?.catalog ?? [];
  const have = new Set(mine.map((s) => s.skillId));
  const choices = catalog.filter((c) => !have.has(c.id));

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{t('me.skills.title')}</CardTitle>
        <CardDescription>{t('me.skills.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <SkeletonRows count={2} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('me.skills.empty')}</p>
        ) : (
          <ul className="divide-y divide-navy-secondary" aria-label={t('me.skills.title')}>
            {mine.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 text-sm text-ink">
                  {s.skillName}
                  <span className="text-ink-muted">{` · ${levelWord(s.level)}${s.yearsExperience !== null ? ` · ${s.yearsExperience}` : ''}`}</span>
                </span>
                <Badge size="sm" variant={s.verified ? 'success' : 'pending'}>
                  {s.verified ? t('me.skills.verified') : t('me.skills.pending')}
                </Badge>
                {!s.verified && (
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)} loading={remove.isPending && remove.variables === s.id}>
                    {t('me.skills.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!q.isLoading && catalog.length === 0 ? (
          <p className="text-xs text-ink-muted">{t('me.skills.noCatalog')}</p>
        ) : adding ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem_8rem_auto] sm:items-end">
            <Field label={t('me.skills.skill')}>
              {(p) => (
                <Select value={skillId} onChange={(e) => setSkillId(e.target.value)} {...p}>
                  <option value="">{t('me.skills.pick')}</option>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('me.skills.level')}>
              {(p) => (
                <Select value={level} onChange={(e) => setLevel(e.target.value as SkillLevel)} {...p}>
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {levelWord(l)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('me.skills.years')}>
              {(p) => <Input type="number" min={0} max={60} inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} {...p} />}
            </Field>
            <Button onClick={() => add.mutate()} disabled={!skillId} loading={add.isPending}>
              {t('me.skills.save')}
            </Button>
          </div>
        ) : (
          choices.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('me.skills.add')}
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );
}
