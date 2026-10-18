import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import {
  addTaxCertificate,
  getTaxProfile,
  revokeTaxCertificate,
  saveTaxProfile,
  type CertificateInput,
  type CertificateKind,
  type TaxProfile,
  type TaxProfileInput,
} from '@/lib/taxJurisdictionsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "Taxes we withhold" on the person record (payroll only): where the person
 * lives and works, every state and local tax that follows from it and why,
 * the home-jurisdiction details an address can't decide (a Pennsylvania PSD
 * code, an Ohio school district, an Indiana January 1 county, NYC or
 * Yonkers), and the state and local certificates on file.
 */

const CERT_LABEL: Record<CertificateKind, string> = {
  NONRESIDENCY: 'Nonresidency certificate (reciprocity)',
  LST_EXEMPTION: 'Local services tax exemption (PA)',
  PA_RESIDENCY: 'Residency certification (PA)',
  OH_IT4: 'Ohio IT 4 (school district)',
  NY_LOCAL: 'IT-2104 city of residence (NYC or Yonkers)',
};

const KIND_TEXT: Record<string, string> = {
  STATE: 'State',
  LOCAL: 'Local',
  SCHOOL: 'School district',
  TRANSIT: 'Transit',
  OLT: 'Occupational',
  EMPLOYER: 'Employer-paid',
  SUI: 'Unemployment',
};

export function TaxWithholdingCard({ associateId }: { associateId: string }) {
  const q = useQuery({ queryKey: ['tax-profile', associateId], queryFn: () => getTaxProfile(associateId) });
  if (q.isLoading) return <Skeleton className="h-56" />;
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Taxes we withhold</CardTitle>
          <CardDescription>{q.error instanceof ApiError ? q.error.message : 'Could not load the tax setup.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (q.data.employmentType !== 'W2_EMPLOYEE') return null;
  return <Loaded p={q.data} />;
}

function Loaded({ p }: { p: TaxProfile }) {
  const home = [p.home.city, [p.home.state, p.home.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Taxes we withhold</CardTitle>
        <CardDescription>Every state and local tax that follows from where {p.name.split(' ')[0]} lives and works, and why.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-ink-muted">Lives in</dt>
          <dd className="text-ink">{home || 'No home address on file'}</dd>
          <dt className="text-ink-muted">Works at</dt>
          <dd className="text-ink">
            {p.workSites.length === 0
              ? 'No current site assignment — taxed where they live'
              : p.workSites.map((s) => `${s.name}${s.city ? ` (${s.city}${s.state ? `, ${s.state}` : ''})` : ''}`).join('; ')}
          </dd>
        </dl>

        {p.unresolved.length > 0 && (
          <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-ink">
            {p.unresolved.join(' ')}
          </div>
        )}

        <section aria-labelledby={`withhold-${p.associateId}`} className="space-y-2">
          <h3 id={`withhold-${p.associateId}`} className="text-sm font-medium text-ink">
            What’s withheld
          </h3>
          {!p.withholding.some((w) => w.kind !== 'SUI') && (
            <p className="text-sm text-ink-muted">{p.home.state ? `${p.home.state} has no state or local income tax for this person.` : 'No state or local income tax applies.'}</p>
          )}
          {p.withholding.length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line">
              {p.withholding.map((w) => (
                <li key={`${w.code}-${w.resident}`} className="space-y-1 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{w.label}</span>
                    <span className="flex items-center gap-2">
                      {w.rate && <span className="text-xs tabular-nums text-ink-muted">{w.rate}</span>}
                      <Badge variant="outline" size="sm">
                        {KIND_TEXT[w.kind] ?? w.kind}
                      </Badge>
                      {w.review === 'awaiting' && (
                        <Badge variant="pending" size="sm">
                          Awaiting review
                        </Badge>
                      )}
                    </span>
                  </div>
                  <p className="text-sm text-ink-muted">
                    {w.why}
                    {w.note ? ` ${w.note}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <HomeJurisdiction p={p} />
        <Certificates p={p} />
      </CardContent>
    </Card>
  );
}

function HomeJurisdiction({ p }: { p: TaxProfile }) {
  const qc = useQueryClient();
  const state = p.home.state?.toUpperCase() ?? null;
  const [f, setF] = useState<TaxProfileInput>({});
  useEffect(() => {
    setF({
      residentPsdCode: p.profile.residentPsdCode,
      residentMunicipality: p.profile.residentMunicipality,
      residentSchoolDistrict: p.profile.residentSchoolDistrict,
      residentCountyJan1: p.profile.residentCountyJan1,
      residentLocalCode: p.profile.residentLocalCode,
    });
  }, [p.profile]);
  const save = useMutation({
    mutationFn: () => saveTaxProfile(p.associateId, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' ? null : v]))),
    onSuccess: (next) => {
      qc.setQueryData(['tax-profile', p.associateId], next);
      toast.success('Home jurisdiction saved.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the home jurisdiction.'),
  });
  const needs = state === 'PA' || state === 'OH' || state === 'IN' || state === 'NY';
  return (
    <section aria-labelledby={`home-${p.associateId}`} className="space-y-3">
      <h3 id={`home-${p.associateId}`} className="text-sm font-medium text-ink">
        Home jurisdiction
      </h3>
      {!needs ? (
        <p className="text-sm text-ink-muted">
          {state ? `Nothing more is needed for ${state}: the home address decides the local taxes.` : 'Add a home address to work out the taxes where they live.'}
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {state === 'PA' && (
              <>
                <Field label="PSD code" hint="Six digits, from the state’s municipal lookup.">
                  {(fp) => <Input {...fp} inputMode="numeric" maxLength={6} value={f.residentPsdCode ?? ''} onChange={(e) => setF({ ...f, residentPsdCode: e.target.value })} />}
                </Field>
                <Field label="Municipality">
                  {(fp) => <Input {...fp} maxLength={120} value={f.residentMunicipality ?? ''} onChange={(e) => setF({ ...f, residentMunicipality: e.target.value })} />}
                </Field>
              </>
            )}
            {state === 'OH' && (
              <Field label="School district number" hint="Four digits, from the Ohio IT 4.">
                {(fp) => <Input {...fp} inputMode="numeric" maxLength={4} value={f.residentSchoolDistrict ?? ''} onChange={(e) => setF({ ...f, residentSchoolDistrict: e.target.value })} />}
              </Field>
            )}
            {state === 'IN' && (
              <Field label="County lived in on January 1" hint="Indiana taxes by this county for the whole year.">
                {(fp) => <Input {...fp} maxLength={60} value={f.residentCountyJan1 ?? ''} onChange={(e) => setF({ ...f, residentCountyJan1: e.target.value })} />}
              </Field>
            )}
            {state === 'NY' && (
              <Field label="City of residence">
                {(fp) => (
                  <Select {...fp} value={f.residentLocalCode ?? ''} onChange={(e) => setF({ ...f, residentLocalCode: e.target.value })}>
                    <option value="">From the home address</option>
                    <option value="NY-NYC">New York City</option>
                    <option value="NY-YONKERS">Yonkers</option>
                  </Select>
                )}
              </Field>
            )}
          </div>
          <Button type="submit" size="sm" loading={save.isPending}>
            Save home jurisdiction
          </Button>
        </form>
      )}
    </section>
  );
}

const STATE_RE = /^[A-Za-z]{2}$/;

function Certificates({ p }: { p: TaxProfile }) {
  const qc = useQueryClient();
  const homeState = p.home.state?.toUpperCase() ?? '';
  const [adding, setAdding] = useState(false);
  const [c, setC] = useState<CertificateInput>({ kind: 'NONRESIDENCY', state: '' });
  const add = useMutation({
    mutationFn: () => addTaxCertificate(p.associateId, { ...c, state: c.state.toUpperCase() }),
    onSuccess: (next) => {
      qc.setQueryData(['tax-profile', p.associateId], next);
      setAdding(false);
      setC({ kind: 'NONRESIDENCY', state: '' });
      toast.success('Certificate recorded.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the certificate.'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeTaxCertificate(p.associateId, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tax-profile', p.associateId] });
      toast.success('Certificate revoked.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not revoke the certificate.'),
  });
  const pick = (kind: CertificateKind) => {
    const fixed: Partial<Record<CertificateKind, string>> = { PA_RESIDENCY: 'PA', LST_EXEMPTION: 'PA', OH_IT4: 'OH', NY_LOCAL: 'NY' };
    setC({ kind, state: fixed[kind] ?? (kind === 'NONRESIDENCY' ? '' : homeState) });
  };
  return (
    <section aria-labelledby={`certs-${p.associateId}`} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`certs-${p.associateId}`} className="text-sm font-medium text-ink">
          State and local certificates
        </h3>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add a certificate
          </Button>
        )}
      </div>
      {p.certificates.length === 0 && !adding && <p className="text-sm text-ink-muted">None on file.</p>}
      {p.certificates.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {p.certificates.map((cert) => (
            <li key={cert.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <span className="text-sm">
                <span className="text-ink">{cert.formName ?? CERT_LABEL[cert.kind]}</span>
                <span className="ml-2 text-ink-muted">
                  {cert.state}
                  {cert.signedOn ? ` · signed ${fmtDate(cert.signedOn)}` : ` · recorded ${fmtDate(cert.createdAt)}`}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => revoke.mutate(cert.id)} loading={revoke.isPending && revoke.variables === cert.id}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form
          className="space-y-3 rounded-md border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Certificate" className="sm:col-span-2">
              {(fp) => (
                <Select {...fp} value={c.kind} onChange={(e) => pick(e.target.value as CertificateKind)}>
                  {(Object.keys(CERT_LABEL) as CertificateKind[]).map((k) => (
                    <option key={k} value={k}>
                      {CERT_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={c.kind === 'NONRESIDENCY' ? 'Work state it’s filed with' : 'State'} hint={c.kind === 'NONRESIDENCY' ? 'Two letters, like NJ.' : undefined}>
              {(fp) => <Input {...fp} maxLength={2} value={c.state} onChange={(e) => setC({ ...c, state: e.target.value.toUpperCase() })} />}
            </Field>
            <Field label="Signed on">
              {(fp) => <Input {...fp} type="date" value={c.signedOn ?? ''} onChange={(e) => setC({ ...c, signedOn: e.target.value || null })} />}
            </Field>
            {c.kind === 'PA_RESIDENCY' && (
              <Field label="PSD code">
                {(fp) => <Input {...fp} inputMode="numeric" maxLength={6} value={c.psdCode ?? ''} onChange={(e) => setC({ ...c, psdCode: e.target.value })} />}
              </Field>
            )}
            {c.kind === 'OH_IT4' && (
              <Field label="School district number">
                {(fp) => <Input {...fp} inputMode="numeric" maxLength={4} value={c.schoolDistrict ?? ''} onChange={(e) => setC({ ...c, schoolDistrict: e.target.value })} />}
              </Field>
            )}
            {c.kind === 'NY_LOCAL' && (
              <Field label="City of residence">
                {(fp) => (
                  <Select {...fp} value={c.jurisdictionCode ?? ''} onChange={(e) => setC({ ...c, jurisdictionCode: e.target.value || null })}>
                    <option value="">Neither</option>
                    <option value="NY-NYC">New York City</option>
                    <option value="NY-YONKERS">Yonkers</option>
                  </Select>
                )}
              </Field>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={add.isPending} disabled={!STATE_RE.test(c.state)}>
              Record certificate
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
