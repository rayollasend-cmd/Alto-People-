import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { listMyOneOnOnes, setOneOnOneAgenda, type MyOneOnOne } from '@/lib/perf84Api';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Textarea } from '@/components/ui/Input';

/**
 * The associate's side of their next 1:1: when, with whom, the agenda they
 * add to (their manager sees it), and the open items agreed last time.
 * Nothing booked, nothing shown.
 */
export function MyNextOneOnOne() {
  const q = useQuery({ queryKey: ['performance', 'one-on-ones', 'mine'], queryFn: listMyOneOnOnes });
  const next = (q.data?.meetings ?? [])
    .filter((m) => m.status === 'SCHEDULED')
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
  if (!next) return null;
  return <NextCard key={next.id} meeting={next} />;
}

function NextCard({ meeting }: { meeting: MyOneOnOne }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [agenda, setAgenda] = useState(meeting.agenda ?? '');
  const save = useMutation({
    mutationFn: () => setOneOnOneAgenda(meeting.id, agenda.trim() || null),
    onSuccess: () => {
      toast.success(t('oneOnOne.saved'));
      void qc.invalidateQueries({ queryKey: ['performance', 'one-on-ones', 'mine'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('oneOnOne.saveFailed')),
  });
  const open = meeting.actionItems.filter((i) => !i.doneAt);
  const mine = open.filter((i) => !i.ownerIsManager);
  const theirs = open.filter((i) => i.ownerIsManager);
  const cadence = meeting.cadence === 'WEEKLY' ? t('oneOnOne.weekly') : meeting.cadence === 'BIWEEKLY' ? t('oneOnOne.biweekly') : null;
  return (
    <Card className="mb-4">
      <CardContent className="space-y-3 p-4">
        <SectionTitle
          as="h3"
          icon={CalendarClock}
          title={t('oneOnOne.next', { when: fmtDateTime(meeting.scheduledFor) })}
          description={[meeting.managerEmail ? t('oneOnOne.with', { who: meeting.managerEmail }) : null, cadence ? t('oneOnOne.repeats', { cadence }) : null]
            .filter(Boolean)
            .join(' · ')}
        />
        <label className="block text-sm font-medium text-ink" htmlFor={`agenda-${meeting.id}`}>
          {t('oneOnOne.agenda')}
        </label>
        <p className="-mt-2 text-xs text-ink-muted">{t('oneOnOne.agendaHint')}</p>
        <Textarea id={`agenda-${meeting.id}`} rows={3} value={agenda} maxLength={4000} onChange={(e) => setAgenda(e.target.value)} placeholder={t('oneOnOne.agendaPlaceholder')} />
        {agenda !== (meeting.agenda ?? '') && (
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>
            {t('oneOnOne.saveAgenda')}
          </Button>
        )}
        {(mine.length > 0 || theirs.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {mine.length > 0 && <ItemList title={t('oneOnOne.yourItems')} items={mine.map((i) => i.text)} />}
            {theirs.length > 0 && <ItemList title={t('oneOnOne.managerItems')} items={theirs.map((i) => i.text)} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ItemList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-ink-muted">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-ink">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
