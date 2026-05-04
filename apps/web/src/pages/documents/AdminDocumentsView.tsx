import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  FileText,
  Folder,
  LayoutList,
  ShieldCheck,
  ShieldAlert,
  Clock,
  Users as UsersIcon,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentRecord, DocumentStatus } from '@alto-people/shared';
import {
  listAdminDocuments,
  rejectDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { ApiError } from '@/lib/api';
import { DocumentPreview } from '@/components/DocumentPreview';
import { Avatar } from '@/components/ui/Avatar';
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
import {
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
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
  // Two ways to slice the same data: a flat queue for daily HR triage, and
  // a per-associate folder view for auditing one person's full history.
  const [view, setView] = useViewMode<'queue' | 'associates'>(
    'docs.adminView',
    'queue',
    ['queue', 'associates'],
  );
  // Default to "Awaiting review" so HR lands on the actionable queue.
  const [filter, setFilter] = useState<DocumentStatus | 'ALL'>('UPLOADED');
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  // Unfiltered roll-up for the KPI / chip counts so they stay stable as
  // the user filters. Same pattern as the onboarding inbox. Doubles as the
  // source for the "By associate" view.
  const [allDocs, setAllDocs] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [selectedAssociateId, setSelectedAssociateId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);

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

  // Group every doc the user can see by associate, so the "By associate"
  // view can act as a per-person folder. We pull from `allDocs` (not the
  // status-filtered `docs`) so the folders stay stable as filters change.
  const associateGroups = useMemo(() => {
    if (!allDocs) return null;
    const map = new Map<
      string,
      {
        associateId: string;
        associateName: string;
        total: number;
        uploaded: number;
        verified: number;
        rejected: number;
        expired: number;
        lastActivity: number;
        docs: DocumentRecord[];
      }
    >();
    for (const d of allDocs) {
      const id = d.associateId;
      const created = new Date(d.createdAt).getTime();
      const existing = map.get(id);
      if (existing) {
        existing.total += 1;
        if (d.status === 'UPLOADED') existing.uploaded += 1;
        else if (d.status === 'VERIFIED') existing.verified += 1;
        else if (d.status === 'REJECTED') existing.rejected += 1;
        else if (d.status === 'EXPIRED') existing.expired += 1;
        if (created > existing.lastActivity) existing.lastActivity = created;
        existing.docs.push(d);
      } else {
        map.set(id, {
          associateId: id,
          associateName: d.associateName ?? '—',
          total: 1,
          uploaded: d.status === 'UPLOADED' ? 1 : 0,
          verified: d.status === 'VERIFIED' ? 1 : 0,
          rejected: d.status === 'REJECTED' ? 1 : 0,
          expired: d.status === 'EXPIRED' ? 1 : 0,
          lastActivity: created,
          docs: [d],
        });
      }
    }
    // Sort docs inside each folder newest → oldest, then sort folders so
    // anyone with awaiting-review work surfaces first, then by recent activity.
    const groups = Array.from(map.values());
    for (const g of groups) {
      g.docs.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }
    groups.sort((a, b) => {
      if (a.uploaded !== b.uploaded) return b.uploaded - a.uploaded;
      return b.lastActivity - a.lastActivity;
    });
    return groups;
  }, [allDocs]);

  // Filter the associate folders by the same search box so HR can look up a
  // person without flipping views.
  const visibleAssociateGroups = useMemo(() => {
    if (!associateGroups) return null;
    const q = search.trim().toLowerCase();
    if (!q) return associateGroups;
    return associateGroups.filter(
      (g) =>
        g.associateName.toLowerCase().includes(q) ||
        g.docs.some(
          (d) =>
            d.filename.toLowerCase().includes(q) ||
            d.kind.toLowerCase().includes(q),
        ),
    );
  }, [associateGroups, search]);

  const selectedGroup = useMemo(
    () =>
      associateGroups?.find((g) => g.associateId === selectedAssociateId) ??
      null,
    [associateGroups, selectedAssociateId],
  );

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
      <PageHeader
        title="Document vault"
        subtitle={
          canManage
            ? 'Verify or reject uploaded documents.'
            : 'Read-only view of associate documents.'
        }
      />

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
        <ViewToggle
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: 'queue', label: 'Queue', icon: LayoutList },
            { value: 'associates', label: 'By associate', icon: UsersIcon },
          ]}
          tooltips={{
            queue: 'Flat queue — daily triage',
            associates: 'Folder per associate — audit view',
          }}
        />
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Input
            type="search"
            placeholder={
              view === 'queue'
                ? 'Filter by file / associate / kind…'
                : 'Filter associates…'
            }
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
        {/* Status chips only make sense for the flat queue. The associate
            view shows per-status counts inline on each folder row instead. */}
        {view === 'queue' && (
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
        )}
        <span className="ml-auto text-[10px] text-silver/60 tabular-nums">
          {view === 'queue'
            ? visibleDocs
              ? `${visibleDocs.length} shown`
              : ''
            : visibleAssociateGroups
              ? `${visibleAssociateGroups.length} associates`
              : ''}
        </span>
      </div>

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      {view === 'queue' && !docs && !error && (
        <Card>
          <div className="p-2">
            <SkeletonRows count={5} rowHeight="h-14" />
          </div>
        </Card>
      )}

      {view === 'queue' && visibleDocs && visibleDocs.length === 0 && (
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

      {view === 'queue' && visibleDocs && visibleDocs.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>File</TableHead>
                <TableHead className="hidden md:table-cell">Kind</TableHead>
                <TableHead className="hidden sm:table-cell">Associate</TableHead>
                <TableHead className="hidden md:table-cell w-20">Size</TableHead>
                <TableHead className="hidden lg:table-cell w-24">Uploaded</TableHead>
                <TableHead className="w-32">Status</TableHead>
                {canManage && <TableHead className="hidden md:table-cell w-44 text-right" aria-label="Actions" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleDocs.map((d) => (
                <TableRow key={d.id} className="group">
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setPreviewDoc(d)}
                      className="text-gold hover:text-gold-bright underline-offset-4 hover:underline font-medium inline-flex items-center gap-1.5 max-w-xs truncate"
                      title={`Preview ${d.filename}`}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{d.filename}</span>
                    </button>
                    {/* Phone-only secondary line — associate name takes the
                        place of its hidden column. Tap-target area still
                        opens the preview via the file button above. */}
                    <div className="sm:hidden text-[11px] text-silver/70 truncate mt-0.5">
                      {d.associateName ?? '—'}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs text-silver uppercase tracking-wider">
                    {d.kind.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-silver">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAssociateId(d.associateId);
                      }}
                      className="flex items-center gap-2.5 text-left hover:text-white transition-colors"
                      title="Open this associate's folder"
                    >
                      <Avatar name={d.associateName ?? '—'} size="xs" />
                      <span className="truncate">{d.associateName ?? '—'}</span>
                    </button>
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
                    <TableCell className="hidden md:table-cell text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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

      {view === 'associates' && !allDocs && !error && (
        <Card>
          <div className="p-2">
            <SkeletonRows count={6} rowHeight="h-12" />
          </div>
        </Card>
      )}

      {view === 'associates' &&
        visibleAssociateGroups &&
        visibleAssociateGroups.length === 0 && (
          <EmptyState
            icon={Folder}
            title={search ? 'No associates match this search' : 'No documents yet'}
            description={
              search
                ? 'Clear the search to see all associate folders.'
                : "When associates upload documents, you'll see one folder per person here."
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

      {view === 'associates' &&
        visibleAssociateGroups &&
        visibleAssociateGroups.length > 0 && (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Associate</TableHead>
                  <TableHead className="w-20 text-right">Total</TableHead>
                  <TableHead className="w-28">Awaiting</TableHead>
                  <TableHead className="w-28 hidden md:table-cell">Verified</TableHead>
                  <TableHead className="w-28 hidden md:table-cell">Rejected</TableHead>
                  <TableHead className="w-28 hidden lg:table-cell">Expired</TableHead>
                  <TableHead className="w-28 hidden lg:table-cell">Last activity</TableHead>
                  <TableHead className="w-8" aria-label="Open" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleAssociateGroups.map((g) => (
                  <TableRow
                    key={g.associateId}
                    className="cursor-pointer"
                    onClick={() => setSelectedAssociateId(g.associateId)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={g.associateName} size="sm" />
                        <span className="text-white font-medium truncate">
                          {g.associateName}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-silver">
                      {g.total}
                    </TableCell>
                    <TableCell>
                      {g.uploaded > 0 ? (
                        <Badge variant="pending">{g.uploaded}</Badge>
                      ) : (
                        <span className="text-silver/50 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {g.verified > 0 ? (
                        <Badge variant="success">{g.verified}</Badge>
                      ) : (
                        <span className="text-silver/50 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {g.rejected > 0 ? (
                        <Badge variant="destructive">{g.rejected}</Badge>
                      ) : (
                        <span className="text-silver/50 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {g.expired > 0 ? (
                        <Badge variant="destructive">{g.expired}</Badge>
                      ) : (
                        <span className="text-silver/50 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-silver text-xs tabular-nums">
                      {fmtAge(new Date(g.lastActivity).toISOString(), now)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="h-4 w-4 text-silver/60" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

      {/* Per-associate folder. Opens from either view: clicking a row in the
          associates list or clicking the avatar/name in the queue's table. */}
      <Drawer
        open={selectedGroup !== null}
        onOpenChange={(o) => !o && setSelectedAssociateId(null)}
        width="max-w-3xl"
      >
        {selectedGroup && (
          <>
            <DrawerHeader>
              <div className="flex items-center gap-3">
                <Avatar name={selectedGroup.associateName} size="md" />
                <div className="min-w-0">
                  <DrawerTitle className="truncate">
                    {selectedGroup.associateName}
                  </DrawerTitle>
                  <DrawerDescription>
                    {selectedGroup.total} document
                    {selectedGroup.total === 1 ? '' : 's'} on file
                  </DrawerDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {selectedGroup.uploaded > 0 && (
                  <Badge variant="pending">
                    {selectedGroup.uploaded} awaiting
                  </Badge>
                )}
                {selectedGroup.verified > 0 && (
                  <Badge variant="success">
                    {selectedGroup.verified} verified
                  </Badge>
                )}
                {selectedGroup.rejected > 0 && (
                  <Badge variant="destructive">
                    {selectedGroup.rejected} rejected
                  </Badge>
                )}
                {selectedGroup.expired > 0 && (
                  <Badge variant="destructive">
                    {selectedGroup.expired} expired
                  </Badge>
                )}
              </div>
            </DrawerHeader>
            <DrawerBody>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>File</TableHead>
                    <TableHead className="hidden md:table-cell">Kind</TableHead>
                    <TableHead className="w-24">Uploaded</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    {canManage && (
                      <TableHead className="w-32 text-right" aria-label="Actions" />
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedGroup.docs.map((d) => (
                    <TableRow key={d.id} className="group">
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setPreviewDoc(d)}
                          className="text-gold hover:text-gold-bright underline-offset-4 hover:underline font-medium inline-flex items-center gap-1.5 max-w-xs truncate"
                          title={`Preview ${d.filename}`}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{d.filename}</span>
                        </button>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-silver uppercase tracking-wider">
                        {d.kind.replace(/_/g, ' ')}
                      </TableCell>
                      <TableCell className="text-silver text-xs tabular-nums">
                        {fmtAge(d.createdAt, now)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={STATUS_VARIANT[d.status]}
                          data-status={d.status}
                        >
                          {d.status}
                        </Badge>
                        {d.rejectionReason && (
                          <div
                            className="text-alert text-[10px] mt-1 max-w-[160px] truncate"
                            title={d.rejectionReason}
                          >
                            {d.rejectionReason}
                          </div>
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell className="text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            {(d.status === 'UPLOADED' ||
                              d.status === 'REJECTED') && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onVerify(d)}
                                loading={pendingId === d.id}
                                title="Mark verified"
                                className="text-success hover:text-success"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {(d.status === 'UPLOADED' ||
                              d.status === 'VERIFIED') && (
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
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DrawerBody>
            <DrawerFooter>
              <Button
                variant="ghost"
                onClick={() => setSelectedAssociateId(null)}
              >
                Close
              </Button>
            </DrawerFooter>
          </>
        )}
      </Drawer>

      {/* In-platform document viewer. Renders PDFs / images inline so HR can
          audit a file without leaving the page. */}
      <DocumentPreview
        doc={previewDoc}
        onOpenChange={(o) => !o && setPreviewDoc(null)}
        actions={
          canManage && previewDoc ? (
            <div className="flex items-center gap-1">
              {(previewDoc.status === 'UPLOADED' ||
                previewDoc.status === 'REJECTED') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const target = previewDoc;
                    await onVerify(target);
                    setPreviewDoc(null);
                  }}
                  loading={pendingId === previewDoc.id}
                  className="text-success hover:text-success"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span className="ml-1 hidden sm:inline">Verify</span>
                </Button>
              )}
              {(previewDoc.status === 'UPLOADED' ||
                previewDoc.status === 'VERIFIED') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRejectTarget(previewDoc);
                    setRejectReason('');
                    setPreviewDoc(null);
                  }}
                  disabled={pendingId === previewDoc.id}
                  className="text-alert hover:text-alert"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  <span className="ml-1 hidden sm:inline">Reject</span>
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

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
              <Field label="Reason" required>
                {(p) => (
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={4}
                    maxLength={500}
                    placeholder="e.g. Document is blurry — please re-upload a clearer scan."
                    className={TEXTAREA_CX}
                    autoFocus
                    {...p}
                  />
                )}
              </Field>
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

