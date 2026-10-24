import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, ExternalLink } from '@/components/ui/icons';
import type { ControlStatus, TrustControlPublic } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { getTrust } from '@/lib/trustApi';
import { TrustRequestsSection } from './TrustRequestsSection';
import { fmtCount, fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Commitments, ControlsTable, Soc2Block, SubProcessors, TrustHero, controlStatusBadge, statusBadge } from '@/components/trust/TrustBlocks';

/** Worst first: what a person must act on before what is merely missing. */
const SEVERITY: Record<ControlStatus, number> = { FAILING: 0, NEEDS_SIGNOFF: 1, NO_EVIDENCE: 2, PASSING: 3 };
const CONTROL_FROM_TRUST = { PASS: 'PASSING', WARN: 'NEEDS_SIGNOFF', FAIL: 'FAILING', PENDING: 'NO_EVIDENCE' } as const;
const statusOf = (c: TrustControlPublic): ControlStatus => c.controlStatus ?? CONTROL_FROM_TRUST[c.status];

/** The controls that need someone, worst first — the Trust Center shows three and sends the rest to Compliance evidence. */
export function worstControls(items: readonly TrustControlPublic[], n = 3): TrustControlPublic[] {
  return items
    .filter((c) => statusOf(c) !== 'PASSING')
    .sort((a, b) => SEVERITY[statusOf(a)] - SEVERITY[statusOf(b)] || a.title.localeCompare(b.title))
    .slice(0, n);
}

/**
 * Trust Center, signed in (UX upgrade step 4; design system §4.4 area
 * page; F500 G4): how the platform stands — the controls passing and the
 * chain — then the few controls that need someone (the full table is
 * Compliance evidence's), this organization's own numbers, SOC 2, and the
 * gated documents. Each line opens where it is managed.
 */
export function TrustCenterPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['trust', 'summary'], queryFn: getTrust, staleTime: 60_000 });
  // The page keeps its name while it loads or fails — an error banner alone
  // left the top bar saying "Alto People" (F500 G4).
  const header = (
    <PageHeader
      title="Trust Center"
      subtitle="How the platform is run, with the evidence: the controls, the audit chain, the agents and their governance. The public page says the same with your numbers left out."
      actions={[
        { label: 'Public page', icon: ExternalLink, href: '/trust-center' },
        { label: 'Status page', icon: ExternalLink, href: '/status' },
      ]}
    />
  );
  if (q.isLoading)
    return (
      <div className="space-y-6" data-template="settings">
        {header}
        <SkeletonRows count={6} />
      </div>
    );
  if (q.isError || !q.data)
    return (
      <div className="space-y-6" data-template="settings">
        {header}
        <QueryError what="the trust center" query={q} />
      </div>
    );
  const d = q.data;
  const t = d.tenant;
  const worst = worstControls(d.controls.items);
  const notPassing = d.controls.total - d.controls.passing;
  const canSeeEvidence = can('view:org');
  const rows: Array<{ label: string; value: React.ReactNode; to: string }> = [
    { label: 'Audit hash chain', value: t.auditChain.ok === null ? statusBadge('PENDING') : <span className="flex items-center gap-2">{statusBadge(t.auditChain.ok ? 'PASS' : 'FAIL')}<span className="text-xs2 text-ink-muted">{fmtCount(t.auditChain.rows, 'row')}{t.auditChain.verifiedAt ? ` · ${fmtDateTime(t.auditChain.verifiedAt)}` : ''}</span></span>, to: '/audit' },
    { label: 'Audit retention', value: <span>{t.retentionYears} years · {fmtCount(t.archives, 'archive')}</span>, to: '/audit' },
    { label: 'SIEM stream', value: statusBadge(t.siem), to: '/audit' },
    { label: 'Single sign-on', value: t.sso.connections ? <span className="flex items-center gap-2"><Badge variant="success">{fmtCount(t.sso.connections, 'connection')}</Badge>{t.sso.ssoRequiredForStaff && <Badge variant="accent">Required for staff</Badge>}</span> : <Badge variant="outline">Passwords and passkeys</Badge>, to: '/admin/sign-in' },
    { label: 'Directory provisioning (SCIM)', value: statusBadge(t.sso.scim ? 'ON' : 'OFF'), to: '/admin/sign-in' },
    // "Certified" here is what each agent's own Certification tab means: certified for the version it runs now.
    { label: 'Agents', value: <span>{t.agents.registered} registered · {t.agents.active} active · {t.agents.certified} certified{t.agents.suspended ? ` · ${t.agents.suspended} suspended` : ''}</span>, to: '/agents' },
    { label: 'Approval gates in force', value: <span>{t.agents.gates}</span>, to: '/admin/agents#gates' },
    { label: 'Automated decisions recorded', value: <span>{t.agents.decisionRecords}{t.agents.lastBiasAuditAt ? ` · last bias audit ${fmtDateTime(t.agents.lastBiasAuditAt)}` : ' · no bias audit yet'}</span>, to: '/admin/agents#decision-record' },
    // The access review's home is Access certifications (F500 G4), in the one control vocabulary.
    { label: 'Quarterly access review', value: t.accessReview.lastAt ? <span className="flex items-center gap-2">{controlStatusBadge(t.accessReview.signedOff ? 'PASSING' : 'NEEDS_SIGNOFF')}<span className="text-xs2 text-ink-muted">{fmtDateTime(t.accessReview.lastAt)}</span></span> : controlStatusBadge('NO_EVIDENCE'), to: '/admin/access-certifications' },
  ];
  return (
    <div className="space-y-6" data-template="settings">
      {header}
      <TrustHero data={d} />
      <section aria-labelledby="trust-controls">
        <SectionTitle
          id="trust-controls"
          wrap
          title="Controls that need someone"
          description={notPassing === 0 ? 'Every control is passing, each on its own evidence.' : `${d.controls.passing} of ${d.controls.total} passing. ${worst.length < notPassing ? `The ${worst.length} most urgent of ${notPassing}:` : 'These are the rest:'}`}
          trailing={
            canSeeEvidence ? (
              <Link to="/admin/compliance-evidence" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                See all evidence <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            ) : undefined
          }
        />
        {worst.length > 0 && <ControlsTable items={worst} />}
      </section>
      <section aria-labelledby="trust-tenant">
        <SectionTitle id="trust-tenant" title="Your organization" description="Each line opens where it is managed." />
        <Card>
          <CardContent className="divide-y divide-line p-0">
            {rows.map((r) => (
              <Link key={r.label} to={r.to} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-ink hover:bg-surface-raised/40">
                <span className="font-medium">{r.label}</span>
                <span className="flex items-center gap-2">{r.value}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>
      <Soc2Block soc2={d.soc2} />
      {can('manage:org') && <TrustRequestsSection reportIssuedOn={d.soc2.reportIssuedOn} />}
      <Commitments data={d} />
      <SubProcessors data={d} />
    </div>
  );
}
