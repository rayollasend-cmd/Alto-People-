import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileUp, X } from '@/components/ui/icons';
import { toast } from 'sonner';
import { TRUST_DOCUMENT_KINDS, TRUST_DOCUMENT_LABELS, type TrustDocumentKind, type TrustDownloadRequestSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { decideTrustRequest, listTrustDocuments, listTrustRequests, setSoc2ReportDate, uploadTrustDocument } from '@/lib/trustApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
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

  // One dialog for a document: the PDF, its title, and — for the SOC 2
  // report — the date the auditor issued it (F500 G4: no inline forms).
  const [uploading, setUploading] = useState<TrustDocumentKind | null>(null);

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
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-muted">No requests yet. When a prospect asks for a report on the public page, it lands here.</p>
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
          <CardContent className="p-0">
            {documents.isError ? (
              <div className="p-4">
                <QueryError what="the documents" query={documents} />
              </div>
            ) : documents.isPending ? (
              <div className="p-4">
                <Skeleton className="h-16" />
              </div>
            ) : (
              <ul className="divide-y divide-line" aria-label="Documents on file">
                {TRUST_DOCUMENT_KINDS.map((k) => {
                  const d = documents.data?.documents.find((x) => x.kind === k);
                  return (
                    <li key={k} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{TRUST_DOCUMENT_LABELS[k]}</span>
                        <span className="block truncate text-xs2 text-ink-muted">
                          {d ? `${d.title} · ${Math.round(d.bytes / 1024)} KB · ${fmtDateTime(d.updatedAt)}` : 'Not on file'}
                          {k === 'SOC2_REPORT' && reportIssuedOn ? ` · issued ${fmtDateOnly(reportIssuedOn)}` : ''}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge variant={d ? 'success' : 'outline'}>{d ? 'On file' : 'Missing'}</Badge>
                        <Button size="sm" variant={d ? 'ghost' : 'outline'} onClick={() => setUploading(k)}>
                          <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                          {d ? 'Replace' : 'Upload'}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
      {uploading && <UploadDocumentDialog kind={uploading} reportIssuedOn={reportIssuedOn} onClose={() => setUploading(null)} onDone={invalidate} />}
    </>
  );
}

/**
 * Upload (or replace) one gated document. The SOC 2 report carries the date
 * the auditor issued it here too — the date that lets the Trust Center say
 * "audited" — so there is no separate form for it.
 */
function UploadDocumentDialog({ kind, reportIssuedOn, onClose, onDone }: { kind: TrustDocumentKind; reportIssuedOn: string | null; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dated, setDated] = useState(reportIssuedOn ?? '');
  const isReport = kind === 'SOC2_REPORT';
  const dateChanged = isReport && (dated || null) !== (reportIssuedOn ?? null);
  const save = useMutation({
    mutationFn: async () => {
      if (file) await uploadTrustDocument({ kind, title: title.trim(), file });
      if (dateChanged) await setSoc2ReportDate(dated || null);
    },
    onSuccess: () => {
      toast.success(
        file
          ? `${title.trim()} is on file as the ${TRUST_DOCUMENT_LABELS[kind].toLowerCase()}.`
          : dated
            ? `The Trust Center now says audited, report issued ${fmtDateOnly(dated)}.`
            : 'The report date was withdrawn; the stage follows the evidence again.',
      );
      onDone();
      onClose();
    },
    onError: (e) => toast.error(err(e, 'Could not save.')),
  });
  const ready = (file !== null && title.trim().length >= 2) || (!file && dateChanged);
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={!!file || title.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TRUST_DOCUMENT_LABELS[kind]}</DialogTitle>
          <DialogDescription>A PDF, shared only through a link a person on your side approves. It replaces the current one.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <Field label="PDF">{(fp) => <Input {...fp} type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
          <Field label="Title" hint="What the recipient sees, e.g. “SOC 2 Type II report, 2026”.">
            {(fp) => <Input {...fp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="SOC 2 Type II report, 2026" />}
          </Field>
          {isReport && (
            <Field label="Report issued on" hint="Only once an auditor has issued it. Until then the Trust Center says preparing or observation, from the evidence.">
              {(fp) => <Input {...fp} type="date" value={dated} onChange={(e) => setDated(e.target.value)} />}
            </Field>
          )}
          <DialogFooter>
            {isReport && reportIssuedOn && (
              <Button type="button" variant="ghost" className="mr-auto" onClick={() => setDated('')} disabled={save.isPending || !dated}>
                Withdraw the date
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!ready}>
              {file ? 'Upload' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
