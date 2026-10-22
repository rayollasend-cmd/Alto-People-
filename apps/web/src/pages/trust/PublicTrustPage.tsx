import { useQuery } from '@tanstack/react-query';
import { getTrustPublic } from '@/lib/trustApi';
import { fmtDateTime } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Commitments, ControlsTable, Soc2Block, SubProcessors, TrustHero, TrustRequestForm } from '@/components/trust/TrustBlocks';
import { PublicShell } from '@/components/trust/PublicShell';

/**
 * The public Trust Center (UX upgrade step 4; owner decision 5): what a
 * prospect's security review can read without an account — statuses,
 * dates and counts, the sub-processors, the commitments. No sign-in, no
 * app chrome; the hybrid access model's public half (the reports and the
 * questionnaire answers come by request through the security contact).
 * The status page and the accessibility statement share its shell.
 */
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
          <TrustHero data={q.data} />
          <Soc2Block soc2={q.data.soc2} />
          <section aria-labelledby="trust-controls">
            <SectionTitle id="trust-controls" title="Controls" description={`${q.data.controls.passing} of ${q.data.controls.total} passing, each collecting its own evidence.`} />
            <ControlsTable items={q.data.controls.items} />
          </section>
          <Commitments data={q.data} />
          <SubProcessors data={q.data} />
          <TrustRequestForm securityContactSet={q.data.securityContactSet} />
        </>
      )}
    </PublicShell>
  );
}
