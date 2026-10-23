import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarHeart, Download, ShieldCheck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { listMyLeave, myLeaveNoticeUrl, requestMyLeave, uploadLeaveDocument, type LeaveReason, type LeaveSchedule, type LeaveType, type MyLeaveCase } from '@/lib/leaveApi';
import { ListTemplate } from '@/components/templates';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { STATUS_META } from './leaveWords';
import { enumWords, known } from '@/lib/known';

/** STATUS_META for a value from the server — one this screen doesn't know yet reads as words (lib/known). */
const statusMetaOf = (k: string) => known(STATUS_META, k, () => ({ label: enumWords(k), variant: 'outline' as const }));

/**
 * The worker's own leave: ask for it from the phone, send the
 * certification HR asks for, read the notices, see that the job is
 * protected. Plain words in the worker's language; no medical details are
 * asked for in the request itself.
 */

/** What the worker picks → the kind of leave HR opens it as (HR can change it). */
const CHOICES: Array<{ reason: LeaveReason; type: LeaveType }> = [
  { reason: 'OWN_HEALTH', type: 'FMLA' },
  { reason: 'FAMILY_CARE', type: 'FMLA' },
  { reason: 'BONDING', type: 'FMLA' },
  { reason: 'PREGNANCY', type: 'FMLA' },
  { reason: 'MILITARY_SERVICE', type: 'MILITARY_USERRA' },
  { reason: 'MILITARY_EXIGENCY', type: 'FMLA' },
  { reason: 'OTHER', type: 'PERSONAL' },
];

export function MyLeave() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['me', 'leave'], queryFn: listMyLeave });
  const [asking, setAsking] = useState(false);

  return (
    <ListTemplate
      title={t('myLeave.title')}
      subtitle={t('myLeave.subtitle')}
      primaryAction={q.data?.linked ? <Button onClick={() => setAsking(true)}>{t('myLeave.request')}</Button> : undefined}
    >
      {q.isError ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <span className="text-sm text-ink">{t('myLeave.loadError')}</span>
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              {t('myLeave.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : !q.data ? (
        <SkeletonRows count={3} />
      ) : !q.data.linked ? (
        <Card>
          <CardContent className="p-0 first:pt-0">
            <EmptyState icon={CalendarHeart} title={t('myLeave.title')} description={t('myLeave.notLinked')} className="py-10" />
          </CardContent>
        </Card>
      ) : q.data.cases.length === 0 ? (
        <Card>
          <CardContent className="p-0 first:pt-0">
            <EmptyState
              icon={CalendarHeart}
              title={t('myLeave.emptyTitle')}
              description={t('myLeave.emptyBody')}
              action={<Button onClick={() => setAsking(true)}>{t('myLeave.request')}</Button>}
              className="py-10"
            />
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {q.data.cases.map((c) => (
            <li key={c.id}>
              <MyCase c={c} />
            </li>
          ))}
        </ul>
      )}
      {/* Protected leave and everyday time off are two pages; each points to the other. */}
      <p className="text-sm text-silver" data-testid="time-off-pointer">
        {t('myLeave.timeOffPointer')}{' '}
        <Link to="/time-off" className="text-gold underline-offset-2 hover:underline">
          {t('myLeave.timeOffPointerLink')}
        </Link>
      </p>
      {asking && <AskDialog onClose={() => setAsking(false)} />}
    </ListTemplate>
  );
}

function MyCase({ c }: { c: MyLeaveCase }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const needsCert = c.certificationRequired && !c.certificationReceived && (c.status === 'REQUESTED' || c.status === 'PENDING_CERTIFICATION');
  const needsFitness = c.status === 'APPROVED' && c.fitnessForDutyRequired && !c.fitnessForDutyReceived;
  const kind = needsFitness ? 'FITNESS_FOR_DUTY' : c.type === 'MILITARY_USERRA' ? 'MILITARY_ORDERS' : 'MEDICAL_CERTIFICATION';
  const up = useMutation({
    mutationFn: (file: File) => uploadLeaveDocument(c.id, kind, file, true),
    onSuccess: () => {
      toast.success(t('myLeave.uploaded'));
      void qc.invalidateQueries({ queryKey: ['me', 'leave'] });
    },
    onError: (e) => toast.error(e instanceof Error && e.message ? e.message : t('myLeave.uploadFailed')),
  });
  const reasonKey = `myLeave.reason.${CHOICES.some((x) => x.reason === c.reason) ? c.reason : 'OTHER'}` as MessageKey;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-base font-medium text-ink">{c.stateProgramName ?? t(reasonKey)}</div>
            <div className="text-sm text-ink-muted">
              {c.endDate ? t('myLeave.dates', { from: fmtDate(c.startDate), to: fmtDate(c.endDate) }) : t('myLeave.datesOpen', { from: fmtDate(c.startDate) })} · {t(`myLeave.schedule.${c.schedule}` as MessageKey)}
            </div>
          </div>
          <Badge variant={statusMetaOf(c.status).variant}>{t(`myLeave.status.${c.status}` as MessageKey)}</Badge>
        </div>

        {c.jobProtected && (
          <p className="flex items-center gap-2 text-sm text-ink">
            <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
            {t('myLeave.protected')}
          </p>
        )}
        {c.expectedReturnDate && c.status === 'APPROVED' && <p className="text-sm text-ink-muted">{t('myLeave.expectedBack', { date: fmtDate(c.expectedReturnDate) })}</p>}
        {c.decisionNote && <p className="text-sm text-ink-muted">{t('myLeave.reasonNot', { note: c.decisionNote })}</p>}

        {(needsCert || needsFitness) && (
          <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
            <p className="text-sm font-medium text-ink">{needsFitness ? t('myLeave.fitnessNeeded') : c.certificationDueAt ? t('myLeave.certDue', { date: fmtDate(c.certificationDueAt) }) : t('myLeave.upload')}</p>
            <input
              ref={input}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              capture="environment"
              className="sr-only"
              aria-label={needsFitness ? t('myLeave.uploadFitness') : t('myLeave.upload')}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) up.mutate(f);
                e.target.value = '';
              }}
            />
            <Button size="sm" className="w-full sm:w-auto" loading={up.isPending} onClick={() => input.current?.click()}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              {needsFitness ? t('myLeave.uploadFitness') : t('myLeave.upload')}
            </Button>
          </div>
        )}
        {c.certificationRequired && c.certificationReceived && !needsFitness && <p className="text-sm text-success">{t('myLeave.certReceived')}</p>}

        {(c.noticeAvailable || c.designationAvailable) && (
          <div className="flex flex-wrap gap-2">
            {c.noticeAvailable && (
              <Button asChild size="sm" variant="secondary">
                <a href={myLeaveNoticeUrl(c.id, 'eligibility')} target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {t('myLeave.notice')}
                </a>
              </Button>
            )}
            {c.designationAvailable && (
              <Button asChild size="sm" variant="secondary">
                <a href={myLeaveNoticeUrl(c.id, 'designation')} target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {t('myLeave.designation')}
                </a>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AskDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reason, setReason] = useState<LeaveReason>('OWN_HEALTH');
  const [schedule, setSchedule] = useState<LeaveSchedule>('CONTINUOUS');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState('');
  const [pattern, setPattern] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      requestMyLeave({
        type: CHOICES.find((x) => x.reason === reason)!.type,
        reason,
        schedule,
        startDate: start,
        endDate: end || null,
        intermittentPattern: schedule === 'INTERMITTENT' ? pattern.trim() || null : null,
        notes: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success(t('myLeave.sent'));
      void qc.invalidateQueries({ queryKey: ['me', 'leave'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('myLeave.sendFailed')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('myLeave.request')}</DialogTitle>
          <DialogDescription>{t('myLeave.form.privacy')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t('myLeave.form.why')}>
            {(p) => (
              <Select {...p} value={reason} onChange={(e) => setReason(e.target.value as LeaveReason)}>
                {CHOICES.map((c) => (
                  <option key={c.reason} value={c.reason}>
                    {t(`myLeave.reason.${c.reason}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div>
            <div className="mb-1.5 text-sm text-ink">{t('myLeave.form.how')}</div>
            <SegmentedControl
              ariaLabel={t('myLeave.form.how')}
              value={schedule}
              onChange={setSchedule}
              options={(['CONTINUOUS', 'INTERMITTENT', 'REDUCED'] as const).map((k) => ({ value: k, label: t(`myLeave.schedule.${k}` as MessageKey) }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('myLeave.form.from')}>{(p) => <Input {...p} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Field label={t('myLeave.form.until')}>{(p) => <Input {...p} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />}</Field>
          </div>
          {schedule === 'INTERMITTENT' && <Field label={t('myLeave.form.pattern')}>{(p) => <Input {...p} value={pattern} maxLength={300} onChange={(e) => setPattern(e.target.value)} />}</Field>}
          <Field label={t('myLeave.form.note')}>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('myLeave.form.cancel')}
          </Button>
          <Button loading={m.isPending} disabled={!start || (!!end && end < start)} onClick={() => m.mutate()}>
            {t('myLeave.form.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
