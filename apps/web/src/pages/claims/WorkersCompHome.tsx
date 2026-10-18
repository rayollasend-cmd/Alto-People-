import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, HardHat, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  answerDutyOffer,
  froiPdfUrl,
  getDutyMatches,
  getWcClaim,
  getWcSummary,
  listUnclaimedIncidents,
  listWcClaims,
  offerModifiedDuty,
  openWcClaim,
  patchWcClaim,
  submitFroi,
  type FroiFields,
  type OfferResponse,
  type Treatment,
  type WcClaim,
  type WcStatus,
} from '@/lib/claimsApi';
import { DeskTemplate } from '@/components/templates';
import {
  Avatar,
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
  FilterChip,
  Input,
  MetricCard,
  SectionTitle,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Workers' comp claims — HR's desk (manage:claims).
 *
 * Injuries beyond first aid in the OSHA log that have no claim yet sit at
 * the top with a "Start a claim" each. A claim opens with the First Report
 * of Injury already filled from the incident and the person record, and a
 * due date from the state's filing window (defaults — the carrier's rules
 * win). The report goes to the carrier through its portal; recording that
 * moves the claim on. Lost and restricted days entered here are the OSHA
 * log's days. Restrictions are structured, so modified-duty shifts that fit
 * them can be found and offered — and an accepted offer puts them on it.
 */

const STATUS_META: Record<WcStatus, { label: string; variant: 'pending' | 'success' | 'destructive' | 'info' | 'outline' }> = {
  OPEN: { label: 'Report to send', variant: 'pending' },
  SUBMITTED: { label: 'With the carrier', variant: 'info' },
  ACCEPTED: { label: 'Accepted', variant: 'success' },
  DENIED: { label: 'Denied', variant: 'destructive' },
  CLOSED: { label: 'Closed', variant: 'outline' },
};
const SEVERITY_TEXT: Record<string, string> = { MEDICAL_TREATMENT: 'Medical treatment', RESTRICTED_DUTY: 'Restricted duty', DAYS_AWAY: 'Days away', FATAL: 'Fatal' };
const TREATMENT_TEXT: Record<Treatment, string> = { NONE: 'None', FIRST_AID: 'First aid on site', CLINIC: 'Clinic or doctor', EMERGENCY_ROOM: 'Emergency room', HOSPITALIZED: 'Hospitalized overnight' };
const OFFER_TEXT: Record<OfferResponse, string> = { PENDING: 'Waiting', ACCEPTED: 'Accepted', DECLINED: 'Declined', NO_RESPONSE: 'No response' };

export function WorkersCompHome() {
  const term = useTerm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get('claim');
  const [status, setStatus] = useState('open');
  const summary = useQuery({ queryKey: ['claims', 'wc', 'summary'], queryFn: getWcSummary });
  const incidents = useQuery({ queryKey: ['claims', 'wc', 'incidents'], queryFn: listUnclaimedIncidents });
  const list = useQuery({ queryKey: ['claims', 'wc', 'list', status], queryFn: () => listWcClaims({ status }) });
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('claim', id);
    else next.delete('claim');
    setParams(next);
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['claims', 'wc'] });
  const start = useMutation({
    mutationFn: (incidentId: string) => openWcClaim({ oshaIncidentId: incidentId }),
    onSuccess: (r) => {
      toast.success(`Claim started. The first report is due to the carrier ${fmtDate(r.claim.froiDueAt)}.`);
      refresh();
      setOpen(r.claim.id);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not start the claim.'),
  });
  const s = summary.data;

  // On a phone with an item open, the item takes the screen: the counts and filters step aside.
  const filters = (
    <div className={cn('space-y-3', openId && 'hidden lg:block')}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Reports to send" value={s?.froiDue ?? '—'} hint={s ? (s.froiOverdue ? `${s.froiOverdue} past the filing window` : 'None past the filing window') : undefined} />
        <MetricCard label="Open claims" value={s?.open ?? '—'} hint={s ? `${s.claimsLast12Months} in the last 12 months` : undefined} />
        <MetricCard label="Lost-time days" value={s?.lostTimeDaysOpen ?? '—'} hint={s ? `${s.restrictedDaysOpen} restricted days on open claims` : undefined} />
        <MetricCard
          label="Incident rate"
          value={s?.incidentRate ?? '—'}
          hint={s && s.incidentRate === null ? `Needs a full-time year of hours — ${s.hoursWorkedLast12Months.toLocaleString()} logged so far` : 'Recordable cases per 100 full-time workers, 12 months'}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter claims">
        {[
          ['open', 'Open'],
          ['OPEN', 'Report to send'],
          ['SUBMITTED', 'With the carrier'],
          ['all', 'All'],
        ].map(([v, label]) => (
          <FilterChip key={v} active={status === v} onClick={() => setStatus(v!)}>
            {label}
          </FilterChip>
        ))}
      </div>
    </div>
  );

  const pending = incidents.data?.incidents ?? [];
  const claims = list.data?.claims ?? null;
  const queue = (
    <div className="space-y-4">
      {pending.length > 0 && (
        <Card>
          <CardContent className="p-0 first:pt-0">
            <div className="border-b border-line px-3 py-2">
              <SectionTitle className="mb-0" as="h3" title="Injuries without a claim" description="Beyond first aid, from the safety log." />
            </div>
            <ul className="divide-y divide-line">
              {pending.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{i.associateName ?? 'Unnamed'}</span>
                    <span className="block truncate text-xs text-ink-muted">
                      {SEVERITY_TEXT[i.severity]} · {fmtDate(i.occurredAt)} · {i.storeName ?? i.clientName}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">{i.description}</span>
                  </span>
                  <Button size="sm" loading={start.isPending && start.variables === i.id} onClick={() => start.mutate(i.id)}>
                    Start a claim
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {list.isError ? (
        <QueryError what="claims" query={list} />
      ) : claims === null ? (
        <SkeletonRows count={5} />
      ) : claims.length === 0 ? (
        <EmptyState
          icon={HardHat}
          title={status === 'open' ? 'No open claims' : 'No claims match'}
          description={pending.length ? 'Start one from an injury above — the first report fills itself from the incident.' : 'When an injury beyond first aid is logged at a ' + term('label.store').toLowerCase() + ', it shows here ready to become a claim.'}
          className="py-8"
        />
      ) : (
        <Card>
          <CardContent className="p-0 first:pt-0">
            <ul className="divide-y divide-line" aria-label="Workers’ comp claims">
              {claims.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(c.id)}
                    aria-current={openId === c.id ? 'true' : undefined}
                    className={cn('flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-surface-raised coarse:min-h-14', openId === c.id && 'bg-surface-raised')}
                  >
                    <Avatar name={c.associateName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{c.associateName}</span>
                        <Badge size="sm" variant={STATUS_META[c.status].variant}>
                          {STATUS_META[c.status].label}
                        </Badge>
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {c.froi.injury.bodyPart ?? 'Injury'} · {fmtDate(c.injuryDate)} · {c.storeName ?? c.clientName ?? c.jurisdiction}
                      </span>
                      {c.next && (
                        <span className={cn('mt-0.5 block text-xs', c.next.overdue ? 'font-medium text-alert' : 'text-ink-muted')}>
                          {c.next.overdue ? 'Overdue: ' : ''}
                          {c.next.label}
                          {c.next.dueAt ? ` · by ${fmtDate(c.next.dueAt)}` : ''}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );

  const byPlace = s?.byPlace ?? [];
  const item = openId ? (
    <ClaimView id={openId} onBack={() => setOpen(null)} onChanged={refresh} />
  ) : (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0 first:pt-0">
          <EmptyState icon={HardHat} title="Pick a claim" description="It opens with the first report filled in, the carrier step, days off and modified-duty shifts that fit the restrictions." className="py-10" />
        </CardContent>
      </Card>
      {byPlace.length > 0 && (
        <Card>
          <CardContent className="p-4 md:p-5">
            <h3 className="mb-2 text-sm font-semibold text-ink">By {term('label.store').toLowerCase()}, last 12 months</h3>
            <table className="w-full text-sm">
              <caption className="sr-only">Claims and lost-time days by {term('label.store').toLowerCase()}</caption>
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1 font-medium">{term('label.store')}</th>
                  <th scope="col" className="py-1 text-right font-medium">Claims</th>
                  <th scope="col" className="py-1 text-right font-medium">Lost days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byPlace.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1.5 text-ink">
                      {r.storeName ?? '—'} <span className="text-ink-muted">· {r.clientName}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{r.claims}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{r.lostTimeDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );

  return (
    <DeskTemplate
      title="Workers’ comp claims"
      subtitle="From the injury to the carrier and back to work."
      breadcrumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'Workers’ comp claims' }]}
      filters={filters}
      queue={queue}
      item={item}
      itemOpen={!!openId}
    />
  );
}

function ClaimView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const q = useQuery({ queryKey: ['claims', 'wc', 'claim', id], queryFn: () => getWcClaim(id) });
  const [submitting, setSubmitting] = useState(false);
  const changed = () => {
    void q.refetch();
    onChanged();
  };
  if (q.isError) return <QueryError what="this claim" query={q} />;
  if (!q.data) return <SkeletonRows count={8} />;
  const c = q.data.claim;
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All claims
      </Button>
      <Card>
        <CardContent className="space-y-4 p-4 md:p-5">
          <div className="flex flex-wrap items-start gap-3">
            <Avatar name={c.associateName} size="md" />
            <div className="min-w-0 flex-1">
              <SectionTitle className="mb-0" title={<Link to={`/people/${c.associateId}`} className="hover:underline">{c.associateName}</Link>} />
              <p className="text-sm text-ink-muted">
                {c.froi.injury.bodyPart ?? 'Injury'} · {fmtDateTime(c.injuryDate)} · {c.storeName ?? c.clientName ?? '—'} · {c.jurisdiction}
              </p>
              {c.carrierClaimNumber && <p className="text-sm text-ink-muted">Carrier claim {c.carrierClaimNumber}{c.carrierName ? ` · ${c.carrierName}` : ''}</p>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={STATUS_META[c.status].variant}>{STATUS_META[c.status].label}</Badge>
              <Badge variant="outline">{c.claimType === 'INDEMNITY' ? 'Lost time' : 'Medical only'}</Badge>
            </div>
          </div>
          {c.next && (
            <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-3', c.next.overdue ? 'border-alert/50 bg-alert/5' : 'border-line bg-surface-raised')}>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Next step</div>
                <div className="text-sm font-medium text-ink">
                  {c.next.label}
                  {c.next.dueAt && <span className={cn('font-normal', c.next.overdue ? 'text-alert' : 'text-ink-muted')}> · {c.next.overdue ? 'was due' : 'by'} {fmtDate(c.next.dueAt)}</span>}
                </div>
                {c.next.key === 'froi' && <div className="text-xs text-ink-muted">A {q.data.froiDefaultDays}-day window for {c.jurisdiction} by default — confirm yours with your carrier.</div>}
              </div>
              {c.next.key === 'froi' && (
                <Button onClick={() => setSubmitting(true)}>
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Record it as sent
                </Button>
              )}
            </div>
          )}
          <Button asChild size="sm" variant="secondary">
            <a href={froiPdfUrl(c.id)} target="_blank" rel="noreferrer">
              <Download className="h-4 w-4" aria-hidden="true" />
              First report of injury (PDF)
            </a>
          </Button>
        </CardContent>
      </Card>

      <FroiCard c={c} onChanged={changed} />
      <DaysCard c={c} onChanged={changed} />
      <DutyCard c={c} onChanged={changed} />

      {submitting && <SubmitDialog c={c} onClose={() => setSubmitting(false)} onDone={() => { setSubmitting(false); changed(); }} />}
    </div>
  );
}

function FroiCard({ c, onChanged }: { c: WcClaim; onChanged: () => void }) {
  const [f, setF] = useState<FroiFields>(c.froi);
  useEffect(() => setF(c.froi), [c.froi]);
  const save = useMutation({
    mutationFn: () =>
      patchWcClaim(c.id, {
        froi: {
          employer: { name: f.employer.name, fein: f.employer.fein, address: f.employer.address, policyNumber: f.employer.policyNumber },
          employee: { name: f.employee.name, address: f.employee.address, phone: f.employee.phone, jobTitle: f.employee.jobTitle, wageRate: f.employee.wageRate, hoursPerWeek: f.employee.hoursPerWeek },
          injury: { where: f.injury.where, description: f.injury.description, bodyPart: f.injury.bodyPart, nature: f.injury.nature, cause: f.injury.cause, objectOrSubstance: f.injury.objectOrSubstance, witnesses: f.injury.witnesses, treatment: f.injury.treatment, physician: f.injury.physician, returnedToWork: f.injury.returnedToWork },
          reportedBy: f.reportedBy,
        },
      }),
    onSuccess: () => {
      toast.success('First report saved.');
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const set = <K extends keyof FroiFields>(k: K, patch: Partial<FroiFields[K]>) => setF({ ...f, [k]: { ...f[k], ...patch } });
  const missing = [!f.employer.fein && 'employer FEIN', !f.employer.policyNumber && 'policy number', !f.injury.nature && 'nature of injury', !f.injury.cause && 'cause'].filter(Boolean) as string[];
  return (
    <Card>
      <CardContent className="space-y-4 p-4 md:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">First report of injury</h3>
          <p className="text-xs text-ink-muted">{missing.length ? `Still to fill: ${missing.join(', ')}.` : 'Everything the common state forms ask for is filled in.'}</p>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-muted">Employer</legend>
          <Field label="Name">{(p) => <Input {...p} value={f.employer.name} onChange={(e) => set('employer', { name: e.target.value })} />}</Field>
          <Field label="FEIN">{(p) => <Input {...p} value={f.employer.fein ?? ''} onChange={(e) => set('employer', { fein: e.target.value || null })} />}</Field>
          <Field label="Policy number">{(p) => <Input {...p} value={f.employer.policyNumber ?? ''} onChange={(e) => set('employer', { policyNumber: e.target.value || null })} />}</Field>
          <Field label="Address">{(p) => <Input {...p} value={f.employer.address ?? ''} onChange={(e) => set('employer', { address: e.target.value || null })} />}</Field>
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-muted">Employee</legend>
          <Field label="Occupation">{(p) => <Input {...p} value={f.employee.jobTitle ?? ''} onChange={(e) => set('employee', { jobTitle: e.target.value || null })} />}</Field>
          <Field label={`Wage per ${f.employee.wageUnit === 'YEAR' ? 'year' : 'hour'}`}>
            {(p) => <Input {...p} type="number" min={0} step="0.01" value={f.employee.wageRate ?? ''} onChange={(e) => set('employee', { wageRate: e.target.value ? Number(e.target.value) : null })} />}
          </Field>
          <Field label="Average hours a week" hint="From the last 8 weeks of punches">
            {(p) => <Input {...p} type="number" min={0} step="0.5" value={f.employee.hoursPerWeek ?? ''} onChange={(e) => set('employee', { hoursPerWeek: e.target.value ? Number(e.target.value) : null })} />}
          </Field>
          <Field label="Phone">{(p) => <Input {...p} value={f.employee.phone ?? ''} onChange={(e) => set('employee', { phone: e.target.value || null })} />}</Field>
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-muted">The injury</legend>
          <Field label="What happened" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={f.injury.description} onChange={(e) => set('injury', { description: e.target.value })} />}</Field>
          <Field label="Part of body">{(p) => <Input {...p} value={f.injury.bodyPart ?? ''} onChange={(e) => set('injury', { bodyPart: e.target.value || null })} />}</Field>
          <Field label="Nature of injury" hint="e.g. Strain, cut, burn">{(p) => <Input {...p} value={f.injury.nature ?? ''} onChange={(e) => set('injury', { nature: e.target.value || null })} />}</Field>
          <Field label="Cause" hint="e.g. Lifting a case">{(p) => <Input {...p} value={f.injury.cause ?? ''} onChange={(e) => set('injury', { cause: e.target.value || null })} />}</Field>
          <Field label="Object or substance">{(p) => <Input {...p} value={f.injury.objectOrSubstance ?? ''} onChange={(e) => set('injury', { objectOrSubstance: e.target.value || null })} />}</Field>
          <Field label="Where it happened">{(p) => <Input {...p} value={f.injury.where ?? ''} onChange={(e) => set('injury', { where: e.target.value || null })} />}</Field>
          <Field label="Witnesses">{(p) => <Input {...p} value={f.injury.witnesses ?? ''} onChange={(e) => set('injury', { witnesses: e.target.value || null })} />}</Field>
          <Field label="Treatment">
            {(p) => (
              <Select {...p} value={f.injury.treatment ?? ''} onChange={(e) => set('injury', { treatment: (e.target.value || null) as Treatment | null })}>
                <option value="">Not known yet</option>
                {(Object.keys(TREATMENT_TEXT) as Treatment[]).map((t) => (
                  <option key={t} value={t}>
                    {TREATMENT_TEXT[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Physician or facility">{(p) => <Input {...p} value={f.injury.physician ?? ''} onChange={(e) => set('injury', { physician: e.target.value || null })} />}</Field>
        </fieldset>
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save the report
        </Button>
      </CardContent>
    </Card>
  );
}

function DaysCard({ c, onChanged }: { c: WcClaim; onChanged: () => void }) {
  const [lost, setLost] = useState(String(c.lostTimeDays));
  const [restricted, setRestricted] = useState(String(c.restrictedDays));
  const [rtw, setRtw] = useState(c.rtwDate ?? '');
  const [status, setStatus] = useState<WcStatus>(c.status);
  const [reserveMed, setReserveMed] = useState(c.reserveMedical?.toString() ?? '');
  const [reserveInd, setReserveInd] = useState(c.reserveIndemnity?.toString() ?? '');
  const save = useMutation({
    mutationFn: () =>
      patchWcClaim(c.id, {
        lostTimeDays: Number(lost) || 0,
        restrictedDays: Number(restricted) || 0,
        rtwDate: rtw || null,
        status,
        reserveMedical: reserveMed ? Number(reserveMed) : null,
        reserveIndemnity: reserveInd ? Number(reserveInd) : null,
      }),
    onSuccess: () => {
      toast.success('Saved. The safety log’s days match the claim.');
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">Days off, status and reserves</h3>
          <p className="text-xs text-ink-muted">Days entered here are the days on the OSHA log for this injury{c.oshaIncidentId ? '' : ' (no OSHA incident is linked to this claim)'}.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Days away from work">{(p) => <Input {...p} type="number" min={0} value={lost} onChange={(e) => setLost(e.target.value)} />}</Field>
          <Field label="Restricted days">{(p) => <Input {...p} type="number" min={0} value={restricted} onChange={(e) => setRestricted(e.target.value)} />}</Field>
          <Field label="Back to work">{(p) => <Input {...p} type="date" value={rtw} onChange={(e) => setRtw(e.target.value)} />}</Field>
          <Field label="Claim status">
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as WcStatus)}>
                {(Object.keys(STATUS_META) as WcStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Medical reserve" hint="From the carrier, optional">{(p) => <Input {...p} type="number" min={0} value={reserveMed} onChange={(e) => setReserveMed(e.target.value)} />}</Field>
          <Field label="Indemnity reserve" hint="From the carrier, optional">{(p) => <Input {...p} type="number" min={0} value={reserveInd} onChange={(e) => setReserveInd(e.target.value)} />}</Field>
        </div>
        {(c.reserveMedical || c.reserveIndemnity) && <p className="text-xs text-ink-muted">Reserved: {fmtMoney((c.reserveMedical ?? 0) + (c.reserveIndemnity ?? 0))}</p>}
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function DutyCard({ c, onChanged }: { c: WcClaim; onChanged: () => void }) {
  const [restrictions, setRestrictions] = useState(c.restrictions ?? '');
  const [maxHours, setMaxHours] = useState(c.restrictionRules?.maxHoursPerShift?.toString() ?? '');
  const [lift, setLift] = useState(c.restrictionRules?.liftLimitLbs?.toString() ?? '');
  const [positions, setPositions] = useState((c.restrictionRules?.positions ?? []).join(', '));
  const matches = useQuery({ queryKey: ['claims', 'wc', 'matches', c.id, c.restrictionRules], queryFn: () => getDutyMatches(c.id) });
  const saveRules = useMutation({
    mutationFn: () =>
      patchWcClaim(c.id, {
        restrictions: restrictions.trim() || null,
        restrictionRules: {
          maxHoursPerShift: maxHours ? Number(maxHours) : null,
          liftLimitLbs: lift ? Number(lift) : null,
          positions: positions.split(',').map((p) => p.trim()).filter(Boolean),
        },
      }),
    onSuccess: () => {
      toast.success('Restrictions saved.');
      onChanged();
      void matches.refetch();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const offer = useMutation({
    mutationFn: (s: { id: string; label: string }) => offerModifiedDuty(c.id, { shiftId: s.id, description: s.label }),
    onSuccess: () => {
      toast.success('Offered. They were told; record their answer here.');
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not offer the shift.'),
  });
  const answer = useMutation({
    mutationFn: ({ offerId, response }: { offerId: string; response: OfferResponse }) => answerDutyOffer(c.id, offerId, response),
    onSuccess: (_r, v) => {
      toast.success(v.response === 'ACCEPTED' ? 'Accepted — they’re on the shift.' : 'Answer recorded.');
      onChanged();
      void matches.refetch();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not record the answer.'),
  });
  return (
    <Card>
      <CardContent className="space-y-4 p-4 md:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">Restrictions and modified duty</h3>
          <p className="text-xs text-ink-muted">Shifts in the next two weeks that fit the restrictions; offering one tells the worker.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Restrictions from the doctor" className="sm:col-span-3">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={restrictions} onChange={(e) => setRestrictions(e.target.value)} />}</Field>
          <Field label="Most hours a shift">{(p) => <Input {...p} type="number" min={1} max={24} value={maxHours} onChange={(e) => setMaxHours(e.target.value)} />}</Field>
          <Field label="Lift limit (lb)">{(p) => <Input {...p} type="number" min={0} max={500} value={lift} onChange={(e) => setLift(e.target.value)} />}</Field>
          <Field label="Positions that fit" hint="Comma separated, e.g. Greeter, Cashier">{(p) => <Input {...p} value={positions} onChange={(e) => setPositions(e.target.value)} />}</Field>
        </div>
        <Button variant="secondary" loading={saveRules.isPending} onClick={() => saveRules.mutate()}>
          Save the restrictions
        </Button>
        <div>
          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-ink-muted">Shifts that fit</h4>
          {matches.isError ? (
            <QueryError what="matching shifts" query={matches} />
          ) : !matches.data ? (
            <SkeletonRows count={2} />
          ) : matches.data.shifts.length === 0 ? (
            <p className="text-sm text-ink-muted">No open shift in the next two weeks fits these restrictions.</p>
          ) : (
            <ul className="divide-y divide-line">
              {matches.data.shifts.map((s) => {
                const label = `${s.position}, ${fmtDateTime(s.startsAt)} (${s.hours} h)${s.store ? ` at ${s.store}` : ''}.`;
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <span className="min-w-0 flex-1 text-ink">{label}</span>
                    <Button size="sm" variant="secondary" loading={offer.isPending && offer.variables?.id === s.id} onClick={() => offer.mutate({ id: s.id, label })}>
                      Offer
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {c.dutyOffers.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-ink-muted">Offers made</h4>
            <ul className="divide-y divide-line">
              {c.dutyOffers.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{o.description}</span>
                    <span className="block text-xs text-ink-muted">Offered {fmtDate(o.offeredAt)}</span>
                  </span>
                  {o.response === 'PENDING' ? (
                    <span className="flex gap-1">
                      {(['ACCEPTED', 'DECLINED', 'NO_RESPONSE'] as const).map((r) => (
                        <Button key={r} size="xs" variant="secondary" loading={answer.isPending} onClick={() => answer.mutate({ offerId: o.id, response: r })}>
                          {OFFER_TEXT[r]}
                        </Button>
                      ))}
                    </span>
                  ) : (
                    <Badge size="sm" variant={o.response === 'ACCEPTED' ? 'success' : 'pending'}>
                      {OFFER_TEXT[o.response]}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SubmitDialog({ c, onClose, onDone }: { c: WcClaim; onClose: () => void; onDone: () => void }) {
  const [carrier, setCarrier] = useState(c.carrierName ?? '');
  const [number, setNumber] = useState(c.carrierClaimNumber ?? '');
  const m = useMutation({
    mutationFn: () => submitFroi(c.id, { carrierName: carrier.trim(), carrierClaimNumber: number.trim() || null }),
    onSuccess: () => {
      toast.success('Recorded as sent to the carrier.');
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not record it.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record the first report as sent</DialogTitle>
          <DialogDescription>Send the PDF through your carrier’s or TPA’s portal — Alto People doesn’t transmit to carriers. Then record it here so the deadline is met on the record.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Carrier or TPA" required>{(p) => <Input {...p} value={carrier} maxLength={160} onChange={(e) => setCarrier(e.target.value)} />}</Field>
          <Field label="Carrier claim number" hint="If they gave you one">{(p) => <Input {...p} value={number} maxLength={80} onChange={(e) => setNumber(e.target.value)} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={carrier.trim().length < 2} onClick={() => m.mutate()}>
            Record as sent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
