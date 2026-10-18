import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeDollarSign, Download, FileText, Settings2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import {
  WOTC_QUESTIONS,
  getWotcScreening,
  getWotcSettings,
  getWotcSummary,
  listWotcScreenings,
  markWotcSubmitted,
  recordWotcOutcome,
  saveWotcEmployer,
  saveWotcSettings,
  saveWotcZips,
  wotc8850Url,
  wotcExportUrl,
  type WotcQuestion,
  type WotcScreening,
  type WotcStatus,
} from '@/lib/taxcompApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * WOTC — the Work Opportunity Tax Credit desk. Hires answer the screening
 * during onboarding; here HR completes the employer's section, files the
 * 8850 + 9061 with the state workforce agency inside 28 days of the start
 * date (through the state portal or a partner — Alto prepares the forms and
 * tracks the deadline), records the certification, and watches the credit
 * build with the hours worked.
 */

const STATUS_LABEL: Record<WotcStatus, string> = {
  NOT_STARTED: 'Not answered',
  DECLINED: 'Chose not to answer',
  NOT_ELIGIBLE: 'No target group',
  LIKELY_ELIGIBLE: 'Ready to file',
  SUBMITTED: 'Filed',
  CERTIFIED: 'Certified',
  DENIED: 'Denied',
};
const STATUS_TONE: Record<WotcStatus, 'default' | 'pending' | 'info' | 'success' | 'destructive'> = {
  NOT_STARTED: 'default',
  DECLINED: 'default',
  NOT_ELIGIBLE: 'default',
  LIKELY_ELIGIBLE: 'pending',
  SUBMITTED: 'info',
  CERTIFIED: 'success',
  DENIED: 'destructive',
};

/** What each screening question asks, in HR's words. */
export const QUESTION_TEXT: Record<WotcQuestion, string> = {
  snap: 'SNAP (food stamps) in the household recently',
  veteran: 'A U.S. military veteran',
  vetDisability: 'A VA service-connected disability rating',
  vetDischargedLastYear: 'Discharged from active duty in the past year',
  vetUnemployed6m: 'Unemployed 6 months or more in the past year',
  vetUnemployed4w: 'Unemployed 4 weeks to 6 months in the past year',
  tanf9: 'Family TANF for 9 of the last 18 months',
  tanf18: 'Family TANF for 18 months (long-term)',
  felony: 'A felony conviction or release in the past year',
  vocRehab: 'Referred by vocational rehabilitation, Ticket to Work or the VA',
  ssi: 'SSI in the last 60 days',
  longTermUnemployed: 'Unemployed 27+ weeks with unemployment benefits',
};

type Filter = 'to-file' | 'filed' | 'certified' | 'all';

function deadlineBadge(s: WotcScreening) {
  if (s.status !== 'LIKELY_ELIGIBLE' || s.daysLeft === null) return null;
  if (s.daysLeft < 0) return <Badge variant="destructive">{`${-s.daysLeft} day${s.daysLeft === -1 ? '' : 's'} late`}</Badge>;
  if (s.daysLeft <= 7) return <Badge variant="pending">{s.daysLeft === 0 ? 'Due today' : `${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left`}</Badge>;
  return <span className="text-xs text-ink-muted">{`${s.daysLeft} days left`}</span>;
}

export function WotcDesk() {
  const term = useTerm();
  const [filter, setFilter] = useState<Filter>('to-file');
  const [openId, setOpenId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const summary = useQuery({ queryKey: ['wotc', 'summary'], queryFn: getWotcSummary });
  const list = useQuery({ queryKey: ['wotc', 'screenings'], queryFn: () => listWotcScreenings() });
  const settings = useQuery({ queryKey: ['wotc', 'settings'], queryFn: getWotcSettings });

  const rows = useMemo(() => {
    const all = list.data?.screenings ?? [];
    if (filter === 'to-file') return all.filter((s) => s.status === 'LIKELY_ELIGIBLE');
    if (filter === 'filed') return all.filter((s) => s.status === 'SUBMITTED');
    if (filter === 'certified') return all.filter((s) => s.status === 'CERTIFIED' || s.status === 'DENIED');
    return all;
  }, [list.data, filter]);

  const columns: GridColumn<WotcScreening>[] = [
    { key: 'name', header: term('worker'), accessor: (r) => r.name, primary: true, sortable: true },
    { key: 'place', header: term('label.store'), accessor: (r) => [r.siteName, r.clientName].filter(Boolean).join(' · '), cardMeta: true },
    { key: 'group', header: 'Target group', accessor: (r) => r.targetGroups[0]?.label ?? '', cell: (r) => r.targetGroups[0]?.label ?? <span className="text-ink-muted">—</span> },
    { key: 'deadline', header: 'State deadline', accessor: (r) => r.deadline ?? '', cell: (r) => deadlineBadge(r) ?? (r.deadline ? fmtDate(r.deadline) : '—'), sortable: true },
    { key: 'status', header: 'Status', accessor: (r) => STATUS_LABEL[r.status], cell: (r) => <Badge variant={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
    { key: 'hours', header: 'Hours', accessor: (r) => r.hours, cell: (r) => <span className="tabular-nums">{r.hours.toLocaleString()}</span>, align: 'right', defaultHidden: true },
    {
      key: 'credit',
      header: 'Credit',
      accessor: (r) => (r.status === 'CERTIFIED' ? r.estimatedCredit : r.potentialCredit),
      cell: (r) =>
        r.status === 'CERTIFIED' ? (
          <span className="tabular-nums">{fmtMoney(r.estimatedCredit)}</span>
        ) : r.potentialCredit ? (
          <span className="tabular-nums text-ink-muted">{`up to ${fmtMoney(r.potentialCredit)}`}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      align: 'right',
      sortable: true,
    },
  ];

  const s = summary.data;
  return (
    <ListTemplate
      title="WOTC tax credits"
      subtitle="Screen hires for the Work Opportunity Tax Credit, file with the state inside 28 days of the start date, and watch the credit build with the hours."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'WOTC tax credits' }]}
      secondaryActions={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={wotcExportUrl()}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              9061 data (CSV)
            </a>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            Screening settings
          </Button>
        </div>
      }
      summary={
        s ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Credit earned" value={fmtMoney(s.estimatedCredit)} hint={`${s.certified} certified, by hours worked so far`} />
            <MetricCard label="In the pipeline" value={fmtMoney(s.pipelineCredit)} hint={`up to, across ${s.eligible - s.certified} eligible hires`} />
            <MetricCard
              label="To file"
              value={s.toFile}
              hint={s.overdue ? `${s.overdue} past the 28-day deadline` : s.dueThisWeek ? `${s.dueThisWeek} due this week` : 'none due this week'}
              accent={s.overdue > 0 || s.dueThisWeek > 0}
            />
            <MetricCard label="Filed on time" value={s.submitted ? `${Math.round((s.filedOnTime / s.submitted) * 100)}%` : '—'} hint={`${s.submitted} filed · ${s.screened} screened`} />
          </div>
        ) : (
          <Skeleton className="h-24" />
        )
      }
      filters={
        <SegmentedControl
          className="flex-wrap"
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'to-file', label: 'To file' },
            { value: 'filed', label: 'Filed' },
            { value: 'certified', label: 'Decided' },
            { value: 'all', label: 'All' },
          ]}
        />
      }
    >
      <div className="space-y-5">
        {settings.data && !settings.data.enabled && (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <p className="text-sm text-ink">Screening is off — new hires aren’t asked the questions. Turn it on to add them to every new onboarding checklist.</p>
              <Button size="sm" onClick={() => setSettingsOpen(true)}>
                Turn on screening
              </Button>
            </CardContent>
          </Card>
        )}
        <DataGrid
          id="wotc-screenings"
          caption="WOTC screenings"
          rows={list.data ? rows : undefined}
          columns={columns}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.isError ? (list.error instanceof ApiError ? list.error.message : 'Could not load screenings.') : null}
          onRetry={() => void list.refetch()}
          noun={{ one: 'screening', many: 'screenings' }}
          defaultSort={{ key: 'deadline', direction: 'asc' }}
          onRowClick={(r) => setOpenId(r.id)}
          rowActionLabel={(r) => `Open ${r.name}’s screening`}
          empty={{
            icon: BadgeDollarSign,
            title: filter === 'to-file' ? 'Nothing to file' : 'No screenings here',
            description:
              filter === 'to-file'
                ? 'Hires whose answers point to a target group appear here with their 28-day deadline.'
                : 'Screenings appear as new hires answer the questions in onboarding.',
          }}
        />
        {s && s.byPlace.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{`By ${term('label.store').toLowerCase()}`}</CardTitle>
              <CardDescription>Where the screened and certified hires work.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-line">
                {s.byPlace.slice(0, 12).map((p) => (
                  <li key={`${p.clientName}-${p.siteName}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink">{[p.siteName, p.clientName].filter(Boolean).join(' · ') || 'Not yet placed'}</span>
                    <span className="tabular-nums text-ink-muted">
                      {p.screened} screened · {p.eligible} eligible · {p.certified} certified · <span className="text-ink">{fmtMoney(p.estimatedCredit)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
      <ScreeningDrawer id={openId} onClose={() => setOpenId(null)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} enabled={settings.data?.enabled ?? false} zips={settings.data?.designatedZips ?? 0} />
    </ListTemplate>
  );
}

function ScreeningDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['wotc', 'screening', id], queryFn: () => getWotcScreening(id!), enabled: !!id });
  const s = q.data?.screening;
  const [emp, setEmp] = useState({ offerDate: '', hireDate: '', startDate: '', startingWage: '', position: '', filingState: '' });
  const [ref, setRef] = useState('');
  const [filedOn, setFiledOn] = useState('');
  const [group, setGroup] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!s) return;
    setEmp({
      offerDate: s.offerDate ?? '',
      hireDate: s.hireDate ?? '',
      startDate: s.startDate ?? '',
      startingWage: s.startingWage !== null ? String(s.startingWage) : '',
      position: s.position ?? '',
      filingState: s.filingState ?? '',
    });
    setGroup(s.certifiedGroup ?? s.targetGroups[0]?.code ?? '');
  }, [s]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['wotc'] });
  const onErr = (fallback: string) => (err: unknown) => toast.error(err instanceof ApiError ? err.message : fallback);
  const saveEmp = useMutation({
    mutationFn: () =>
      saveWotcEmployer(id!, {
        offerDate: emp.offerDate || null,
        hireDate: emp.hireDate || null,
        startDate: emp.startDate || null,
        startingWage: emp.startingWage ? Number(emp.startingWage) : null,
        position: emp.position || null,
        filingState: emp.filingState || null,
      }),
    onSuccess: (r) => {
      toast.success(r.screening.employerComplete ? 'Employer’s section complete.' : 'Saved — a few fields still to fill.');
      refresh();
    },
    onError: onErr('Could not save the employer’s section.'),
  });
  const file = useMutation({
    mutationFn: () => markWotcSubmitted(id!, { reference: ref.trim(), ...(filedOn ? { submittedOn: filedOn } : {}) }),
    onSuccess: () => {
      toast.success('Marked as filed with the state.');
      setRef('');
      refresh();
    },
    onError: onErr('Could not mark it filed.'),
  });
  const outcome = useMutation({
    mutationFn: (o: 'CERTIFIED' | 'DENIED') => recordWotcOutcome(id!, o === 'CERTIFIED' ? { outcome: 'CERTIFIED', group } : { outcome: 'DENIED', reason: reason.trim() }),
    onSuccess: () => {
      toast.success('Outcome recorded.');
      refresh();
    },
    onError: onErr('Could not record the outcome.'),
  });
  const yesAnswers = s ? WOTC_QUESTIONS.filter((k) => s.answers[k] === 'yes') : [];

  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      {!s ? (
        <DrawerBody>
          <Skeleton className="h-40" />
        </DrawerBody>
      ) : (
        <>
          <DrawerHeader>
            <DrawerTitle>{s.name}</DrawerTitle>
            <DrawerDescription>
              <Badge variant={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
              {s.deadline && s.status === 'LIKELY_ELIGIBLE' && <span className="ml-2">File by {fmtDate(s.deadline)}</span>}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="space-y-6">
            {s.signedAfterOffer && (
              <p role="status" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm text-ink">
                The applicant signed on {fmtDate(s.signedAt)}, after the job offer on {fmtDate(s.offerDate)}. The 8850 must be completed on or before the offer — this hire likely doesn’t qualify.
              </p>
            )}
            <section aria-labelledby="wotc-answers" className="space-y-2">
              <h3 id="wotc-answers" className="text-sm font-medium text-ink">
                What they answered
              </h3>
              {s.status === 'DECLINED' ? (
                <p className="text-sm text-ink-muted">They chose not to answer.</p>
              ) : yesAnswers.length === 0 ? (
                <p className="text-sm text-ink-muted">No “yes” answers — no target group applies.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
                  {yesAnswers.map((k) => (
                    <li key={k}>{QUESTION_TEXT[k]}</li>
                  ))}
                </ul>
              )}
              {s.targetGroups.length > 0 && (
                <p className="text-sm text-ink-muted">
                  Points to: {s.targetGroups.map((g) => `${g.label} (up to ${fmtMoney(g.maxCredit)})`).join(', ')}
                </p>
              )}
              <p className="text-xs text-ink-muted">Signed {s.signedAt ? fmtDate(s.signedAt) : '—'}. These answers are sensitive; viewing them is logged.</p>
            </section>

            <section aria-labelledby="wotc-employer" className="space-y-3">
              <h3 id="wotc-employer" className="text-sm font-medium text-ink">
                Employer’s section
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Job offered">{(p) => <Input {...p} type="date" value={emp.offerDate} onChange={(e) => setEmp({ ...emp, offerDate: e.target.value })} />}</Field>
                <Field label="Hired">{(p) => <Input {...p} type="date" value={emp.hireDate} onChange={(e) => setEmp({ ...emp, hireDate: e.target.value })} />}</Field>
                <Field label="Started work">{(p) => <Input {...p} type="date" value={emp.startDate} onChange={(e) => setEmp({ ...emp, startDate: e.target.value })} />}</Field>
                <Field label="Starting wage ($/hour)">{(p) => <Input {...p} type="number" min="0" step="0.01" value={emp.startingWage} onChange={(e) => setEmp({ ...emp, startingWage: e.target.value })} />}</Field>
                <Field label="Position">{(p) => <Input {...p} maxLength={120} value={emp.position} onChange={(e) => setEmp({ ...emp, position: e.target.value })} />}</Field>
                <Field label="Filing state" hint="Where the business is located">
                  {(p) => <Input {...p} maxLength={2} value={emp.filingState} onChange={(e) => setEmp({ ...emp, filingState: e.target.value.toUpperCase() })} placeholder="FL" />}
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => saveEmp.mutate()} loading={saveEmp.isPending}>
                  Save employer’s section
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <a href={wotc8850Url(s.id)}>
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    Download the 8850
                  </a>
                </Button>
              </div>
            </section>

            {(s.status === 'LIKELY_ELIGIBLE' || s.status === 'SUBMITTED') && (
              <section aria-labelledby="wotc-file" className="space-y-3">
                <h3 id="wotc-file" className="text-sm font-medium text-ink">
                  Filed with the state
                </h3>
                <p className="text-xs text-ink-muted">Submit the 8850 and 9061 on the state workforce agency’s portal (or through your WOTC partner), then record the confirmation here.</p>
                {s.submittedAt ? (
                  <p className="text-sm text-ink">
                    Filed {fmtDate(s.submittedAt)} · {s.submissionRef}
                    {s.filedOnTime === false ? ' — after the 28-day deadline' : ''}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Confirmation number">{(p) => <Input {...p} maxLength={120} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
                    <Field label="Filed on" hint="Leave empty for today">{(p) => <Input {...p} type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />}</Field>
                    <div className="col-span-2">
                      <Button size="sm" onClick={() => file.mutate()} disabled={!ref.trim() || !s.employerComplete} loading={file.isPending}>
                        Mark as filed
                      </Button>
                      {!s.employerComplete && <span className="ml-2 text-xs text-ink-muted">Complete the employer’s section first.</span>}
                    </div>
                  </div>
                )}
              </section>
            )}

            {(s.status === 'SUBMITTED' || s.status === 'CERTIFIED' || s.status === 'DENIED') && (
              <section aria-labelledby="wotc-outcome" className="space-y-3">
                <h3 id="wotc-outcome" className="text-sm font-medium text-ink">
                  The state’s decision
                </h3>
                {s.status === 'CERTIFIED' && (
                  <p className="text-sm text-ink">
                    Certified {fmtDate(s.certifiedAt)}. {s.hours.toLocaleString()} hours and {fmtMoney(s.wages)} in wages so far —{' '}
                    {s.creditRate ? `${Math.round(s.creditRate * 100)}% credit, ${fmtMoney(s.estimatedCredit)}` : 'the credit starts at 120 hours'}.
                  </p>
                )}
                {s.status === 'DENIED' && <p className="text-sm text-ink">Denied: {s.denialReason}</p>}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Certified target group">
                    {(p) => (
                      <Select {...p} value={group} onChange={(e) => setGroup(e.target.value)}>
                        {s.targetGroups.map((g) => (
                          <option key={g.code} value={g.code}>
                            {g.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <div className="flex items-end">
                    <Button size="sm" onClick={() => outcome.mutate('CERTIFIED')} disabled={!group} loading={outcome.isPending && outcome.variables === 'CERTIFIED'}>
                      Record certified
                    </Button>
                  </div>
                  <Field label="Reason for a denial" className="sm:col-span-2">
                    {(p) => <Textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
                  </Field>
                  <div>
                    <Button size="sm" variant="outline" onClick={() => outcome.mutate('DENIED')} disabled={reason.trim().length < 3} loading={outcome.isPending && outcome.variables === 'DENIED'}>
                      Record denied
                    </Button>
                  </div>
                </div>
              </section>
            )}
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DrawerFooter>
        </>
      )}
    </Drawer>
  );
}

function SettingsDialog({ open, onClose, enabled, zips }: { open: boolean; onClose: () => void; enabled: boolean; zips: number }) {
  const qc = useQueryClient();
  const [on, setOn] = useState(enabled);
  const [zipText, setZipText] = useState('');
  useEffect(() => setOn(enabled), [enabled, open]);
  const parsed = useMemo(
    () =>
      zipText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [zip, kind] = l.split(/[\s,]+/);
          return { zip: zip ?? '', kind: (kind ?? 'EZ').toUpperCase() as 'EZ' | 'RRC' };
        }),
    [zipText],
  );
  const bad = parsed.filter((p) => !/^\d{5}$/.test(p.zip) || (p.kind !== 'EZ' && p.kind !== 'RRC'));
  const save = useMutation({
    mutationFn: async () => {
      await saveWotcSettings(on);
      if (parsed.length) await saveWotcZips(parsed);
    },
    onSuccess: () => {
      toast.success('Screening settings saved.');
      setZipText('');
      void qc.invalidateQueries({ queryKey: ['wotc'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Screening settings</DialogTitle>
          <DialogDescription>Whether new hires are asked the questions, and the ZIP codes that count as empowerment zones or rural renewal counties.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={on} onChange={(e) => setOn(e.target.checked)} />
            Ask W-2 hires the screening questions during onboarding
          </label>
          <Field
            label="Designated ZIP codes"
            hint={`${zips.toLocaleString()} on file. Paste one per line as “ZIP EZ” or “ZIP RRC” to replace them (from the HUD and USDA lists).`}
          >
            {(p) => <Textarea {...p} rows={5} value={zipText} onChange={(e) => setZipText(e.target.value)} placeholder={'32501 EZ\n36460 RRC'} />}
          </Field>
          {bad.length > 0 && (
            <p className="text-sm text-alert" role="alert">
              {bad.length} line{bad.length === 1 ? '' : 's'} isn’t a 5-digit ZIP followed by EZ or RRC.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={bad.length > 0} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
