import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock3, FileSignature, Hourglass } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtTime, parseYmd } from '@/lib/format';
import {
  answerMyOtOffer,
  finishPromptedCorrection,
  getMyCorrections,
  getMyOtOffers,
  submitCorrection,
  withdrawCorrection,
  type CorrectionKind,
  type CorrectionRequest,
  type MyCorrections,
} from '@/lib/laborLiveApi';
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
  SectionTitle,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';

/**
 * The worker's own: a shift they forgot to clock out of (the kiosk noticed),
 * asking to fix a punch with a signed attestation, their requests and where
 * each stands, and extra hours offered to them.
 */

const KINDS: CorrectionKind[] = ['MISSED_CLOCK_OUT', 'WRONG_TIME', 'MISSED_CLOCK_IN', 'NEW_ENTRY'];

/** <input type="datetime-local"> value for an ISO instant, in this device's zone. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

function statusVariant(s: CorrectionRequest['status']): 'success' | 'pending' | 'outline' {
  return s === 'APPROVED' ? 'success' : s === 'SUBMITTED' || s === 'PROMPTED' ? 'pending' : 'outline';
}

function FixDialog({ data, open, onClose, prompted }: { data: MyCorrections; open: boolean; onClose: () => void; prompted: CorrectionRequest | null }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [kind, setKind] = useState<CorrectionKind>(prompted ? 'MISSED_CLOCK_OUT' : 'MISSED_CLOCK_OUT');
  const [entryId, setEntryId] = useState(prompted?.timeEntryId ?? '');
  const [siteId, setSiteId] = useState(data.sites[0]?.id ?? '');
  const [cin, setCin] = useState('');
  const [cout, setCout] = useState('');
  const [reason, setReason] = useState('');
  const [attested, setAttested] = useState(false);
  useEffect(() => {
    if (!open) return;
    setKind('MISSED_CLOCK_OUT');
    setEntryId(prompted?.timeEntryId ?? data.entries.find((e) => !e.clockOutAt)?.id ?? '');
    setCin('');
    setCout('');
    setReason('');
    setAttested(false);
  }, [open, prompted, data.entries]);
  const entry = data.entries.find((e) => e.id === entryId) ?? null;
  const needsEntry = kind === 'MISSED_CLOCK_OUT' || kind === 'WRONG_TIME';
  const needsIn = kind === 'MISSED_CLOCK_IN' || kind === 'NEW_ENTRY' || kind === 'WRONG_TIME';
  const needsOut = kind !== 'WRONG_TIME' || true;
  const valid =
    attested &&
    reason.trim().length >= 3 &&
    (prompted ? !!cout : needsEntry ? !!entryId && (kind === 'MISSED_CLOCK_OUT' ? !!cout : !!cin || !!cout) : !!cin && !!cout);
  const send = useMutation({
    mutationFn: () =>
      prompted
        ? finishPromptedCorrection(prompted.id, { proposedClockOut: fromLocalInput(cout)!, reason: reason.trim(), attested })
        : submitCorrection({
            kind,
            timeEntryId: needsEntry ? entryId : null,
            siteId: needsEntry ? null : siteId || null,
            proposedClockIn: needsIn ? fromLocalInput(cin) : null,
            proposedClockOut: needsOut ? fromLocalInput(cout) : null,
            reason: reason.trim(),
            attested,
          }),
    onSuccess: () => {
      toast.success(t('timefix.sent'));
      void qc.invalidateQueries({ queryKey: ['time-corrections', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('timefix.error')),
  });
  const shiftLabel = (e: MyCorrections['entries'][number]) =>
    t('timefix.on', { date: fmtDate(e.clockInAt), from: fmtTime(e.clockInAt), to: e.clockOutAt ? fmtTime(e.clockOutAt) : t('timefix.stillOpen') }) + (e.siteName ? ` · ${e.siteName}` : '');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prompted ? t('timefix.finish') : t('timefix.title')}</DialogTitle>
          <DialogDescription>{prompted && prompted.workDate ? t('timefix.prompted', { date: fmtDate(parseYmd(prompted.workDate)) }) : t('timefix.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!prompted && (
            <Field label={t('timefix.kind')}>
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as CorrectionKind)}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`timefix.kind.${k}` as const)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {!prompted && needsEntry && (
            <Field label={t('timefix.shift')}>
              {(p) => (
                <Select {...p} value={entryId} onChange={(e) => setEntryId(e.target.value)}>
                  <option value="">{t('timefix.pickShift')}</option>
                  {data.entries.map((e) => (
                    <option key={e.id} value={e.id}>
                      {shiftLabel(e)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {!prompted && !needsEntry && data.sites.length > 1 && (
            <Field label={t('timefix.place')}>
              {(p) => (
                <Select {...p} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  {data.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {!prompted && needsIn && (
            <Field label={t('timefix.clockIn')}>
              {(p) => <Input {...p} type="datetime-local" value={cin || (kind === 'WRONG_TIME' ? toLocalInput(entry?.clockInAt) : '')} onChange={(e) => setCin(e.target.value)} />}
            </Field>
          )}
          <Field label={t('timefix.clockOut')}>
            {(p) => <Input {...p} type="datetime-local" value={cout || (kind === 'WRONG_TIME' ? toLocalInput(entry?.clockOutAt) : '')} onChange={(e) => setCout(e.target.value)} />}
          </Field>
          <Field label={t('timefix.reason')} required hint={t('timefix.reasonHint')}>
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 coarse:h-6 coarse:w-6" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
            <span>{t('timefix.attest')}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('timefix.cancel')}
          </Button>
          <Button onClick={() => send.mutate()} disabled={!valid} loading={send.isPending}>
            <FileSignature className="h-4 w-4" aria-hidden="true" />
            {t('timefix.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OffersSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['overtime-offers', 'mine'], queryFn: getMyOtOffers });
  const answer = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACCEPTED' | 'DECLINED' }) => answerMyOtOffer(id, status),
    onSuccess: (_r, v) => {
      toast.success(v.status === 'ACCEPTED' ? t('offers.taken') : t('offers.passed'));
      void qc.invalidateQueries({ queryKey: ['overtime-offers', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('offers.error')),
  });
  const offers = q.data?.offers ?? [];
  if (offers.length === 0) return null;
  return (
    <section id="offers" aria-labelledby="ot-offers" className="space-y-2">
      <SectionTitle id="ot-offers" as="h2" icon={Hourglass} title={t('offers.title')} />
      <ul className="space-y-2">
        {offers.map((o) => (
          <li key={o.id}>
            <Card>
              <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium text-ink">
                    {o.shift.position}
                    {o.shift.siteName ? ` · ${o.shift.siteName}` : ''}
                  </div>
                  <div className="text-sm text-ink-muted">
                    {fmtDate(o.shift.startsAt)}, {fmtTime(o.shift.startsAt)} – {fmtTime(o.shift.endsAt)}
                    {o.wouldAddOvertimeHours > 0 ? ` · ${t('offers.overtime', { hours: o.wouldAddOvertimeHours })}` : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => answer.mutate({ id: o.id, status: 'ACCEPTED' })} loading={answer.isPending && answer.variables?.id === o.id && answer.variables.status === 'ACCEPTED'}>
                    {t('offers.take')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => answer.mutate({ id: o.id, status: 'DECLINED' })} disabled={answer.isPending}>
                    {t('offers.pass')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PunchFixes() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['time-corrections', 'mine'], queryFn: getMyCorrections });
  const [open, setOpen] = useState(false);
  const [finishing, setFinishing] = useState<CorrectionRequest | null>(null);
  const prompted = useMemo(() => (q.data?.requests ?? []).filter((r) => r.status === 'PROMPTED'), [q.data]);
  const recent = useMemo(() => (q.data?.requests ?? []).filter((r) => r.status !== 'PROMPTED').slice(0, 6), [q.data]);
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawCorrection(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['time-corrections', 'mine'] }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('timefix.error')),
  });

  // A link from the inbox or a notification (?fix=1) opens the right thing.
  useEffect(() => {
    if (params.get('fix') !== '1' || !q.data) return;
    if (prompted[0]) setFinishing(prompted[0]);
    else setOpen(true);
    const next = new URLSearchParams(params);
    next.delete('fix');
    setParams(next, { replace: true });
  }, [params, q.data, prompted, setParams]);

  return (
    <div className="mb-5 space-y-4">
      {prompted.map((r) => (
        <div key={r.id} role="status" className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink">{r.workDate ? t('timefix.prompted', { date: fmtDate(parseYmd(r.workDate)) }) : t('timefix.finish')}</p>
          <Button size="sm" onClick={() => setFinishing(r)}>
            {t('timefix.finish')}
          </Button>
        </div>
      ))}
      <OffersSection />
      <section aria-labelledby="punch-fixes" className="space-y-2">
        <SectionTitle
          id="punch-fixes"
          as="h2"
          icon={Clock3}
          title={t('timefix.mine')}
          description={t('timefix.subtitle')}
          trailing={
            <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!q.data}>
              {t('timefix.title')}
            </Button>
          }
        />
        {q.isError ? (
          <Card>
            <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
              <span className="text-ink">{t('timefix.loadError')}</span>
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                {t('timefix.retry')}
              </Button>
            </CardContent>
          </Card>
        ) : !q.data ? (
          <SkeletonRows count={2} />
        ) : recent.length === 0 ? (
          <EmptyState size="sm" icon={FileSignature} title={t('timefix.noneTitle')} />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="text-ink">{t(`timefix.kind.${r.kind}` as const)}</div>
                  <div className="text-xs text-ink-muted">
                    {r.workDate ? fmtDate(parseYmd(r.workDate)) : ''}
                    {r.decisionReason ? ` · ${r.decisionReason}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant={statusVariant(r.status)}>
                    {t(`timefix.status.${r.status}` as const)}
                  </Badge>
                  {r.status === 'SUBMITTED' && (
                    <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(r.id)} loading={withdraw.isPending && withdraw.variables === r.id}>
                      {t('timefix.withdraw')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {q.data && <FixDialog data={q.data} open={open || !!finishing} prompted={finishing} onClose={() => { setOpen(false); setFinishing(null); }} />}
    </div>
  );
}
