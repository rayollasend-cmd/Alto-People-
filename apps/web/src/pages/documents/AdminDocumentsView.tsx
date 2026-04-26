import { useCallback, useEffect, useState } from 'react';
import type { DocumentRecord, DocumentStatus } from '@alto-people/shared';
import {
  downloadDocumentUrl,
  listAdminDocuments,
  rejectDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const STATUS_FILTERS: Array<{ value: DocumentStatus | 'ALL'; label: string }> = [
  { value: 'UPLOADED', label: 'Awaiting review' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'ALL', label: 'All' },
];

const fmtSize = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

interface AdminDocumentsViewProps {
  canManage: boolean;
}

export function AdminDocumentsView({ canManage }: AdminDocumentsViewProps) {
  const [filter, setFilter] = useState<DocumentStatus | 'ALL'>('UPLOADED');
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminDocuments(filter === 'ALL' ? {} : { status: filter });
      setDocs(res.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onVerify = async (id: string) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      await verifyDocument(id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verify failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onReject = async (id: string) => {
    if (pendingId) return;
    const reason = window.prompt('Reason for rejection?');
    if (!reason) return;
    setPendingId(id);
    try {
      await rejectDocument(id, { reason });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reject failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Document vault
        </h1>
        <p className="text-silver">
          {canManage
            ? 'Verify or reject uploaded documents.'
            : 'Read-only view of associate documents.'}
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition',
              filter === f.value
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      {!docs && <p className="text-silver">Loading…</p>}
      {docs && docs.length === 0 && (
        <p className="text-silver">No documents match this filter.</p>
      )}
      {docs && docs.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">File</th>
                <th className="px-4 py-3 text-left">Kind</th>
                <th className="px-4 py-3 text-left">Associate</th>
                <th className="px-4 py-3 text-left">Size</th>
                <th className="px-4 py-3 text-left">Status</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t border-navy-secondary/60 text-white">
                  <td className="px-4 py-3">
                    <a
                      href={downloadDocumentUrl(d.id)}
                      className="text-white hover:text-gold underline truncate max-w-xs inline-block"
                    >
                      {d.filename}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-silver text-xs uppercase tracking-widest">
                    {d.kind.replace(/_/g, ' ')}
                  </td>
                  <td className="px-4 py-3 text-silver">{d.associateName ?? '—'}</td>
                  <td className="px-4 py-3 text-silver tabular-nums">{fmtSize(d.size)}</td>
                  <td className="px-4 py-3 text-xs uppercase tracking-widest text-silver">
                    {d.status}
                    {d.rejectionReason && (
                      <div className="text-alert text-[10px] normal-case tracking-normal mt-1">
                        {d.rejectionReason}
                      </div>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                      {(d.status === 'UPLOADED' || d.status === 'REJECTED') && (
                        <button
                          type="button"
                          onClick={() => onVerify(d.id)}
                          disabled={pendingId === d.id}
                          className="text-xs px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                        >
                          Verify
                        </button>
                      )}
                      {(d.status === 'UPLOADED' || d.status === 'VERIFIED') && (
                        <button
                          type="button"
                          onClick={() => onReject(d.id)}
                          disabled={pendingId === d.id}
                          className="text-xs px-2 py-1 rounded border border-alert/40 text-alert hover:bg-alert/10 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
