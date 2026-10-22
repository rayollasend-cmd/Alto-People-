import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileUp, Inbox, X } from 'lucide-react';
import { toast } from 'sonner';
import { TRUST_DOCUMENT_KINDS, TRUST_DOCUMENT_LABELS, type TrustDocumentKind, type TrustDownloadRequestSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { decideTrustRequest, listTrustDocuments, listTrustRequests, setSoc2ReportDate, uploadTrustDocument } from '@/lib/trustApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

const err = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

const STATUS_VARIANT: Record<TrustDownloadRequestSummary['status'], 'pending' | 'success' | 'outline'> = { PENDING: 'pending', APPROVED: 'success', DECLINED: 'outline' };

/**
 * The operator's side of the gated downloads (audit 2026-10-21): the
 * requests from the public page, approve or decline each, the documents on
 * file (one per kind), and the SOC 2 report date that lets the Trust Center
 * say "audited".
 */
export function TrustRequestsSection({ reportIssuedOn }: { reportIssuedOn: string | null }) {
  const qc = useQueryClient();
  const requests = useQuery({ queryKey: ['trust', 'requests'], queryFn: listTrustRequests });
  const documents = useQuery({ queryKey: ['trust', 'documents'], queryFn: listTrustDocuments });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['trust'] });
  };
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVED' | 'DECLINED' }) => decideTrustRequest(id, decision),
    onSuccess: (r) => {
      toast.success(r.status === 'APPROVED' ? `Approved. A link that works for seven days went to ${r.email}.` : `Declined. ${r.name} was not told.`);
      invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not record the decision.')),
  });

  const [kind, setKind] = useState<TrustDocumentKind>('SOC2_REPORT');
  const [title, setTitle] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new Error('Choose the PDF first.');
      return uploadTrustDocument({ kind, title: title.trim(), file });
    },
    onSuccess: (d) => {
      toast.success(`${d.title} is on file as the ${TRUST_DOCUMENT_LABELS[d.kind].toLowerCase()}.`);
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
      invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not upload the document.')),
  });

  const [dated, setDated] = useState(reportIssuedOn ?? '');
  const date = useMutation({
    mutationFn: (value: string | null) => setSoc2ReportDate(value),
    onSuccess: (r) => {
      toast.success(r.reportIssuedOn ? `The Trust Center now says audited, report issued ${r.reportIssuedOn}.` : 'The report date was withdrawn; the stage follows the evidence again.');
      invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not save the date.')),
  });

  const rows = requests.data?.requests ?? [];
  const pending = rows.filter((r) => r.status === 'PENDING');

  return (
    <>
      <section aria-labelledby="trust-requests">
        <SectionTitle id="trust-requests" title="Report requests" description={pending.length ? `${pending.length} waiting for a decision. Approving emails a signed link that works for seven days.` : 'Requests from the public page. Approving emails a signed link that works for seven days.'} />
        {requests.isError ? (
          <QueryError what="the requests" query={requests} />
        ) : requests.isPending ? (
          <Skeleton className="h-32" />
        ) : rows.length === 0 ? (
          <EmptyState icon={Inbox} title="No requests" description="When a prospect asks for a report on the public page, it lands here." />
        ) : (
          <Card>
            <CardContent className="divide-y divide-line p-0">
              {rows.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">
                      {TRUST_DOCUMENT_LABELS[r.kind]} · {r.company}
                    </div>
                    <div className="text-xs2 text-ink-muted">
                      {r.name} · {r.email} · asked {fmtDateTime(r.requestedAt)}
                      {r.note ? ` · ${r.note}` : ''}
                      {r.status === 'APPROVED' ? ` · ${r.downloadCount} download${r.downloadCount === 1 ? '' : 's'}${r.linkExpiresAt ? `, link until ${fmtDateTime(r.linkExpiresAt)}` : ''}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status === 'PENDING' ? 'Waiting' : r.status === 'APPROVED' ? 'Approved' : 'Declined'}</Badge>
                    {r.status === 'PENDING' && (
                      <>
                        <Button size="xs" onClick={() => decide.mutate({ id: r.id, decision: 'APPROVED' })} loading={decide.isPending} disabled={!r.documentOnFile} title={r.documentOnFile ? undefined : `Upload the ${TRUST_DOCUMENT_LABELS[r.kind].toLowerCase()} first`}>
                          <Check className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => decide.mutate({ id: r.id, decision: 'DECLINED' })} loading={decide.isPending}>
                          <X className="h-3.5 w-3.5" />
                          Decline
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="trust-documents">
        <SectionTitle id="trust-documents" title="Documents on file" description="One current PDF per kind. A new upload replaces the old one; links already sent open the current file." />
        <Card>
          <CardContent className="space-y-4 p-5">
            {documents.isPending ? (
              <Skeleton className="h-16" />
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {TRUST_DOCUMENT_KINDS.map((k) => {
                  const d = documents.data?.documents.find((x) => x.kind === k);
                  return (
                    <li key={k} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{TRUST_DOCUMENT_LABELS[k]}</span>
                        <span className="block truncate text-xs2 text-ink-muted">{d ? `${d.title} · ${Math.round(d.bytes / 1024)} KB · ${fmtDateTime(d.updatedAt)}` : 'Not on file'}</span>
                      </span>
                      <Badge variant={d ? 'success' : 'outline'}>{d ? 'On file' : 'Missing'}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            <form
              className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                upload.mutate();
              }}
            >
              <Field label="Kind">
                {(fp) => (
                  <Select {...fp} value={kind} onChange={(e) => setKind(e.target.value as TrustDocumentKind)}>
                    {TRUST_DOCUMENT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {TRUST_DOCUMENT_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Title" required>{(fp) => <Input {...fp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="SOC 2 Type II report, 2026" />}</Field>
              <Field label="PDF" required>{(fp) => <Input {...fp} ref={fileRef} type="file" accept="application/pdf" />}</Field>
              <Button type="submit" variant="secondary" loading={upload.isPending} disabled={title.trim().length < 2}>
                <FileUp className="h-4 w-4" />
                Upload
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="trust-soc2-date">
        <SectionTitle id="trust-soc2-date" title="SOC 2 report date" description="Set only once an auditor has issued the report. Until then the Trust Center says preparing or observation, from the evidence." />
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-5">
            <Field label="Report issued on">{(fp) => <Input {...fp} type="date" value={dated} onChange={(e) => setDated(e.target.value)} />}</Field>
            <Button variant="secondary" onClick={() => date.mutate(dated || null)} loading={date.isPending} disabled={(dated || null) === (reportIssuedOn ?? null)}>
              Save
            </Button>
            {reportIssuedOn && (
              <Button variant="ghost" onClick={() => { setDated(''); date.mutate(null); }} loading={date.isPending}>
                Withdraw
              </Button>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  );
}
