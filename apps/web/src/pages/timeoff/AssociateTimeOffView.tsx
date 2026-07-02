import { useCallback, useEffect, useState } from 'react';
import { CalendarOff, Plus, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import type {
  TimeOffBalance,
  TimeOffCategory,
  TimeOffRequest,
} from '@alto-people/shared';
import {
  cancelMyRequest,
  createMyRequest,
  getMyBalance,
  listMyRequests,
} from '@/lib/timeOffApi';
import { ApiError } from '@/lib/api';
import { performWithUndo } from '@/lib/undoToast';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';

type Category = TimeOffCategory;

const CATEGORY_KEYS: Record<Category, MessageKey> = {
  SICK: 'timeoff.cat.SICK',
  VACATION: 'timeoff.cat.VACATION',
  PTO: 'timeoff.cat.PTO',
  BEREAVEMENT: 'timeoff.cat.BEREAVEMENT',
  JURY_DUTY: 'timeoff.cat.JURY_DUTY',
  OTHER: 'timeoff.cat.OTHER',
};

function fmtHours(minutes: number): string {
  const h = minutes / 60;
  return `${h.toFixed(h % 1 === 0 ? 0 : 1)}h`;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

export function AssociateTimeOffView() {
  const { t } = useI18n();
  const [balances, setBalances] = useState<TimeOffBalance[] | null>(null);
  const [requests, setRequests] = useState<TimeOffRequest[] | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [bal, reqs] = await Promise.all([getMyBalance(), listMyRequests()]);
      setBalances(bal.balances);
      setRequests(reqs.requests);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        // Caller isn't an associate — render empty state instead of an error.
        setBalances([]);
        setRequests([]);
        return;
      }
      toast.error(t('timeoff.loadFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCancel = (id: string) => {
    // Gmail-style undo: flip the row to Withdrawn immediately, commit to
    // the server only after the 5s undo window — no confirm dialog, no
    // lost requests from a mis-tap.
    const before = requests;
    setRequests(
      (prev) =>
        prev?.map((r) =>
          r.id === id ? { ...r, status: 'CANCELLED' as const } : r,
        ) ?? prev,
    );
    performWithUndo({
      message: t('timeoff.withdrawnToast'),
      undoLabel: t('common.undo'),
      onCommit: async () => {
        await cancelMyRequest(id);
        refresh();
      },
      onUndo: () => setRequests(before),
      commitFailedMessage: t('timeoff.cancelFailed'),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('timeoff.title')}
        subtitle={t('timeoff.subtitle')}
        primaryAction={
          <Button onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4" />
            {t('timeoff.request')}
          </Button>
        }
      />

      <BalanceGrid balances={balances} />

      <Card>
        <CardHeader>
          <CardTitle>{t('timeoff.myRequests')}</CardTitle>
          <CardDescription>{t('timeoff.mostRecentFirst')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!requests && <SkeletonRows count={3} />}
          {requests && requests.length === 0 && (
            <EmptyState
              icon={CalendarOff}
              title={t('timeoff.noRequests')}
              description={t('timeoff.noRequestsDesc')}
            />
          )}
          {requests && requests.length > 0 && (
            <ul className="divide-y divide-navy-secondary">
              {requests.map((r) => (
                <li
                  key={r.id}
                  className="py-3 flex items-start gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white font-medium">
                        {t(CATEGORY_KEYS[r.category])} · {fmtHours(r.requestedMinutes)}
                      </span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-xs text-silver mt-0.5">
                      {fmtDate(r.startDate)}
                      {r.startDate !== r.endDate && ` – ${fmtDate(r.endDate)}`}
                    </div>
                    {r.reason && (
                      <div className="text-xs text-silver/80 mt-1 italic">
                        “{r.reason}”
                      </div>
                    )}
                    {r.reviewerNote && (
                      <div className="text-xs text-silver mt-1">
                        <span className="text-silver/70">
                          {t('timeoff.noteFrom', {
                            who: r.reviewerEmail ?? t('timeoff.hr'),
                          })}
                        </span>{' '}
                        {r.reviewerNote}
                      </div>
                    )}
                  </div>
                  {r.status === 'PENDING' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancel(r.id)}
                    >
                      {t('timeoff.withdraw')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateRequestDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        onCreated={() => {
          setOpenCreate(false);
          refresh();
        }}
      />
    </div>
  );
}

function BalanceGrid({ balances }: { balances: TimeOffBalance[] | null }) {
  const { t } = useI18n();
  if (!balances) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (balances.length === 0) {
    return (
      <Card>
        <CardContent className="py-6">
          <EmptyState
            icon={Wallet}
            title={t('timeoff.noBalance')}
            description={t('timeoff.noBalanceDesc')}
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {balances.map((b) => (
        <Card key={b.category}>
          <CardContent className="py-4">
            <div className="text-[10px] uppercase tracking-widest text-silver">
              {t(CATEGORY_KEYS[b.category])}
            </div>
            <div className="text-2xl text-white font-display mt-1 tabular-nums">
              {fmtHours(b.balanceMinutes)}
            </div>
            <div className="text-xs text-silver/70 mt-0.5">{t('timeoff.available')}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: TimeOffRequest['status'] }) {
  const { t } = useI18n();
  if (status === 'APPROVED')
    return <Badge variant="success">{t('timeoff.status.APPROVED')}</Badge>;
  if (status === 'DENIED')
    return <Badge variant="destructive">{t('timeoff.status.DENIED')}</Badge>;
  if (status === 'CANCELLED')
    return <Badge variant="outline">{t('timeoff.status.CANCELLED')}</Badge>;
  return <Badge variant="pending">{t('timeoff.status.PENDING')}</Badge>;
}

interface CreateProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

function CreateRequestDialog({ open, onOpenChange, onCreated }: CreateProps) {
  const { t } = useI18n();
  const [category, setCategory] = useState<Category>('VACATION');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [hours, setHours] = useState('8');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCategory('VACATION');
    setStartDate('');
    setEndDate('');
    setHours('8');
    setReason('');
  };

  const submit = async () => {
    if (!startDate || !endDate) {
      toast.error(t('timeoff.pickDates'));
      return;
    }
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      toast.error(t('timeoff.hoursPositive'));
      return;
    }
    setSubmitting(true);
    try {
      await createMyRequest({
        category,
        startDate,
        endDate,
        hours: h,
        reason: reason.trim() || undefined,
      });
      toast.success(t('timeoff.submittedToast'));
      reset();
      onCreated();
    } catch (err) {
      toast.error(t('timeoff.submitFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('timeoff.request')}</DialogTitle>
          <DialogDescription>
            {t('timeoff.dialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label={t('timeoff.category')}>
            {(p) => (
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                {...p}
              >
                {(Object.keys(CATEGORY_KEYS) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {t(CATEGORY_KEYS[c])}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/* Stack the date pair on phones — two native date inputs
              side-by-side don't fit inside the 360px bottom sheet. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('timeoff.startDate')} required>
              {(p) => (
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label={t('timeoff.endDate')} required>
              {(p) => (
                <Input
                  type="date"
                  value={endDate}
                  min={startDate || undefined}
                  onChange={(e) => setEndDate(e.target.value)}
                  {...p}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('timeoff.totalHours')}
            required
            hint={t('timeoff.totalHoursHint')}
          >
            {(p) => (
              <Input
                type="number"
                step="0.5"
                min="0.5"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                {...p}
              />
            )}
          </Field>

          <Field label={t('timeoff.reasonOptional')}>
            {(p) => (
              <Input
                type="text"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('timeoff.reasonPlaceholder')}
                {...p}
              />
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t('timeoff.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
