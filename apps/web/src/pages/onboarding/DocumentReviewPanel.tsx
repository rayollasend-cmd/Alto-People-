import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCheck2, ShieldAlert, ShieldCheck } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { DocumentRecord } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { DOCUMENT_KIND_LABEL, isPreviewable, listAdminDocuments, previewDocumentUrl, verifyDocument } from '@/lib/documentsApi';
import { fmtDateTime } from '@/lib/format';
import { nextInQueue } from '@/lib/queueNext';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { RejectDocumentDialog } from '@/components/RejectDocumentDialog';

/**
 * The hire's uploads, reviewed on the application (ease-of-use sweep,
 * 2026-10-22, the single biggest loop): every document task used to send
 * the reviewer to the person's vault, approve each file there and come
 * back — about ten clicks across two pages for one hire. Here each upload
 * is previewed, verified or rejected in place, and "Verify & next" walks
 * the uploads still waiting. The checklist task and the vault refetch
 * behind it, so nothing else changes.
 */
export function DocumentReviewPanel({ applicationId, associateId }: { applicationId: string; associateId: string }) {
  const qc = useQueryClient();
  const key = ['application', applicationId, 'documents', associateId];
  const q = useQuery({ queryKey: key, queryFn: () => listAdminDocuments({ associateId, pageSize: 50 }) });
  const docs = q.data?.documents ?? null;
  const waiting = (docs ?? []).filter((d) => d.status === 'UPLOADED');
  const [openId, setOpenId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const open = (docs ?? []).find((d) => d.id === openId) ?? null;

  const refetchAll = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['application', applicationId], exact: true });
    void qc.invalidateQueries({ queryKey: ['associate-vault', associateId] });
  };

  const verify = async (d: DocumentRecord, advance: boolean) => {
    setBusyId(d.id);
    try {
      await verifyDocument(d.id, expiresAt ? { expiresAt } : {});
      toast.success(`Verified ${d.filename}.`);
      setExpiresAt('');
      refetchAll();
      setOpenId(advance ? (nextInQueue(waiting, d.id)?.id ?? null) : null);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not verify.');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  if (q.isError) return null;
  if (!docs) {
    return (
      <Card>
        <CardContent className="space-y-2" aria-busy="true">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (docs.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-3">
        <SectionTitle
          icon={FileCheck2}
          title="Documents to review"
          description={waiting.length === 0 ? 'Every upload has been reviewed.' : `${waiting.length} ${waiting.length === 1 ? 'upload waits' : 'uploads wait'} — review them here, no trip to the vault.`}
        />
        <ul className="divide-y divide-line" aria-label="Uploaded documents">
          {docs.map((d) => (
            <li key={d.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpenId(openId === d.id ? null : d.id)}
                  aria-expanded={openId === d.id}
                  className="min-w-0 flex-1 text-left text-sm text-ink hover:underline"
                >
                  <span className="font-medium">{DOCUMENT_KIND_LABEL[d.kind] ?? d.kind}</span>
                  <span className="text-ink-muted"> · {d.filename} · {fmtDateTime(d.createdAt)}</span>
                </button>
                <Badge size="sm" variant={d.status === 'VERIFIED' ? 'success' : d.status === 'REJECTED' ? 'outline' : 'pending'}>
                  {d.status === 'VERIFIED' ? 'Verified' : d.status === 'REJECTED' ? 'Rejected' : 'Waiting'}
                </Badge>
              </div>
              {d.status === 'REJECTED' && d.rejectionReason && <p className="mt-1 text-xs text-ink-muted">Rejected: {d.rejectionReason}</p>}
              {openId === d.id && open && (
                <div className="mt-2 space-y-2">
                  {open.fileAvailable && isPreviewable(open.mimeType) ? (
                    open.mimeType.startsWith('image/') ? (
                      <img src={previewDocumentUrl(open.id)} alt={open.filename} className="max-h-96 rounded-md border border-line" />
                    ) : (
                      <iframe src={previewDocumentUrl(open.id)} title={open.filename} className="h-96 w-full rounded-md border border-line bg-white" />
                    )
                  ) : (
                    <a href={previewDocumentUrl(open.id)} target="_blank" rel="noopener noreferrer" className="text-sm text-gold hover:underline">
                      Open {open.filename}
                    </a>
                  )}
                  {open.status === 'UPLOADED' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2 text-xs text-ink-muted">
                        Expires
                        <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Expires on (optional)" className="h-8 w-[8.75rem] text-xs" />
                      </label>
                      <Button size="sm" variant="ghost" onClick={() => void verify(open, false)} loading={busyId === open.id} className="text-success hover:text-success">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Verify
                      </Button>
                      {waiting.length > 1 && (
                        <Button size="sm" variant="secondary" onClick={() => void verify(open, true)} loading={busyId === open.id}>
                          Verify &amp; next
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setRejectTarget(open)} disabled={busyId === open.id} className="text-alert hover:text-alert">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <RejectDocumentDialog
        doc={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onRejected={(id) => {
          refetchAll();
          setOpenId(nextInQueue(waiting, id)?.id ?? null);
        }}
      />
    </Card>
  );
}
