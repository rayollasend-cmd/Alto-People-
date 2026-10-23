import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { TRUST_AREA_STATUS_LABELS, type Soc2Stage, type TrustAreaPublic, type TrustAreaStatus, type TrustSummaryPublic } from '@alto-people/shared';
import { getTrustPublic } from '@/lib/trustApi';
import { fmtDateTime } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Commitments, Soc2Block, SubProcessors, TrustRequestForm } from '@/components/trust/TrustBlocks';
import { PublicShell } from '@/components/trust/PublicShell';

/**
 * The public Trust Center (UX upgrade step 4; owner decision 5): what a
 * prospect's security review can read without an account — statuses,
 * dates and counts, the sub-processors, the commitments. No sign-in, no
 * app chrome; the hybrid access model's public half (the reports and the
 * questionnaire answers come by request through the security contact).
 * The status page and the accessibility statement share its shell.
 *
 * F500 G5: it leads with what is monitored, not "3 / 16 controls passing"
 * and a red "Failed" row, and it reads in a customer's words — the five
 * areas a security review reads by, one status each, every control by its
 * plain name. The evidence catalog's technical lines (scripts, brief steps)
 * stay with the signed-in evidence page; the API no longer sends them here.
 *
 * OWNER DECISION (named, not taken): per-control pass/fail for anonymous
 * visitors. Today the public page shows one status per area and offers the
 * per-control detail through the document request form (under NDA).
 */

const AREA_TONE: Record<TrustAreaStatus, 'success' | 'pending' | 'default'> = {
  passing: 'success',
  attention: 'pending',
  'in-progress': 'default',
};

const SOC2_SHORT: Record<Soc2Stage, string> = { preparing: 'preparing', observation: 'observation period', audited: 'audited' };

function MonitoredHero({ data }: { data: TrustSummaryPublic }) {
  const chainOk = data.auditChain.ok;
  const Icon = chainOk === false ? ShieldAlert : chainOk === null ? ShieldQuestion : ShieldCheck;
  const lastChecked = data.soc2.lastEvidenceAt;
  return (
    <Card className="border-accent/30">
      <CardContent className="grid gap-6 p-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-accent-fill/15 text-accent" aria-hidden="true">
          <Icon className="h-8 w-8" />
        </div>
        <div className="min-w-0">
          <p className="text-lg font-medium text-ink" data-testid="trust-lead">
            {data.controls.total} controls monitored daily · SOC 2: {SOC2_SHORT[data.soc2.stage]}
            {lastChecked ? ` · last checked ${fmtDateTime(lastChecked)}` : ''}
          </p>
          <p className="mt-2 max-w-prose text-sm text-ink-muted">
            {chainOk === true && data.auditChain.verifiedAt ? `The audit trail’s tamper check last passed ${fmtDateTime(data.auditChain.verifiedAt)}. ` : ''}
            Audit records are kept at least {data.retention.auditYearsMinimum} years. {data.agents.registered} AI agents registered, {data.agents.certified} certified, every one with an accountable owner.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function AreaCard({ area }: { area: TrustAreaPublic }) {
  return (
    <Card data-testid="trust-area">
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-ink">{area.label}</h3>
          <Badge variant={AREA_TONE[area.status]}>{TRUST_AREA_STATUS_LABELS[area.status]}</Badge>
        </div>
        <ul className="space-y-2">
          {area.controls.map((c) => (
            <li key={c.id} className="text-sm">
              <div className="text-ink">{c.title}</div>
              {c.summary && <div className="text-xs2 text-ink-muted">{c.summary}</div>}
            </li>
          ))}
        </ul>
        {area.lastCheckedAt && <p className="text-2xs text-ink-muted">Last checked {fmtDateTime(area.lastCheckedAt)}</p>}
      </CardContent>
    </Card>
  );
}

export function PublicTrustPage() {
  const q = useQuery({ queryKey: ['trust', 'public'], queryFn: getTrustPublic, staleTime: 60_000 });
  return (
    <PublicShell eyebrow="Trust Center">
      <div>
        <div className="mb-1 text-2xs uppercase tracking-[0.18em] text-ink-muted">Trust Center</div>
        <PageHeader
          title="The trusted platform for the hybrid workforce"
          subtitle={`People, AI agents and robots managed on one platform, with a person accountable for every agent and an audit trail that cannot be edited. This page is generated from the platform’s own controls${q.data ? `, as of ${fmtDateTime(q.data.generatedAt)}` : ''}.`}
        />
      </div>
      {q.isLoading ? (
        <SkeletonRows count={5} />
      ) : q.isError || !q.data ? (
        <QueryError what="the trust center" query={q} />
      ) : (
        <>
          <MonitoredHero data={q.data} />
          <section aria-labelledby="trust-areas">
            <SectionTitle
              id="trust-areas"
              title="What we monitor"
              description="Each area’s controls collect their own evidence every day. The detail behind each check is available on request."
            />
            {/* Two across; an odd last area spans the row instead of sitting alone. */}
            <div className="grid items-start gap-3 md:grid-cols-2 md:[&>*:last-child:nth-child(odd)]:col-span-2">
              {(q.data.areas ?? []).map((a) => (
                <AreaCard key={a.key} area={a} />
              ))}
            </div>
          </section>
          <Soc2Block soc2={q.data.soc2} publicView />
          <Commitments data={q.data} />
          <SubProcessors data={q.data} />
          <TrustRequestForm securityContactSet={q.data.securityContactSet} />
        </>
      )}
    </PublicShell>
  );
}
