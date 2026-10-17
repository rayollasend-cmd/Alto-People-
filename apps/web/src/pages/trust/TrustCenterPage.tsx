import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { getTrust } from '@/lib/trustApi';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Commitments, ControlsTable, SubProcessors, TrustHero, statusBadge } from '@/components/trust/TrustBlocks';

/**
 * Trust Center, signed in (UX upgrade step 4; design system §4.4 area
 * page): the platform's controls and chain, then this organization's own
 * numbers — chain, retention, SIEM, sign-in, agents, decision records,
 * access review — each linking to the page where it is managed.
 */
export function TrustCenterPage() {
  const q = useQuery({ queryKey: ['trust', 'summary'], queryFn: getTrust, staleTime: 60_000 });
  if (q.isLoading) return <SkeletonRows count={6} />;
  if (q.isError || !q.data) return <QueryError what="the trust center" query={q} />;
  const d = q.data;
  const t = d.tenant;
  const rows: Array<{ label: string; value: React.ReactNode; to: string }> = [
    { label: 'Audit hash chain', value: t.auditChain.ok === null ? statusBadge('PENDING') : <span className="flex items-center gap-2">{statusBadge(t.auditChain.ok ? 'PASS' : 'FAIL')}<span className="text-xs2 text-ink-muted">{t.auditChain.rows} rows{t.auditChain.verifiedAt ? ` · ${fmtDateTime(t.auditChain.verifiedAt)}` : ''}</span></span>, to: '/audit' },
    { label: 'Audit retention', value: <span>{t.retentionYears} years · {t.archives} archive{t.archives === 1 ? '' : 's'}</span>, to: '/audit' },
    { label: 'SIEM stream', value: statusBadge(t.siem), to: '/audit' },
    { label: 'Single sign-on', value: t.sso.connections ? <span className="flex items-center gap-2"><Badge variant="success">{t.sso.connections} connection{t.sso.connections === 1 ? '' : 's'}</Badge>{t.sso.ssoRequiredForStaff && <Badge variant="accent">Required for staff</Badge>}</span> : <Badge variant="outline">Passwords and passkeys</Badge>, to: '/admin/sign-in' },
    { label: 'Directory provisioning (SCIM)', value: statusBadge(t.sso.scim ? 'ON' : 'OFF'), to: '/admin/sign-in' },
    // "Certified" here is what each agent's own Certification tab means: certified for the version it runs now.
    { label: 'Agents', value: <span>{t.agents.registered} registered · {t.agents.active} active · {t.agents.certified} certified{t.agents.suspended ? ` · ${t.agents.suspended} suspended` : ''}</span>, to: '/agents' },
    { label: 'Approval gates in force', value: <span>{t.agents.gates}</span>, to: '/admin/agents#gates' },
    { label: 'Automated decisions recorded', value: <span>{t.agents.decisionRecords}{t.agents.lastBiasAuditAt ? ` · last bias audit ${fmtDateTime(t.agents.lastBiasAuditAt)}` : ' · no bias audit yet'}</span>, to: '/admin/agents#decision-record' },
    { label: 'Quarterly access review', value: t.accessReview.lastAt ? <span className="flex items-center gap-2">{statusBadge(t.accessReview.signedOff ? 'PASS' : 'WARN')}<span className="text-xs2 text-ink-muted">{fmtDateTime(t.accessReview.lastAt)}{t.accessReview.signedOff ? '' : ' · waiting for sign-off'}</span></span> : statusBadge('PENDING'), to: '/admin/users' },
  ];
  return (
    <div className="space-y-6" data-template="settings">
      <PageHeader
        title="Trust Center"
        subtitle="How the platform is run, with the evidence: the controls, the audit chain, the agents and their governance. The public page says the same with your numbers left out."
        breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Trust Center' }]}
        primaryAction={
          <span className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href="/status" target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Status page
              </a>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <a href="/trust-center" target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Public page
              </a>
            </Button>
          </span>
        }
      />
      <TrustHero data={d} />
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
      <section aria-labelledby="trust-controls">
        <SectionTitle id="trust-controls" title="Platform controls" description={`${d.controls.passing} of ${d.controls.total} passing, each collecting its own evidence.`} />
        <ControlsTable items={d.controls.items} />
      </section>
      <Commitments data={d} />
      <SubProcessors data={d} />
    </div>
  );
}
