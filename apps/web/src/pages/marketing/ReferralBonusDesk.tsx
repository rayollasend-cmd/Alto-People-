import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { attachBonusPayout, decideBonusPayout, listBonusPayouts, type BonusPayout } from '@/lib/marketingApi';
import { fmtDate, fmtMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { DeskTemplate, ListTemplate, useDeskItem } from '@/components/templates';
import type { PageFact } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Finance's desk for referral bonuses: what marketing proposed, approved
 * onto a draft payroll run as a BONUS line (or declined with a word). Two
 * people on every dollar — marketing proposes, Finance decides.
 */

const STATUS: Record<BonusPayout['status'], { label: string; variant: 'pending' | 'success' | 'destructive' }> = {
  PROPOSED: { label: 'To decide', variant: 'pending' },
  APPROVED: { label: 'Approved', variant: 'success' },
  DECLINED: { label: 'Declined', variant: 'destructive' },
};

export function ReferralBonusDesk() {
  const { can } = useAuth();
  const finance = can('process:payroll');
  // The trail goes to a page this person can open: Finance (no view:marketing)
  // reaches the desk from Pay & finance, not from a Marketing page it can't see.
  const breadcrumbs = can('view:marketing')
    ? [{ label: 'Marketing', to: '/marketing' }, { label: 'Referral bonuses' }]
    : [{ label: 'Pay & finance', to: '/payroll' }, { label: 'Referral bonuses' }];
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['marketing', 'bonus-payouts'], queryFn: () => listBonusPayouts() });
  // The open bonus is in the URL (?bonus=), so a refresh or a shared link
  // reopens it and a phone's Back returns to the list.
  const desk = useDeskItem('bonus');
  const openId = desk.openId;
  const [runId, setRunId] = useState('');
  const [note, setNote] = useState('');
  const payouts = q.data?.payouts ?? null;
  const open = payouts?.find((p) => p.id === openId) ?? payouts?.find((p) => p.status === 'PROPOSED') ?? null;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['marketing'] });
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'DECLINE') => decideBonusPayout(open!.id, { decision, note: note.trim() || null, payrollRunId: decision === 'APPROVE' && runId ? runId : null }),
    onSuccess: (p) => {
      toast.success(p.status === 'APPROVED' ? (p.payrollRunId ? 'Approved and added to the run as a bonus line.' : 'Approved — attach it to a draft run when one opens.') : 'Declined.');
      setNote('');
      setRunId('');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not decide.'),
  });
  const attach = useMutation({
    mutationFn: () => attachBonusPayout(open!.id, runId),
    onSuccess: () => {
      toast.success('Added to the run as a bonus line.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not attach.'),
  });
  const toDecide = payouts?.filter((p) => p.status === 'PROPOSED').length ?? 0;
  // This calendar year's approvals: what the desk has put through.
  const year = new Date().getFullYear();
  const approvedThisYear = (payouts ?? []).filter((p) => p.status === 'APPROVED' && p.decidedAt && new Date(p.decidedAt).getFullYear() === year);
  const facts: PageFact[] | undefined = payouts
    ? [
        { label: 'To decide', value: String(toDecide) },
        { label: `Approved in ${year}`, value: `${fmtMoney(approvedThisYear.reduce((sum, p) => sum + p.amount, 0))} · ${approvedThisYear.length} bonus${approvedThisYear.length === 1 ? '' : 'es'}` },
      ]
    : undefined;

  const queue = q.isError ? (
    <QueryError what="bonuses" query={q} />
  ) : payouts === null ? (
    <SkeletonRows count={4} />
  ) : payouts.length === 0 ? (
    <EmptyState icon={Gift} title="No referral bonus to decide" description="Marketing proposes a bonus when a referred hire sticks; it shows here for Finance." className="py-8" />
  ) : (
    <ul className="divide-y divide-line" aria-label="Referral bonuses">
      {payouts.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => desk.open(p.id)}
            aria-current={open?.id === p.id ? 'true' : undefined}
            className={cn('flex w-full items-center gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-surface-raised', open?.id === p.id && 'bg-surface-raised')}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">
                {fmtMoney(p.amount)} to {p.referrerName}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                for {p.candidateName}
                {p.campaignName ? ` · ${p.campaignName}` : ''} · {fmtDate(p.createdAt)}
              </span>
            </span>
            <Badge variant={STATUS[p.status].variant}>{p.status === 'APPROVED' && p.payrollRunId ? 'On a run' : STATUS[p.status].label}</Badge>
          </button>
        </li>
      ))}
    </ul>
  );

  const item = open ? (
    <div className="space-y-4 p-4 md:p-5">
      <div>
        <div className="text-xs uppercase tracking-[0.18em] text-ink-muted">Referral bonus</div>
        <div className="mt-1 font-display text-2xl tabular-nums text-ink">{fmtMoney(open.amount)}</div>
        <div className="mt-1 text-sm text-ink-muted">
          to <span className="text-ink">{open.referrerName}</span> ({open.referrerEmail}) for referring <span className="text-ink">{open.candidateName}</span>
          {open.campaignName ? ` under ${open.campaignName}` : ''}.
        </div>
        {open.note && <p className="mt-2 text-sm text-ink-muted">{open.note}</p>}
      </div>
      {open.status === 'PROPOSED' && finance ? (
        <div className="space-y-3">
          <Field label="Put it on a draft payroll run" hint={q.data?.draftRuns.length ? 'The line is added as BONUS and the run re-totals.' : 'No draft run is open — approve now and attach it when one is.'}>
            {(p) => (
              <Select {...p} value={runId} onChange={(e) => setRunId(e.target.value)} disabled={!q.data?.draftRuns.length}>
                <option value="">Approve without attaching</option>
                {q.data?.draftRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.periodStart} – {r.periodEnd} ({r.kind.toLowerCase().replace('_', ' ')})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Note" hint="Shown to marketing either way.">
            {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <div className="flex gap-2">
            <Button loading={decide.isPending && decide.variables === 'APPROVE'} disabled={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
              Approve
            </Button>
            <Button variant="outline" loading={decide.isPending && decide.variables === 'DECLINE'} disabled={decide.isPending} onClick={() => decide.mutate('DECLINE')}>
              Decline
            </Button>
          </div>
        </div>
      ) : open.status === 'APPROVED' && !open.payrollRunId && finance ? (
        <div className="space-y-3">
          <Badge variant="success">Approved{open.decidedAt ? ` ${fmtDate(open.decidedAt)}` : ''}</Badge>
          <Field label="Attach to a draft payroll run" hint={q.data?.draftRuns.length ? undefined : 'No draft run is open yet.'}>
            {(p) => (
              <Select {...p} value={runId} onChange={(e) => setRunId(e.target.value)} disabled={!q.data?.draftRuns.length}>
                <option value="">Choose a run</option>
                {q.data?.draftRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.periodStart} – {r.periodEnd}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button loading={attach.isPending} disabled={!runId || attach.isPending} onClick={() => attach.mutate()}>
            Add to the run
          </Button>
        </div>
      ) : (
        <div className="space-y-1 text-sm">
          <Badge variant={STATUS[open.status].variant}>{STATUS[open.status].label}</Badge>
          {open.decidedAt && (
            <p className="text-ink-muted">
              {open.status === 'APPROVED' ? 'Approved' : 'Declined'} {fmtDate(open.decidedAt)}
              {open.decidedBy ? ` by ${open.decidedBy}` : ''}
              {open.decisionNote ? ` — ${open.decisionNote}` : ''}
            </p>
          )}
          {open.payrollRunId && (
            <p>
              <Link to="/payroll" className="text-accent hover:underline">
                On a payroll run as a bonus line
              </Link>
            </p>
          )}
          {!finance && open.status === 'PROPOSED' && <p className="text-ink-muted">Waiting on Finance.</p>}
        </div>
      )}
    </div>
  ) : (
    <EmptyState title="Pick a bonus" description="Choose one on the left to decide it." className="py-12" />
  );

  // Nothing proposed yet: one empty state with the year's totals, not a list
  // pane beside a "Pick a bonus" pane with nothing to pick (F500 G4).
  if (payouts !== null && payouts.length === 0 && !q.isError) {
    return (
      <ListTemplate title="Referral bonuses" topbarTitle="Referral bonuses" subtitle="Marketing proposes, Finance approves onto a payroll run." breadcrumbs={breadcrumbs} facts={facts}>
        <EmptyState
          icon={Gift}
          title="No referral bonus proposed yet"
          description="Marketing proposes a bonus when a referred hire sticks; it shows here for Finance to approve onto a payroll run."
          className="rounded-lg border border-dashed border-line py-10"
        />
      </ListTemplate>
    );
  }

  return (
    <DeskTemplate
      title="Referral bonuses"
      topbarTitle="Referral bonuses"
      subtitle="Marketing proposes, Finance approves onto a payroll run."
      breadcrumbs={breadcrumbs}
      facts={facts}
      queue={queue}
      item={item}
      // On a phone the list is the screen until a bonus is picked; on a wide
      // screen the first one waiting is shown beside it.
      itemParam="bonus"
      backLabel="All bonuses"
    />
  );
}
