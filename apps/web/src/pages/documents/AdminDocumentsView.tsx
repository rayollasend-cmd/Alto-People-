import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  FileText,
  ShieldCheck,
  ShieldAlert,
  Clock,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentRecord, DocumentStatus } from '@alto-people/shared';
import {
  downloadDocumentUrl,
  listAdminDocuments,
  rejectDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { cn } from '@/lib/cn';

const STATUS_FILTERS: Array<{ value: DocumentStatus | 'ALL'; label: string }> = [
  { value: 'UPLOADED', label: 'Awaiting review' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'ALL', label: 'All' },
];

const STATUS_VARIANT: Record<
  DocumentStatus,
  'success' | 'pending' | 'destructive' | 'default'
> = {
  UPLOADED: 'pending',
  VERIFIED: 'success',
  REJECTED: 'destructive',
  EXPIRED: 'destructive',
};

const TEXTAREA_CX =
  'mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm ' +
  'focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

const fmtSize = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const fmtAge = (iso: string, now: number): string => {
  const d = Math.floor((now - new Date(iso).getTime()) / ONE_DAY_MS);
  if (d === 0) return 'today';
  if (d === 1) return '1d ago';
  return `${d}d ago`;
};

interface AdminDocumentsViewProps {
  canManage: boolean;
}

export function AdminDocumentsView({ canManage }: AdminDocumentsViewProps) {
  // Default to "Awaiting review" so HR lands on the actionable queue.
  const [filter, setFilter] = useState<DocumentStatus | 'ALL'>('UPLOADED');
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  // Unfiltered roll-up for the KPI / chip counts so they stay stable as
  // the user filters. Same pattern as the onboarding inbox.
  const [allDocs, setAllDocs] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listAdminDocuments(filter === 'ALL' ? {} : { status: filter });
      setDocs(res.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  const refreshAll = useCallback(async () => {
    try {
      const res = await listAdminDocuments({});
      setAllDocs(res.documents);
    } catch {
      setAllDocs([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const now = Date.now();

  const stats = useMemo(() => {
    const src = allDocs ?? [];
    const byStatus: Record<string, number> = {};
    for (const d of src) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    const oldestUploaded = src
      .filter((d) => d.status === 'UPLOADED')
      .reduce<number | null>((acc, d) => {
        const t = new Date(d.createdAt).getTime();
        return acc === null || t < acc ? t : acc;
      }, null);
    return {
      total: src.length,
      byStatus,
      uploaded: byStatus.UPLOADED ?? 0,
      verified: byStatus.VERIFIED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      expired: byStatus.EXPIRED ?? 0,
      oldestUploadedDays:
        oldestUploaded === null
          ? null
          : Math.floor((now - oldestUploaded) / ONE_DAY_MS),
    };
  }, [allDocs, now]);

  const visibleDocs = useMemo(() => {
    if (!docs) return null;
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        d.filename.toLowerCase().includes(q) ||
        (d.associateName && d.associateName.toLowerCase().includes(q)) ||
        d.kind.toLowerCase().includes(q)
    );
  }, [docs, search]);

  const onVerify = async (d: DocumentRecord) => {
    if (pendingId) return;
    setPendingId(d.id);
    try {
      await verifyDocument(d.id);
      toast.success(`Verified ${d.filename}`);
      await Promise.all([refresh(), refreshAll()]);
    } catch (err) {
      toast.error('Verify failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmReject = async () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    setRejectSubmitting(true);
    try {
      await rejectDocument(rejectTarget.id, { reason: rejectReason.trim() });
      toast.success(`Rejected ${rejectTarget.filename}`);
      setRejectTarget(null);
      setRejectReason('');
      await Promise.all([refresh(), refreshAll()]);
    } catch (err) {
      toast.error('Reject failed', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setRejectSubmitting(false);
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

      {/* KPI strip */}
      {canManage && allDocs && allDocs.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 rounded-md border border-navy-secondary bg-navy-secondary/30">
          <Kpi
            label="Awaiting review"
            value={String(stats.uploaded)}
            tone={stats.uploaded > 0 ? 'text-warning' : 'text-silver'}
          />
          <Kpi
            label="Verified"
            value={String(stats.verified)}
            tone="text-success"
          />
          <Kpi
            label="Rejected"
            value={String(stats.rejected)}
            tone={stats.rejected > 0 ? 'text-alert' : 'text-silver'}
          />
          <Kpi
            label="Expired"
            value={String(stats.expired)}
            tone={stats.expired > 0 ? 'text-alert' : 'text-silver'}
          />
          {stats.oldestUploadedDays !== null && stats.oldestUploadedDays >= 3 && (
            <Kpi
              label="Oldest pending"
              value={`${stats.oldestUploadedDays}d`}
              tone="text-alert"
            />
          )}
        </div>
      )}

      {/* SLA banner — fires when something has been waiting >3 days. */}
      {canManage && stats.oldestUploadedDays !== null && stats.oldestUploadedDays >= 3 && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-md border border-alert/40 bg-alert/[0.07] text-sm">
          <Clock className="h-4 w-4 text-alert mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-white">
              Document review SLA breached
            </div>
            <div className="text-silver text-xs mt-0.5">
              The oldest uploaded document has been waiting{' '}
              <span className="text-alert">{stats.oldestUploadedDays} days</span>{' '}
              for review. Industry standard is 48h.
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter('UPLOADED')}
            className="shrink-0"
          >
            Show queue
          </Button>
        </div>
      )}

      {/* Filter row */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Input
            type="search"
            placeholder="Filter by file / associate / kind…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pr-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-silver/60 hover:text-white"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => {
            const count =
              f.value === 'ALL' ? stats.total : (stats.byStatus[f.value] ?? 0);
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs border transition-colors inline-flex items-center gap-1.5',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  active
                    ? 'border-gold text-gold bg-gold/10'
                    : 'border-navy-secondary text-silver hover:text-white hover:border-silver/40'
                )}
              >
                {f.label}
                {allDocs && (
                  <span className="text-[10px] tabular-nums text-silver/60">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[10px] text-silver/60 tabular-nums">
          {visibleDocs ? `${visibleDocs.length} shown` : ''}
        </span>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {!docs && !error && (
        <Card>
          <div className="p-2">
            <SkeletonRows count={5} rowHeight="h-14" />
          </div>
        </Card>
      )}

      {visibleDocs && visibleDocs.length === 0 && (
        <EmptyState
          icon={FileText}
          title={
            search
              ? 'No documents match this search'
              : filter === 'UPLOADED'
                ? 'Inbox zero'
                : 'No documents in this view'
          }
          description={
            search
              ? 'Clear the search to see the full list.'
              : filter === 'UPLOADED'
                ? "You're caught up — nothing's waiting for review."
                : 'Switch the filter to see other states.'
          }
          action={
            search ? (
              <Button variant="secondary" onClick={() => setSearch('')}>
                Clear search
              </Button>
            ) : undefined
          }
        />
      )}

      {visibleDocs && visibleDocs.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>File</TableHead>
                <TableHead className="hidden md:table-cell">Kind</TableHead>
                <TableHead>Associate</TableHead>
                <TableHead className="hidden md:table-cell w-20">Size</TableHead>
                <TableHead className="hidden lg:table-cell w-24">Uploaded</TableHead>
                <TableHead className="w-32">Status</TableHead>
                {canManage && <TableHead className="w-44 text-right" aria-label="Actions" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleDocs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <a
                      href={downloadDocumentUrl(d.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gold hover:text-gold-bright underline-offset-4 hover:underline font-medium inline-flex items-center gap-1.5 max-w-xs truncate"
                      title={d.filename}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{d.filename}</span>
                      <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                    </a>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-silver uppercase tracking-wider">
                    {d.kind.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className="text-silver">
                    {d.associateName ?? '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-silver tabular-nums text-xs">
                    {fmtSize(d.size)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver text-xs tabular-nums">
                    {fmtAge(d.createdAt, now)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[d.status]} data-status={d.status}>
                      {d.status}
                    </Badge>
                    {d.rejectionReason && (
                      <div
                        className="text-alert text-[10px] mt-1 max-w-[140px] truncate"
                        title={d.rejectionReason}
                      >
                        {d.rejectionReason}
                      </div>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        {(d.status === 'UPLOADED' || d.status === 'REJECTED') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onVerify(d)}
                            loading={pendingId === d.id}
                            title="Mark verified"
                            className="text-success hover:text-success"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            <span className="ml-1 hidden lg:inline">Verify</span>
                          </Button>
                        )}
                        {(d.status === 'UPLOADED' || d.status === 'VERIFIED') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setRejectTarget(d);
                              setRejectReason('');
                            }}
                            disabled={pendingId === d.id}
                            title="Reject with reason"
                            className="text-alert hover:text-alert"
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            <span className="ml-1 hidden lg:inline">Reject</span>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Rejection dialog — replaces the old window.prompt so we can capture
          a real reason with markdown line breaks etc. and surface validation. */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(v) => {
          if (!v) {
            setRejectTarget(null);
            setRejectReason('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject document</DialogTitle>
            <DialogDescription>
              Tell the associate why so they can re-upload. They'll see this
              message attached to the rejected document.
            </DialogDescription>
          </DialogHeader>
          {rejectTarget && (
            <div className="space-y-3">
              <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-2.5 text-xs">
                <div className="font-medium text-white truncate">
                  {rejectTarget.filename}
                </div>
                <div className="text-silver mt-0.5">
                  {rejectTarget.kind.replace(/_/g, ' ')}
                  {rejectTarget.associateName ? ` · ${rejectTarget.associateName}` : ''}
                </div>
              </div>
              <div>
                <Label htmlFor="rd-reason" required>
                  Reason
                </Label>
                <textarea
                  id="rd-reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={4}
                  maxLength={500}
                  placeholder="e.g. Document is blurry — please re-upload a clearer scan."
                  className={TEXTAREA_CX}
                  autoFocus
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={onConfirmReject}
              loading={rejectSubmitting}
              disabled={!rejectReason.trim()}
            >
              <XCircle className="h-4 w-4" />
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = 'text-white',
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-[6rem]">
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

