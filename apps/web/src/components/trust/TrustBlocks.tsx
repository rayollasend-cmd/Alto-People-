import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { toast } from 'sonner';
import { SOC2_STAGE_LABELS, TRUST_DOCUMENT_KINDS, TRUST_DOCUMENT_LABELS, type Soc2Progress, type Soc2Stage, type TrustControlPublic, type TrustDocumentKind, type TrustDownloadRequestInput, type TrustStatus, type TrustSummaryPublic } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { requestTrustDocument } from '@/lib/trustApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';

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
                : `The audit trail’s hash chain failed verification${data.auditChain.verifiedAt ? ` ${fmtDateTime(data.auditChain.verifiedAt)}` : ''} — the team has been alerted and is investigating.`}{' '}
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
        <div className="overflow-x-auto">
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
        </div>
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
          <div className="overflow-x-auto">
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
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ------------------------------------------------------------- SOC 2 ---- */

const STAGE_ORDER: Soc2Stage[] = ['preparing', 'observation', 'audited'];
const STAGE_SHORT: Record<Soc2Stage, string> = { preparing: 'Preparing', observation: 'Observation period', audited: 'Audited' };

/**
 * Where SOC 2 stands, from the controls' evidence: three steps, the current
 * one marked, with the numbers behind it. The same block on the public page
 * and the signed-in one, so neither claims more than the other.
 */
export function Soc2Block({ soc2 }: { soc2: Soc2Progress }) {
  const current = STAGE_ORDER.indexOf(soc2.stage);
  return (
    <section aria-labelledby="trust-soc2">
      <SectionTitle id="trust-soc2" title="SOC 2 progress" description={SOC2_STAGE_LABELS[soc2.stage]} />
      <Card>
        <CardContent className="space-y-4 p-5">
          <ol className="grid gap-2 sm:grid-cols-3" aria-label="SOC 2 stages">
            {STAGE_ORDER.map((stage, i) => (
              <li key={stage} className={`rounded-lg border px-4 py-3 ${i === current ? 'border-accent bg-accent-fill/10' : 'border-line'}`} aria-current={i === current ? 'step' : undefined}>
                <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Step {i + 1}</div>
                <div className="mt-0.5 flex items-center gap-2 font-medium text-ink">
                  {STAGE_SHORT[stage]}
                  {i < current && <Badge variant="success">Done</Badge>}
                  {i === current && <Badge variant="accent">Now</Badge>}
                </div>
              </li>
            ))}
          </ol>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">Controls with current evidence</dt>
              <dd className="font-medium tabular-nums text-ink">
                {soc2.controlsCurrent} / {soc2.controlsTotal} <span className="font-normal text-ink-muted">({soc2.controlsPassing} passing)</span>
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Last evidence collected</dt>
              <dd className="font-medium tabular-nums text-ink">{soc2.lastEvidenceAt ? fmtDateTime(soc2.lastEvidenceAt) : 'Not yet'}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{soc2.stage === 'audited' ? 'Report issued' : 'Observation since'}</dt>
              <dd className="font-medium tabular-nums text-ink">{soc2.stage === 'audited' ? (soc2.reportIssuedOn ?? '—') : (soc2.observationSince ?? 'Not yet: every control must have current evidence first')}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}

/* --------------------------------------------------------- request form -- */

/**
 * The public ask for a report. The documents are gated: a person on the
 * operator's side approves, and a signed link that expires in seven days goes
 * to the work email given here.
 */
export function TrustRequestForm({ securityContactSet }: { securityContactSet: boolean }) {
  const [form, setForm] = useState<TrustDownloadRequestInput>({ name: '', email: '', company: '', kind: 'SOC2_REPORT', note: '' });
  const [done, setDone] = useState(false);
  const ask = useMutation({
    mutationFn: () => requestTrustDocument({ ...form, note: form.note?.trim() ? form.note.trim() : undefined }),
    onSuccess: () => setDone(true),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not send the request.'),
  });
  const valid = form.name.trim().length >= 2 && /@/.test(form.email) && form.company.trim().length >= 2;
  return (
    <section aria-labelledby="trust-request" className="rounded-lg border border-line bg-surface p-5">
      <SectionTitle id="trust-request" title="Reports and questionnaires" className="mb-0" />
      <p className="mt-1 max-w-prose text-sm text-ink-muted">
        The SOC 2 report, the penetration test summary, the sub-processor list and the data processing addendum are shared under NDA. Ask below; a person
        {securityContactSet ? ' on the security team' : ' on the account team'} approves each request, and the link you receive works for seven days.
      </p>
      {done ? (
        <p className="mt-4 rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-ink" role="status">
          Request received. Once it is approved, the link goes to {form.email.trim().toLowerCase()}.
        </p>
      ) : (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) ask.mutate();
          }}
        >
          <Field label="Your name" required>{(fp) => <Input {...fp} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoComplete="name" />}</Field>
          <Field label="Work email" required>{(fp) => <Input {...fp} type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} autoComplete="email" />}</Field>
          <Field label="Company" required>{(fp) => <Input {...fp} value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} autoComplete="organization" />}</Field>
          <Field label="Document" required>
            {(fp) => (
              <Select {...fp} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as TrustDocumentKind }))}>
                {TRUST_DOCUMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TRUST_DOCUMENT_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="What is it for" className="sm:col-span-2">{(fp) => <Input {...fp} value={form.note ?? ''} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Vendor security review, Q4" />}</Field>
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" disabled={!valid} loading={ask.isPending}>
              Request the document
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
