import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, FileWarning, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  answerWorkOffer,
  getUiClaim,
  getUiSummary,
  listUiClaims,
  openUiClaim,
  patchUiClaim,
  recordWorkOffer,
  respondUiClaim,
  uiPacketUrl,
  type ClaimEvidence,
  type OfferResponse,
  type Outcome,
  type UiClaim,
  type UiStatus,
} from '@/lib/claimsApi';
import { DeskTemplate } from '@/components/templates';
import {
  AssociatePicker,
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
  SearchInput,
  SectionTitle,
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Unemployment claims — HR's desk (manage:claims).
 *
 * The state's notice comes in; the claim opens with its response deadline
 * and the evidence already gathered from the record: the separation, the
 * last assignment, warnings, attendance points, signed policies, and the
 * offers of suitable work that decide so many staffing claims. A plain read
 * of what the record supports sits beside the contest / don't-contest
 * decision; the response packet is one download. Determinations, hearings
 * and appeals follow, and the dashboard shows the win rate and the
 * estimated tax impact by client.
 */

const STATUS_META: Record<UiStatus, { label: string; variant: 'pending' | 'success' | 'destructive' | 'info' | 'outline' }> = {
  NEW: { label: 'To answer', variant: 'pending' },
  RESPONDED: { label: 'Answered', variant: 'info' },
  DETERMINED: { label: 'Decided', variant: 'outline' },
  HEARING_SCHEDULED: { label: 'Hearing set', variant: 'pending' },
  APPEALED: { label: 'Appealed', variant: 'pending' },
  CLOSED: { label: 'Closed', variant: 'outline' },
};

const OUTCOME_TEXT: Record<Outcome, string> = { ALLOWED: 'Benefits allowed', DENIED: 'Benefits denied' };
const OFFER_TEXT: Record<OfferResponse, string> = { PENDING: 'Waiting on an answer', ACCEPTED: 'Accepted', DECLINED: 'Declined', NO_RESPONSE: 'No response' };
const POSTURE_META = {
  strong: { label: 'The record supports a contest', variant: 'success' as const },
  mixed: { label: 'The record is mixed', variant: 'pending' as const },
  weak: { label: 'The record is thin', variant: 'destructive' as const },
};

export function UnemploymentClaimsHome() {
  const term = useTerm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get('claim');
  const [status, setStatus] = useState('open');
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState(false);
  const summary = useQuery({ queryKey: ['claims', 'ui', 'summary'], queryFn: getUiSummary });
  const list = useQuery({ queryKey: ['claims', 'ui', 'list', status, q], queryFn: () => listUiClaims({ status, q: q.trim() || undefined }) });
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('claim', id);
    else next.delete('claim');
    setParams(next);
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['claims', 'ui'] });
  const s = summary.data;

  // On a phone with an item open, the item takes the screen: the counts and filters step aside.
  const filters = (
    <div className={cn('space-y-3', openId && 'hidden lg:block')}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Responses due" value={s?.responsesDueThisWeek ?? '—'} hint={s ? (s.overdue ? `${s.overdue} overdue` : 'In the next 7 days, none overdue') : undefined} />
        <MetricCard label="Open claims" value={s?.open ?? '—'} hint={s ? `${s.hearingsNext14Days} hearing${s.hearingsNext14Days === 1 ? '' : 's'} in 14 days` : undefined} />
        <MetricCard label="Win rate" value={s?.winRate === null || s?.winRate === undefined ? '—' : `${s.winRate}%`} hint={s ? `${s.contestedDecided} contested claim${s.contestedDecided === 1 ? '' : 's'} decided` : undefined} />
        <MetricCard label="Estimated tax impact" value={s ? fmtMoney(s.estimatedSuiImpact) : '—'} hint="Charged benefits × your rate factor — an estimate" />
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter claims">
        {[
          ['open', 'Open'],
          ['NEW', 'To answer'],
          ['HEARING_SCHEDULED', 'Hearings'],
          ['all', 'All'],
        ].map(([v, label]) => (
          <FilterChip key={v} active={status === v} onClick={() => setStatus(v!)}>
            {label}
          </FilterChip>
        ))}
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a claimant" aria-label="Find a claimant" />
        </div>
      </div>
    </div>
  );

  const claims = list.data?.claims ?? null;
  const queue = list.isError ? (
    <QueryError what="claims" query={list} />
  ) : claims === null ? (
    <SkeletonRows count={6} />
  ) : claims.length === 0 ? (
    <EmptyState
      icon={FileWarning}
      title={status === 'open' ? 'No open claims' : 'No claims match'}
      description={status === 'open' ? 'When a state notice arrives, record it here — the response deadline and the evidence come with it.' : 'Try another filter.'}
      action={status === 'open' ? <Button onClick={() => setOpening(true)}>Record a claim</Button> : undefined}
      className="py-8"
    />
  ) : (
    <Card>
      <CardContent className="p-0 first:pt-0">
        <ul className="divide-y divide-line" aria-label="Unemployment claims">
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
                    {c.state} · claimed {fmtDate(c.claimDate)}
                    {c.clientName ? ` · ${c.clientName}` : ''}
                  </span>
                  {c.next ? (
                    <span className={cn('mt-0.5 block text-xs', c.next.overdue ? 'font-medium text-alert' : 'text-ink-muted')}>
                      {c.next.overdue ? 'Overdue: ' : ''}
                      {c.next.label}
                      {c.next.dueAt ? ` · by ${fmtDate(c.next.dueAt)}` : ''}
                    </span>
                  ) : c.outcome ? (
                    <span className="mt-0.5 block text-xs text-ink-muted">{OUTCOME_TEXT[c.outcome]}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );

  const byClient = s?.byClient ?? [];
  const item = openId ? (
    <ClaimView id={openId} onBack={() => setOpen(null)} onChanged={refresh} />
  ) : (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0 first:pt-0">
          <EmptyState icon={Scale} title="Pick a claim" description="It opens with the response deadline, the evidence from the record and a read of what it supports." className="py-10" />
        </CardContent>
      </Card>
      {byClient.length > 0 && (
        <Card>
          <CardContent className="p-4 md:p-5">
            <h3 className="mb-2 text-sm font-semibold text-ink">By {term('label.client').toLowerCase()}, last 3 years</h3>
            <table className="w-full text-sm">
              <caption className="sr-only">Claims and charges by {term('label.client').toLowerCase()}</caption>
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th scope="col" className="py-1 font-medium">{term('label.client')}</th>
                  <th scope="col" className="py-1 text-right font-medium">Claims</th>
                  <th scope="col" className="py-1 text-right font-medium">Allowed</th>
                  <th scope="col" className="py-1 text-right font-medium">Charges</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {byClient.map((r) => (
                  <tr key={r.clientId ?? 'none'}>
                    <td className="py-1.5 text-ink">{r.clientName}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{r.claims}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{r.allowed}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink">{fmtMoney(r.charges)}</td>
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
    <>
      <DeskTemplate
        title="Unemployment claims"
        subtitle="Answer every state notice on time, argued from the record."
        breadcrumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'Unemployment claims' }]}
        actions={<Button onClick={() => setOpening(true)}>Record a claim</Button>}
        filters={filters}
        queue={queue}
        item={item}
        itemOpen={!!openId}
      />
      {opening && (
        <OpenClaimDialog
          onClose={() => setOpening(false)}
          onOpened={(id) => {
            setOpening(false);
            refresh();
            setOpen(id);
          }}
        />
      )}
    </>
  );
}

function ClaimView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const q = useQuery({ queryKey: ['claims', 'ui', 'claim', id], queryFn: () => getUiClaim(id) });
  const [responding, setResponding] = useState(false);
  const [offering, setOffering] = useState(false);
  if (q.isError) return <QueryError what="this claim" query={q} />;
  if (!q.data) return <SkeletonRows count={8} />;
  const { claim: c, evidence: e } = q.data;
  const posture = POSTURE_META[e.posture.kind];
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
                {c.state} claim{c.stateClaimNumber ? ` ${c.stateClaimNumber}` : ''} · filed {fmtDate(c.claimDate)} · notice received {fmtDate(c.noticeReceivedAt)}
              </p>
            </div>
            <Badge variant={STATUS_META[c.status].variant}>{STATUS_META[c.status].label}</Badge>
          </div>
          {c.next && (
            <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border p-3', c.next.overdue ? 'border-alert/50 bg-alert/5' : 'border-line bg-surface-raised')}>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Next step</div>
                <div className="text-sm font-medium text-ink">
                  {c.next.label}
                  {c.next.dueAt && <span className={cn('font-normal', c.next.overdue ? 'text-alert' : 'text-ink-muted')}> · {c.next.overdue ? 'was due' : 'by'} {fmtDate(c.next.dueAt)}</span>}
                </div>
              </div>
              {c.status === 'NEW' && <Button onClick={() => setResponding(true)}>Respond</Button>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="secondary">
              <a href={uiPacketUrl(c.id)} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" aria-hidden="true" />
                Response packet (PDF)
              </a>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOffering(true)}>
              Record an offer of work
            </Button>
          </div>
          {c.decision && (
            <p className="text-sm text-ink">
              <span className="font-medium">{c.decision === 'CONTEST' ? 'Contested' : 'Not contested'}</span>
              {c.respondedAt ? <span className="text-ink-muted"> on {fmtDate(c.respondedAt)}</span> : null}
              {c.decisionReason ? <span className="block text-ink-muted">{c.decisionReason}</span> : null}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">What the record supports</h3>
            <Badge variant={posture.variant}>{posture.label}</Badge>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
            {e.posture.points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted">A reading of the record to help you decide — not legal advice, and never the decision itself.</p>
        </CardContent>
      </Card>

      <Evidence e={e} claim={c} onChanged={() => { void q.refetch(); onChanged(); }} />
      <OutcomeCard c={c} onChanged={() => { void q.refetch(); onChanged(); }} />

      {responding && <RespondDialog c={c} e={e} onClose={() => setResponding(false)} onDone={() => { setResponding(false); void q.refetch(); onChanged(); }} />}
      {offering && <OfferDialog associateId={c.associateId} claimId={c.id} onClose={() => setOffering(false)} onDone={() => { setOffering(false); void q.refetch(); }} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-xs font-medium uppercase tracking-wider text-ink-muted">{title}</h4>
      {children}
    </section>
  );
}

function Evidence({ e, claim, onChanged }: { e: ClaimEvidence; claim: UiClaim; onChanged: () => void }) {
  const term = useTerm();
  const answer = useMutation({
    mutationFn: ({ id, response }: { id: string; response: OfferResponse }) => answerWorkOffer(id, { response, declineReason: response === 'DECLINED' ? 'Declined when offered' : undefined }),
    onSuccess: () => onChanged(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the answer.'),
  });
  return (
    <Card>
      <CardContent className="space-y-4 p-4 md:p-5">
        <h3 className="text-sm font-semibold text-ink">Evidence from the record</h3>
        <Section title="Separation">
          {e.separation ? (
            <p className="text-sm text-ink">
              {e.separation.reasonLabel} · last day {fmtDate(e.separation.lastDayWorked)}
              {e.separation.noticeDate ? ` · notice given ${fmtDate(e.separation.noticeDate)}` : ''}
              {e.separation.notes ? <span className="block text-ink-muted">{e.separation.notes}</span> : null}
            </p>
          ) : (
            <p className="text-sm text-alert">No separation on file. Complete it on {claim.associateName}’s record so the response states a reason.</p>
          )}
        </Section>
        <Section title={`Last ${term('label.store').toLowerCase()} assignment`}>
          {e.lastAssignment ? (
            <p className="text-sm text-ink">
              {e.lastAssignment.store}
              {e.lastAssignment.client ? ` — ${e.lastAssignment.client}` : ''} · {fmtDate(e.lastAssignment.startedAt)} to {e.lastAssignment.endedAt ? fmtDate(e.lastAssignment.endedAt) : 'still placed'}
              {e.lastAssignment.reason ? <span className="block text-ink-muted">{e.lastAssignment.reason}</span> : null}
            </p>
          ) : (
            <p className="text-sm text-ink-muted">No assignment on file.</p>
          )}
        </Section>
        <Section title="Offers of suitable work">
          {e.workOffers.length === 0 ? (
            <p className="text-sm text-ink-muted">None recorded. An ended assignment with no offer usually reads as a layoff.</p>
          ) : (
            <ul className="divide-y divide-line">
              {e.workOffers.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{o.description}</span>
                    <span className="block text-xs text-ink-muted">
                      {fmtDate(o.offeredAt)}
                      {o.payRate ? ` · ${fmtMoney(o.payRate)}/h` : ''}
                      {o.declineReason ? ` · ${o.declineReason}` : ''}
                    </span>
                  </span>
                  {o.response === 'PENDING' ? (
                    <span className="flex gap-1">
                      {(['ACCEPTED', 'DECLINED', 'NO_RESPONSE'] as const).map((r) => (
                        <Button key={r} size="xs" variant="secondary" loading={answer.isPending} onClick={() => answer.mutate({ id: o.id, response: r })}>
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
          )}
        </Section>
        <Section title="Warnings in the year before">
          {e.discipline.length === 0 ? (
            <p className="text-sm text-ink-muted">None.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {e.discipline.map((d) => (
                <li key={d.id}>
                  <span className="text-ink">{d.label}</span>
                  <span className="text-ink-muted">
                    {' '}
                    · {fmtDate(d.incidentDate)}
                    {d.acknowledged ? ' · acknowledged' : ''} — {d.description}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={`Attendance points on the last day: ${e.attendance.score}`}>
          {e.attendance.events.length === 0 ? (
            <p className="text-sm text-ink-muted">No attendance events in the last 90 days.</p>
          ) : (
            <ul className="space-y-0.5 text-sm">
              {e.attendance.events.map((a, i) => (
                <li key={i} className="text-ink">
                  {fmtDate(a.date)} · {a.label}
                  <span className="text-ink-muted">
                    {' '}
                    · {a.points} pt{a.excused ? ' (excused)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Policies acknowledged">
          {e.signedPolicies.length === 0 ? (
            <p className="text-sm text-ink-muted">None on file.</p>
          ) : (
            <ul className="space-y-0.5 text-sm">
              {e.signedPolicies.map((p, i) => (
                <li key={i} className="text-ink">
                  {p.title} <span className="text-ink-muted">· signed {fmtDate(p.signedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </CardContent>
    </Card>
  );
}

function OutcomeCard({ c, onChanged }: { c: UiClaim; onChanged: () => void }) {
  const [determination, setDetermination] = useState<string>(c.determination ?? '');
  const [charges, setCharges] = useState(c.chargesAmount?.toString() ?? '');
  const [hearingAt, setHearingAt] = useState(c.hearingAt ? c.hearingAt.slice(0, 16) : '');
  const [hearingOutcome, setHearingOutcome] = useState<string>(c.hearingOutcome ?? '');
  const [appealFiledAt, setAppealFiledAt] = useState(c.appealFiledAt ?? '');
  const [appealOutcome, setAppealOutcome] = useState<string>(c.appealOutcome ?? '');
  const save = useMutation({
    mutationFn: (close: boolean) =>
      patchUiClaim(c.id, {
        determination: (determination || null) as Outcome | null,
        chargesAmount: charges ? Number(charges) : null,
        hearingAt: hearingAt ? new Date(hearingAt).toISOString() : null,
        hearingOutcome: (hearingOutcome || null) as Outcome | null,
        appealFiledAt: appealFiledAt || null,
        appealOutcome: (appealOutcome || null) as Outcome | null,
        close,
      }),
    onSuccess: (_r, close) => {
      toast.success(close ? 'Claim closed.' : 'Saved.');
      onChanged();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const outcomeSelect = (value: string, set: (v: string) => void, label: string) => (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">Not decided</option>
          <option value="DENIED">Benefits denied</option>
          <option value="ALLOWED">Benefits allowed</option>
        </Select>
      )}
    </Field>
  );
  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Determination, hearing and appeal</h3>
          {c.outcome && <Badge variant={c.outcome === 'DENIED' ? 'success' : 'pending'}>{OUTCOME_TEXT[c.outcome]}</Badge>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {outcomeSelect(determination, setDetermination, 'First determination')}
          <Field label="Benefits charged to your account" hint="From the state’s charge notice">
            {(p) => <Input {...p} type="number" min={0} step="0.01" value={charges} onChange={(e) => setCharges(e.target.value)} />}
          </Field>
          <Field label="Hearing">{(p) => <Input {...p} type="datetime-local" value={hearingAt} onChange={(e) => setHearingAt(e.target.value)} />}</Field>
          {outcomeSelect(hearingOutcome, setHearingOutcome, 'Hearing outcome')}
          <Field label="Appeal filed">{(p) => <Input {...p} type="date" value={appealFiledAt} onChange={(e) => setAppealFiledAt(e.target.value)} />}</Field>
          {outcomeSelect(appealOutcome, setAppealOutcome, 'Appeal outcome')}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button loading={save.isPending} onClick={() => save.mutate(false)}>
            Save
          </Button>
          {c.status !== 'CLOSED' && c.outcome && (
            <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate(true)}>
              Close the claim
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RespondDialog({ c, e, onClose, onDone }: { c: UiClaim; e: ClaimEvidence; onClose: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<'CONTEST' | 'DO_NOT_CONTEST'>(e.posture.kind === 'weak' ? 'DO_NOT_CONTEST' : 'CONTEST');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => respondUiClaim(c.id, { decision, reason: reason.trim() }),
    onSuccess: () => {
      toast.success('Response recorded. Send the packet through the state’s employer portal before the due date.');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the response.'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Respond to {c.associateName}’s claim</DialogTitle>
          <DialogDescription>Due {fmtDate(c.responseDueAt)}. Alto People records your position and builds the packet; you submit it to the state.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <SegmentedControl
            ariaLabel="Position"
            value={decision}
            onChange={setDecision}
            options={[
              { value: 'CONTEST', label: 'Contest' },
              { value: 'DO_NOT_CONTEST', label: 'Don’t contest' },
            ]}
          />
          <Field label="Your statement" required hint="What happened, in plain facts — it goes on the packet.">
            {(p) => <Textarea {...p} rows={4} maxLength={2000} value={reason} onChange={(ev) => setReason(ev.target.value)} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>
            Record the response
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OfferDialog({ associateId, claimId, onClose, onDone }: { associateId: string; claimId: string | null; onClose: () => void; onDone: () => void }) {
  const [when, setWhen] = useState(new Date().toISOString().slice(0, 16));
  const [description, setDescription] = useState('');
  const [pay, setPay] = useState('');
  const [response, setResponse] = useState<OfferResponse>('PENDING');
  const [declineReason, setDeclineReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      recordWorkOffer({
        associateId,
        claimId,
        offeredAt: new Date(when).toISOString(),
        description: description.trim(),
        payRate: pay ? Number(pay) : null,
        response,
        declineReason: response === 'DECLINED' ? declineReason.trim() : null,
      }),
    onSuccess: () => {
      toast.success('Offer recorded on the claim.');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the offer.'),
  });
  const valid = description.trim().length >= 3 && (response !== 'DECLINED' || declineReason.trim().length >= 3);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record an offer of work</DialogTitle>
          <DialogDescription>An offer of suitable work they turned down is often what decides a claim after an assignment ends.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Offered on">{(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
          <Field label="Pay per hour">{(p) => <Input {...p} type="number" min={0} step="0.01" value={pay} onChange={(e) => setPay(e.target.value)} />}</Field>
          <Field label="The work offered" className="sm:col-span-2" hint="Where, which shift, how many hours">
            {(p) => <Input {...p} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <Field label="Their answer">
            {(p) => (
              <Select {...p} value={response} onChange={(e) => setResponse(e.target.value as OfferResponse)}>
                {(Object.keys(OFFER_TEXT) as OfferResponse[]).map((r) => (
                  <option key={r} value={r}>
                    {OFFER_TEXT[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {response === 'DECLINED' && (
            <Field label="Why they declined" required>
              {(p) => <Input {...p} value={declineReason} maxLength={1000} onChange={(e) => setDeclineReason(e.target.value)} />}
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>
            Record the offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OpenClaimDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [state, setState] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [claimDate, setClaimDate] = useState(today);
  const [notice, setNotice] = useState(today);
  const [due, setDue] = useState('');
  const [number, setNumber] = useState('');
  const m = useMutation({
    mutationFn: () => openUiClaim({ associateId: person!.id, state: state.trim().toUpperCase(), claimDate, noticeReceivedAt: notice, responseDueAt: due || undefined, stateClaimNumber: number.trim() || null }),
    onSuccess: (r) => {
      toast.success(`Claim recorded. The response is due ${fmtDate(r.claim.responseDueAt)}.`);
      onOpened(r.claim.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the claim.'),
  });
  const valid = !!person && /^[A-Za-z]{2}$/.test(state.trim()) && !!claimDate && !!notice;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record an unemployment claim</DialogTitle>
          <DialogDescription>From the state’s notice. The response deadline defaults to 10 days after you received it — use the date on the notice if it differs.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Claimant" className="sm:col-span-2">
            {(p) => <AssociatePicker id={p.id} value={person} onChange={setPerson} />}
          </Field>
          <Field label="State" hint="Two letters, e.g. FL">{(p) => <Input {...p} value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} />}</Field>
          <Field label="State claim number">{(p) => <Input {...p} value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} />}</Field>
          <Field label="Claim filed">{(p) => <Input {...p} type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} />}</Field>
          <Field label="Notice received">{(p) => <Input {...p} type="date" value={notice} onChange={(e) => setNotice(e.target.value)} />}</Field>
          <Field label="Response due (from the notice)" className="sm:col-span-2">
            {(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>
            Record the claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
