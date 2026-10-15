import type { ReactNode } from 'react';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { TrustControlPublic, TrustStatus, TrustSummaryPublic } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * The Trust Center's building blocks, shared by the public page and the
 * signed-in view so the two never say different things.
 */

export function statusBadge(status: TrustStatus | 'ON' | 'OFF' | 'FAILING') {
  switch (status) {
    case 'PASS':
    case 'ON':
      return <Badge variant="success">{status === 'ON' ? 'On' : 'Passing'}</Badge>;
    case 'WARN':
      return <Badge variant="pending">Attention</Badge>;
    case 'FAIL':
    case 'FAILING':
      return <Badge variant="destructive">{status === 'FAILING' ? 'Failing' : 'Failed'}</Badge>;
    case 'OFF':
      return <Badge variant="outline">Off</Badge>;
    default:
      return <Badge variant="outline">Pending</Badge>;
  }
}

export function TrustHero({ data, children }: { data: TrustSummaryPublic; children?: ReactNode }) {
  const { passing, total } = data.controls;
  const chainOk = data.auditChain.ok;
  const Icon = chainOk === false ? ShieldAlert : chainOk === null ? ShieldQuestion : ShieldCheck;
  return (
    <Card className="border-accent/30">
      <CardContent className="grid gap-6 p-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
        <div className={`grid h-16 w-16 place-items-center rounded-full ${chainOk === false ? 'bg-negative/15 text-negative' : 'bg-accent-fill/15 text-accent'}`} aria-hidden="true">
          <Icon className="h-8 w-8" />
        </div>
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Controls passing</div>
          <div className="mt-1 font-sans text-4xl font-semibold tabular-nums text-ink">
            {passing}
            <span className="text-xl text-ink-muted"> / {total}</span>
          </div>
          <p className="mt-2 max-w-prose text-sm text-ink-muted">
            {chainOk === null
              ? 'The audit trail’s hash chain has not been verified yet.'
              : chainOk
                ? `Audit trail hash chain verified ${data.auditChain.verifiedAt ? fmtDateTime(data.auditChain.verifiedAt) : ''}.`
                : `The audit trail’s hash chain FAILED verification ${data.auditChain.verifiedAt ? fmtDateTime(data.auditChain.verifiedAt) : ''}; the team has been alerted.`}{' '}
            Audit records are kept at least {data.retention.auditYearsMinimum} years. {data.agents.registered} AI agents registered, {data.agents.certified} certified, every one with an accountable owner.
          </p>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

export function ControlsTable({ items }: { items: TrustControlPublic[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-[0.18em] text-ink-muted">
              <th className="px-4 py-2">Control</th>
              <th className="hidden px-4 py-2 md:table-cell">Criteria</th>
              <th className="px-4 py-2">Status</th>
              <th className="hidden px-4 py-2 md:table-cell">Last checked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((c) => (
              <tr key={c.id} className="align-top text-ink">
                <td className="px-4 py-3">
                  <div className="font-medium">{c.title}</div>
                  <div className="mt-0.5 text-xs2 text-ink-muted">{c.how}</div>
                </td>
                <td className="hidden px-4 py-3 text-xs2 text-ink-muted md:table-cell">{c.criteria.join(', ')}</td>
                <td className="px-4 py-3">{statusBadge(c.status)}</td>
                <td className="hidden px-4 py-3 text-xs2 tabular-nums text-ink-muted md:table-cell">{c.checkedAt ? fmtDateTime(c.checkedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function Commitments({ data }: { data: TrustSummaryPublic }) {
  return (
    <section aria-labelledby="trust-commitments">
      <SectionTitle id="trust-commitments" title="How the platform is run" />
      <div className="grid gap-3 md:grid-cols-2">
        {data.commitments.map((c) => (
          <div key={c.title} className="rounded-lg border border-line bg-surface p-4">
            <div className="font-medium text-ink">{c.title}</div>
            <p className="mt-1 text-sm text-ink-muted">{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function SubProcessors({ data }: { data: TrustSummaryPublic }) {
  return (
    <section aria-labelledby="trust-subprocessors">
      <SectionTitle id="trust-subprocessors" title="Sub-processors" description="The vendors that process customer data for the platform, and what for." />
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-[0.18em] text-ink-muted">
                <th className="px-4 py-2">Vendor</th>
                <th className="px-4 py-2">Purpose</th>
                <th className="hidden px-4 py-2 md:table-cell">Region</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.subProcessors.map((s) => (
                <tr key={s.name} className="text-ink">
                  <td className="px-4 py-2">
                    <a className="underline decoration-line underline-offset-2 hover:text-accent" href={s.url} target="_blank" rel="noreferrer">
                      {s.name}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-ink-muted">{s.purpose}</td>
                  <td className="hidden px-4 py-2 text-ink-muted md:table-cell">{s.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </section>
  );
}
