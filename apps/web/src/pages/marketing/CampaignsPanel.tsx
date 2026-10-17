import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Gift, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createCampaign,
  listCampaignReferrals,
  listCampaigns,
  proposeReferralBonus,
  setCampaignStatus,
  updateCampaign,
  type CampaignInput,
  type CampaignReferral,
  type ReferralCampaign,
} from '@/lib/marketingApi';
import { fmtDate, fmtMoney, ymdLocal } from '@/lib/format';
import { STAGE_LABEL } from '@/pages/recruiting/recruitingLabels';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Referral campaigns: a bonus, a window, the roles it is for — and every
 * referral made under one, with where the referred person got to. When a
 * hire sticks past the waiting period, marketing proposes the bonus here;
 * it reaches Finance's desk (/marketing/bonuses) and lands on a payroll
 * run as a bonus line once approved.
 */

const STATUS_BADGE: Record<ReferralCampaign['status'], { label: string; variant: 'pending' | 'success' | 'outline' }> = {
  DRAFT: { label: 'Draft', variant: 'pending' },
  ACTIVE: { label: 'Live', variant: 'success' },
  CLOSED: { label: 'Closed', variant: 'outline' },
};

const REFERRAL_BADGE: Record<CampaignReferral['status'], { label: string; variant: 'default' | 'info' | 'success' | 'destructive' }> = {
  OPEN: { label: 'Open', variant: 'default' },
  INTERVIEWING: { label: 'Interviewing', variant: 'info' },
  HIRED: { label: 'Hired', variant: 'success' },
  REJECTED: { label: 'Not hired', variant: 'destructive' },
};

function CampaignDialog({
  campaign,
  open,
  onOpenChange,
}: {
  campaign: ReferralCampaign | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(campaign?.name ?? '');
  const [description, setDescription] = useState(campaign?.description ?? '');
  const [bonus, setBonus] = useState(campaign ? String(campaign.bonusAmount) : '250');
  const [payAfterDays, setPayAfterDays] = useState(campaign ? String(campaign.payAfterDays) : '30');
  const [startsOn, setStartsOn] = useState(campaign?.startsOn ?? ymdLocal());
  const [endsOn, setEndsOn] = useState(campaign?.endsOn ?? '');
  const [positions, setPositions] = useState(campaign?.positions.join(', ') ?? '');
  const save = useMutation({
    mutationFn: () => {
      const input: CampaignInput = {
        name: name.trim(),
        description: description.trim() || null,
        bonusAmount: Number(bonus),
        payAfterDays: Number(payAfterDays),
        startsOn,
        endsOn: endsOn || null,
        positions: positions.split(',').map((p) => p.trim()).filter(Boolean),
      };
      return campaign ? updateCampaign(campaign.id, input) : createCampaign(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['marketing', 'campaigns'] });
      toast.success(campaign ? 'Campaign updated.' : 'Campaign created — it goes live when you switch it on.');
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the campaign.'),
  });
  const valid = name.trim().length > 0 && Number(bonus) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(startsOn);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{campaign ? 'Edit campaign' : 'New referral campaign'}</DialogTitle>
          <DialogDescription>The bonus is paid to the referrer once the referred person has been on the job for the waiting period.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name" required>
              {(p) => <Input {...p} value={name} maxLength={120} placeholder="Holiday season referrals" onChange={(e) => setName(e.target.value)} />}
            </Field>
          </div>
          <Field label="Bonus ($)" required>
            {(p) => <Input {...p} type="number" min="1" step="25" value={bonus} onChange={(e) => setBonus(e.target.value)} />}
          </Field>
          <Field label="Paid after (days on the job)">
            {(p) => <Input {...p} type="number" min="0" max="365" value={payAfterDays} onChange={(e) => setPayAfterDays(e.target.value)} />}
          </Field>
          <Field label="Starts" required>
            {(p) => <Input {...p} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}
          </Field>
          <Field label="Ends" hint="Leave empty for open-ended.">
            {(p) => <Input {...p} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
          </Field>
          <div className="sm:col-span-2">
            <Field label="Positions" hint="Comma-separated; empty means any role.">
              {(p) => <Input {...p} value={positions} placeholder="Cashier, Stocker" onChange={(e) => setPositions(e.target.value)} />}
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="What to tell people">
              {(p) => <Textarea {...p} rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid || save.isPending}>
            {campaign ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CampaignsPanel({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const campaigns = useQuery({ queryKey: ['marketing', 'campaigns'], queryFn: listCampaigns });
  const [selected, setSelected] = useState<string | 'all'>('all');
  const referrals = useQuery({
    queryKey: ['marketing', 'referrals', selected],
    queryFn: () => listCampaignReferrals(selected === 'all' ? undefined : selected),
  });
  const [editing, setEditing] = useState<ReferralCampaign | null | 'new'>(null);
  const status = useMutation({
    mutationFn: ({ id, to }: { id: string; to: 'ACTIVE' | 'CLOSED' }) => setCampaignStatus(id, to),
    onSuccess: (c) => {
      void queryClient.invalidateQueries({ queryKey: ['marketing', 'campaigns'] });
      toast.success(c.status === 'ACTIVE' ? `${c.name} is live.` : `${c.name} closed.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the campaign.'),
  });
  const propose = useMutation({
    mutationFn: (r: CampaignReferral) => proposeReferralBonus(r.id, !r.eligible),
    onSuccess: (_r, referral) => {
      void queryClient.invalidateQueries({ queryKey: ['marketing', 'referrals'] });
      toast.success(`Bonus for ${referral.candidateName}'s referral sent to Finance.`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not propose the bonus.'),
  });
  const rows = campaigns.data?.campaigns ?? null;

  return (
    <div className="space-y-6">
      <section aria-labelledby="campaigns" className="space-y-3">
        <SectionTitle
          id="campaigns"
          title="Campaigns"
          description="A bonus and a window. Associates see live campaigns when they refer someone."
          trailing={
            canEdit ? (
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New campaign
              </Button>
            ) : undefined
          }
        />
        {campaigns.isError ? (
          <QueryError what="campaigns" query={campaigns} />
        ) : rows === null ? (
          <SkeletonRows count={3} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Gift} title="No campaign yet" description="A referral bonus is the cheapest hire you will make. Start one for the roles you need most." className="py-8" />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {rows.map((c) => (
              <li key={c.id}>
                <Card className={selected === c.id ? 'border-accent/60' : undefined}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" className="min-w-0 text-left" onClick={() => setSelected(selected === c.id ? 'all' : c.id)}>
                        <div className="truncate text-sm font-medium text-ink">{c.name}</div>
                        <div className="mt-0.5 text-xs text-ink-muted">
                          {fmtMoney(c.bonusAmount)} after {c.payAfterDays} days · {fmtDate(c.startsOn)}
                          {c.endsOn ? ` – ${fmtDate(c.endsOn)}` : ' onward'}
                          {c.positions.length ? ` · ${c.positions.join(', ')}` : ''}
                        </div>
                      </button>
                      <Badge variant={STATUS_BADGE[c.status].variant}>{STATUS_BADGE[c.status].label}</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                      <span>{c.referrals} referral{c.referrals === 1 ? '' : 's'}</span>
                      <span>{c.payouts} bonus{c.payouts === 1 ? '' : 'es'}</span>
                      {canEdit && c.status !== 'CLOSED' && (
                        <span className="ml-auto flex gap-1">
                          <Button size="xs" variant="ghost" onClick={() => setEditing(c)}>
                            Edit
                          </Button>
                          {c.status === 'DRAFT' ? (
                            <Button size="xs" variant="outline" loading={status.isPending} onClick={() => status.mutate({ id: c.id, to: 'ACTIVE' })}>
                              Go live
                            </Button>
                          ) : (
                            <Button size="xs" variant="ghost" loading={status.isPending} onClick={() => status.mutate({ id: c.id, to: 'CLOSED' })}>
                              Close
                            </Button>
                          )}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="referrals" className="space-y-3">
        <SectionTitle
          id="referrals"
          title={selected === 'all' ? 'Referrals' : `Referrals · ${rows?.find((c) => c.id === selected)?.name ?? ''}`}
          description="Who referred whom, how far they got, and the bonus on its way."
          trailing={
            <Link to="/marketing/bonuses" className="text-xs text-accent hover:underline">
              Finance's bonus desk
            </Link>
          }
        />
        {referrals.isError ? (
          <QueryError what="referrals" query={referrals} />
        ) : !referrals.data ? (
          <SkeletonRows count={4} />
        ) : referrals.data.referrals.length === 0 ? (
          <EmptyState title="No referrals here" description="Referrals associates make under a campaign show here with their progress." className="py-8" />
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-line">
                {referrals.data.referrals.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{r.candidateName}</span>
                      <span className="text-ink-muted"> referred by {r.referrerName}</span>
                      <span className="block text-xs text-ink-muted">
                        {[r.position, r.campaign?.name, r.candidateStage ? STAGE_LABEL[r.candidateStage as keyof typeof STAGE_LABEL] ?? r.candidateStage : null, `made ${fmtDate(r.createdAt)}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <Badge variant={REFERRAL_BADGE[r.status].variant}>{REFERRAL_BADGE[r.status].label}</Badge>
                    <span className="w-44 text-right text-xs">
                      {r.payout ? (
                        <Badge variant={r.payout.status === 'APPROVED' ? 'success' : r.payout.status === 'DECLINED' ? 'destructive' : 'pending'}>
                          {r.payout.status === 'APPROVED' ? (r.payout.attached ? 'On a payroll run' : 'Approved') : r.payout.status === 'DECLINED' ? 'Declined' : 'With Finance'}
                        </Badge>
                      ) : r.status === 'HIRED' && r.bonusAmount ? (
                        canEdit ? (
                          <Button
                            size="xs"
                            variant={r.eligible ? 'primary' : 'outline'}
                            loading={propose.isPending && propose.variables?.id === r.id}
                            disabled={!r.referrerHasPayroll}
                            title={!r.referrerHasPayroll ? 'The referrer has no payroll record to pay' : undefined}
                            onClick={() => propose.mutate(r)}
                          >
                            {r.eligible ? `Propose ${fmtMoney(r.bonusAmount)}` : `Propose early (${r.eligibleOn ? `due ${fmtDate(r.eligibleOn)}` : 'waiting'})`}
                          </Button>
                        ) : (
                          <span className="text-ink-muted">{r.eligible ? 'Bonus due' : r.eligibleOn ? `Due ${fmtDate(r.eligibleOn)}` : ''}</span>
                        )
                      ) : (
                        <span className="text-ink-muted">{r.bonusAmount ? fmtMoney(r.bonusAmount) : 'No bonus'}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      {editing !== null && (
        <CampaignDialog key={editing === 'new' ? 'new' : editing.id} campaign={editing === 'new' ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} />
      )}
    </div>
  );
}
