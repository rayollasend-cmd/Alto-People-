import { AssociateLink } from '@/components/ui/AssociateLink';
import {
  Fragment,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ChevronRight,
  Download,
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
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type {
  DocumentKind,
  DocumentRecord,
  DocumentStatus,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  bulkVerifyDocuments,
  downloadAllDocumentsUrl,
  listAdminDocuments,
  rejectDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { fmtDate, fmtRelativeDate, fmtSize } from '@/lib/format';
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
import { FilterChip } from '@/components/ui/FilterBar';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { SkeletonRows } from '@/components/ui/Skeleton';
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useTableSort,
} from '@/components/ui/Table';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { cn } from '@/lib/cn';
import { statusTone } from '@/lib/status';
import { usePersistentState } from '@/lib/usePersistentState';
import { useSelection } from '@/lib/useSelection';

// Filter value space: the real DocumentStatuses plus two synthetic buckets.
// 'ACTION_NEEDED' rolls up the states that require HR to do something —
// UPLOADED (needs review) and EXPIRED (needs a renewal request). REJECTED is
// deliberately excluded: the ball is in the associate's court until they
// re-upload.
type DocFilter = DocumentStatus | 'ALL' | 'ACTION_NEEDED';

const ACTION_NEEDED_STATUSES: DocumentStatus[] = ['UPLOADED', 'EXPIRED'];

const STATUS_FILTERS: Array<{ value: DocFilter; label: string }> = [
  { value: 'ACTION_NEEDED', label: 'Action needed' },
  { value: 'UPLOADED', label: 'Awaiting review' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'ALL', label: 'All' },
];

// Tones come from the shared status vocabulary; only the wording is local —
// UPLOADED means "someone must review this", so it reads "Awaiting review".
const STATUS_LABELS: Record<DocumentStatus, string> = {
  UPLOADED: 'Awaiting review',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

// Canned reasons for the bulk-reject panel — the common cases HR types
// over and over. Clicking one fills the free-text field (still editable).
const BULK_REJECT_PRESETS = [
  'Blurry / unreadable',
  'Expired document',
  'Wrong document type',
] as const;


const fmtKind = (k: string): string =>
  k.replace(/_/g, ' ').replace(/\bPDF\b/i, 'PDF');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// Shared relative formatter — one "time ago" dialect across the app.
// (The `now` param is kept for call-site compatibility; freshness comes
// from render time like every other fmtRelativeDate consumer.)
const fmtAge = (iso: string, _now: number): string => fmtRelativeDate(iso);

interface AdminDocumentsViewProps {
  canManage: boolean;
}

export function AdminDocumentsView({ canManage }: AdminDocumentsViewProps) {
  const { can } = useAuth();
  // Two ways to slice the same data: a flat queue for daily HR triage, and
  // a per-associate folder view for auditing one person's full history.
  const [view, setView] = useViewMode<'queue' | 'associates'>(
    'docs.adminView',
    'queue',
    ['queue', 'associates'],
  );
  // Default to "Action needed" so HR lands on everything that requires them
  // (uploads to review + expired docs to renew), not just one slice of it.
  // Persisted — a stored chip that no longer exists in STATUS_FILTERS falls
  // back to the default instead of rendering an unexplained empty queue.
  const [filter, setFilter] = usePersistentState<DocFilter>(
    'alto:list.documents.status.v1',
    'ACTION_NEEDED',
    (v): v is DocFilter => STATUS_FILTERS.some((f) => f.value === v),
  );
  const [kindFilter, setKindFilter] = useState<DocumentKind | 'ALL'>('ALL');
  // Server-filtered slice — only populated when the active filter needs a
  // server-side query (a specific status or kind). The client-expressible
  // filters (ACTION_NEEDED / ALL with no kind) derive `docs` from allDocs
  // below instead: the old refresh() hit the exact same unfiltered endpoint
  // refreshAll() already calls, doubling the mount fetch for nothing.
  const [serverDocs, setServerDocs] = useState<DocumentRecord[] | null>(null);
  // Unfiltered roll-up for the KPI / chip counts so they stay stable as
  // the user filters. Same pattern as the onboarding inbox. Doubles as the
  // source for the "By associate" view.
  const [allDocs, setAllDocs] = useState<DocumentRecord[] | null>(null);
  // Server-side total for the unfiltered list. The list itself is capped
  // (200), so when total > allDocs.length the KPIs/folders are partial and
  // we say so instead of presenting the slice as audit truth.
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [allError, setAllError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [selectedAssociateId, setSelectedAssociateId] = useState<string | null>(null);
  // The open folder's docs, fetched directly with ?associateId= so the
  // drawer is complete even when the global list is truncated at the cap.
  const [folderDocs, setFolderDocs] = useState<DocumentRecord[] | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  // Optional expiry captured alongside a single verify in the preview
  // viewer ('YYYY-MM-DD'). Bulk verify stays expiry-less on purpose.
  const [verifyExpiresAt, setVerifyExpiresAt] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  // Bulk-reject panel state — one reason applied to every selected doc.
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');

  // True when the active filter needs data the unfiltered overview can't
  // answer: a specific status or kind is server-filtered, so past the
  // server's row cap it can return rows the unfiltered slice doesn't hold.
  // ACTION_NEEDED / ALL with no kind used to call listAdminDocuments({})
  // anyway (same request, same cap, narrowed client-side) — those derive
  // from allDocs instead of refetching.
  const needsServerFilter =
    kindFilter !== 'ALL' || (filter !== 'ALL' && filter !== 'ACTION_NEEDED');

  const refresh = useCallback(async () => {
    if (!needsServerFilter) {
      // The queue derives from allDocs (refreshAll's data) — nothing to fetch.
      setError(null);
      return;
    }
    try {
      setError(null);
      const kindParam = kindFilter === 'ALL' ? undefined : kindFilter;
      // 'ACTION_NEEDED' spans two statuses, which the backend's single-status
      // query can't express — fetch all (kind-scoped; the kind-less case is
      // handled above) and narrow client-side. The other filters map straight
      // to status + kind params.
      if (filter === 'ACTION_NEEDED') {
        const res = await listAdminDocuments(kindParam ? { kind: kindParam } : {});
        setServerDocs(
          res.documents.filter((d) =>
            ACTION_NEEDED_STATUSES.includes(d.status),
          ),
        );
        return;
      }
      const res = await listAdminDocuments({
        ...(filter === 'ALL' ? {} : { status: filter }),
        ...(kindParam ? { kind: kindParam } : {}),
      });
      setServerDocs(res.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter, kindFilter, needsServerFilter]);

  const refreshAll = useCallback(async () => {
    try {
      setAllError(null);
      const res = await listAdminDocuments({});
      setAllDocs(res.documents);
      setAllTotal(res.total ?? res.documents.length);
    } catch (err) {
      // Don't fake an empty vault — leave allDocs as-is (null on first load)
      // and surface the failure in a banner instead of zeroed KPIs.
      setAllError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  // Per-associate folder fetch — direct, uncapped-by-the-global-list view of
  // one person's documents.
  const fetchFolder = useCallback(async (associateId: string) => {
    try {
      setFolderError(null);
      const res = await listAdminDocuments({ associateId });
      setFolderDocs(res.documents);
    } catch (err) {
      setFolderError(
        err instanceof ApiError ? err.message : 'Failed to load this folder.',
      );
    }
  }, []);

  // What the queue works from: the server-filtered slice when a server-side
  // filter is active, otherwise derived client-side from the unfiltered
  // overview — identical data to what the dropped duplicate fetch returned,
  // since both hit listAdminDocuments({}) under the same server cap.
  const docs = useMemo(() => {
    if (needsServerFilter) return serverDocs;
    if (!allDocs) return null;
    if (filter === 'ACTION_NEEDED') {
      return allDocs.filter((d) => ACTION_NEEDED_STATUSES.includes(d.status));
    }
    return allDocs;
  }, [needsServerFilter, serverDocs, allDocs, filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    setFolderDocs(null);
    setFolderError(null);
    if (selectedAssociateId) fetchFolder(selectedAssociateId);
  }, [selectedAssociateId, fetchFolder]);

  // The optional expiry date belongs to one document — clear it whenever the
  // preview switches docs or closes.
  useEffect(() => {
    setVerifyExpiresAt('');
  }, [previewDoc?.id]);

  // Drop any selection when the visible slice changes (filter / kind / view),
  // so a bulk-verify can never act on rows the user can no longer see.
  // (clearSelection is a stable callback from useSelection, declared below.)
  useEffect(() => {
    clearSelection();
  }, [filter, kindFilter, view]);

  // Day-granularity "now" for the fmtAge labels in the render body. NOT a
  // dependency of the stats memo below — that made the memo's inputs change
  // on every render, so it never cached and re-scanned all docs per keystroke.
  const now = Date.now();

  const stats = useMemo(() => {
    // Fresh timestamp taken when the memo actually recomputes ([allDocs]
    // changes) — day-level precision doesn't need one per render.
    const nowMs = Date.now();
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
          : Math.floor((nowMs - oldestUploaded) / ONE_DAY_MS),
    };
  }, [allDocs]);

  // Only offer kinds that actually exist in the tenant, sorted, so the
  // dropdown stays short instead of listing all 16 possible kinds.
  const availableKinds = useMemo(() => {
    const set = new Set<DocumentKind>();
    for (const d of allDocs ?? []) set.add(d.kind);
    return Array.from(set).sort();
  }, [allDocs]);

  // Deferred search term for the heavy derived lists: the input repaints
  // immediately while React filters the doc queue / regroups associates at
  // background priority, keeping the previous results on screen meanwhile.
  const deferredSearch = useDeferredValue(search);

  const visibleDocs = useMemo(() => {
    if (!docs) return null;
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        d.filename.toLowerCase().includes(q) ||
        (d.associateName && d.associateName.toLowerCase().includes(q)) ||
        d.kind.toLowerCase().includes(q)
    );
  }, [docs, deferredSearch]);

  // Bulk-verify selection (queue view only). Only docs that can transition to
  // VERIFIED — UPLOADED or REJECTED — are ever selectable; that rule lives
  // in verifiableIds, the shared hook supplies the mechanics + tri-state.
  const verifiableIds = useMemo(
    () =>
      (visibleDocs ?? [])
        .filter((d) => d.status === 'UPLOADED' || d.status === 'REJECTED')
        .map((d) => d.id),
    [visibleDocs],
  );
  const {
    selected: selectedDocs,
    toggle: toggleDoc,
    clear: clearSelection,
    allSelected: allVerifiableSelected,
    someSelected: someVerifiableSelected,
    toggleAll: toggleAllVerifiable,
  } = useSelection(verifiableIds);

  // Click-to-sort for the flat queue table. Operates on the filtered slice
  // the table renders; third click restores server order (newest first).
  const {
    sorted: sortedDocs,
    sortState: docSort,
    toggleSort: toggleDocSort,
  } = useTableSort(visibleDocs ?? [], {
    file: (d: DocumentRecord) => d.filename,
    kind: (d: DocumentRecord) => d.kind,
    associate: (d: DocumentRecord) => d.associateName,
    size: (d: DocumentRecord) => d.size,
    uploaded: (d: DocumentRecord) => new Date(d.createdAt).getTime(),
    status: (d: DocumentRecord) => d.status,
  });

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
    const q = deferredSearch.trim().toLowerCase();
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
  }, [associateGroups, deferredSearch]);

  const selectedGroup = useMemo(
    () =>
      associateGroups?.find((g) => g.associateId === selectedAssociateId) ??
      null,
    [associateGroups, selectedAssociateId],
  );

  // What the folder drawer renders: the directly-fetched docs when they've
  // arrived, falling back to the (possibly capped) global slice while
  // loading. Counts are recomputed from whichever list is shown so the
  // header chips always match the table.
  const folder = useMemo(() => {
    if (!selectedAssociateId) return null;
    const source = folderDocs ?? selectedGroup?.docs ?? null;
    const list = source ?? [];
    const count = (s: DocumentStatus) =>
      list.filter((d) => d.status === s).length;
    return {
      associateId: selectedAssociateId,
      associateName:
        selectedGroup?.associateName ?? list[0]?.associateName ?? '—',
      docs: list,
      loading: source === null,
      total: list.length,
      uploaded: count('UPLOADED'),
      verified: count('VERIFIED'),
      rejected: count('REJECTED'),
      expired: count('EXPIRED'),
      hasDownloadable: list.some((d) => d.fileAvailable),
    };
  }, [selectedAssociateId, folderDocs, selectedGroup]);

  const onVerify = async (d: DocumentRecord, expiresAt?: string) => {
    if (pendingId) return;
    setPendingId(d.id);
    try {
      await verifyDocument(d.id, expiresAt ? { expiresAt } : {});
      toast.success(`Verified ${d.filename}.`);
      await Promise.all([
        refresh(),
        refreshAll(),
        ...(selectedAssociateId ? [fetchFolder(selectedAssociateId)] : []),
      ]);
    } catch (err) {
      toast.error('Verify failed.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setPendingId(null);
    }
  };

  const onBulkVerify = async () => {
    if (bulkBusy || selectedDocs.size === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkVerifyDocuments(Array.from(selectedDocs));
      toast.success(
        `Verified ${res.verified}${res.skipped.length ? ` · ${res.skipped.length} skipped` : ''}.`,
      );
      clearSelection();
      await Promise.all([refresh(), refreshAll()]);
    } catch (err) {
      toast.error('Bulk verify failed.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBulkBusy(false);
    }
  };

  // Of the current selection, the docs the reject endpoint will accept
  // (UPLOADED / VERIFIED). Selected REJECTED docs are skipped — the ball
  // is already in the associate's court.
  const bulkRejectTargets = useMemo(
    () =>
      (docs ?? []).filter(
        (d) =>
          selectedDocs.has(d.id) &&
          (d.status === 'UPLOADED' || d.status === 'VERIFIED'),
      ),
    [docs, selectedDocs],
  );

  const onBulkReject = async () => {
    const reason = bulkRejectReason.trim();
    if (bulkBusy || !reason || bulkRejectTargets.length === 0) return;
    setBulkBusy(true);
    let ok = 0;
    const failures: string[] = [];
    // Sequential on purpose: the per-id endpoint carries all the side
    // effects (task rewind + email to the associate) — no parallel
    // hammering, and a mid-loop failure leaves an honest partial state.
    for (const d of bulkRejectTargets) {
      try {
        await rejectDocument(d.id, { reason });
        ok += 1;
      } catch (err) {
        failures.push(
          `${d.filename}: ${err instanceof ApiError ? err.message : 'failed'}`,
        );
      }
    }
    const skipped = selectedDocs.size - bulkRejectTargets.length;
    const detailBits = [
      skipped > 0 ? `${skipped} skipped (already rejected)` : null,
      ...failures.slice(0, 3),
      failures.length > 3 ? `+ ${failures.length - 3} more failed` : null,
    ].filter((x): x is string => x !== null);
    const description = detailBits.length > 0 ? detailBits.join(' · ') : undefined;
    if (failures.length === 0) {
      toast.success(`Rejected ${ok} document${ok === 1 ? '' : 's'}.`, {
        description,
      });
    } else if (ok === 0) {
      toast.error(`All ${failures.length} rejections failed.`, { description });
    } else {
      toast.message(`Rejected ${ok} of ${bulkRejectTargets.length}.`, {
        description,
      });
    }
    setBulkRejectOpen(false);
    setBulkRejectReason('');
    clearSelection();
    await Promise.all([refresh(), refreshAll()]);
    setBulkBusy(false);
  };

  const onConfirmReject = async () => {
    if (!rejectTarget || !rejectReason.trim()) return;
    setRejectSubmitting(true);
    try {
      await rejectDocument(rejectTarget.id, { reason: rejectReason.trim() });
      toast.success(`Rejected ${rejectTarget.filename}.`);
      setRejectTarget(null);
      setRejectReason('');
      await Promise.all([
        refresh(),
        refreshAll(),
        ...(selectedAssociateId ? [fetchFolder(selectedAssociateId)] : []),
      ]);
    } catch (err) {
      toast.error('Reject failed.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setRejectSubmitting(false);
    }
  };

  return (
    <div className="mx-auto">
      <PageHeader
        title="Document vault"
        subtitle={
          canManage
            ? 'Verify or reject uploaded documents.'
            : 'Read-only view of associate documents.'
        }
        secondaryActions={
          // Mail-merge letter templates generate the documents that land in
          // this vault; the /templates route is gated on view:hr-admin.
          can('view:hr-admin') ? (
            <Button asChild variant="ghost" size="sm">
              <Link to="/templates">Document templates</Link>
            </Button>
          ) : undefined
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
        <div className="relative flex-1 w-full sm:min-w-[200px] max-w-xs">
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
              className="absolute right-2 top-1/2 -translate-y-1/2 text-silver/70 hover:text-white"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* Kind filter — only worth showing once more than one kind exists. */}
        {view === 'queue' && availableKinds.length > 1 && (
          <Select
            size="sm"
            aria-label="Filter by document type"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as DocumentKind | 'ALL')}
            className="max-w-[14rem]"
          >
            <option value="ALL">All types</option>
            {availableKinds.map((k) => (
              <option key={k} value={k}>
                {fmtKind(k)}
              </option>
            ))}
          </Select>
        )}
        {/* Status chips only make sense for the flat queue. The associate
            view shows per-status counts inline on each folder row instead. */}
        {view === 'queue' && (
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((f) => {
              const count =
                f.value === 'ALL'
                  ? stats.total
                  : f.value === 'ACTION_NEEDED'
                    ? stats.uploaded + stats.expired
                    : (stats.byStatus[f.value] ?? 0);
              const active = filter === f.value;
              return (
                <FilterChip
                  key={f.value}
                  active={active}
                  onClick={() => setFilter(f.value)}
                  className="gap-1.5 rounded-md"
                >
                  {f.label}
                  {allDocs && (
                    <span className="text-2xs tabular-nums text-silver/70">
                      {count}
                    </span>
                  )}
                </FilterChip>
              );
            })}
          </div>
        )}
        <span className="ml-auto text-2xs text-silver/70 tabular-nums">
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

      {/* The overview fetch failed — say so instead of rendering zeroed
          KPIs and an empty "No documents yet" folder view. */}
      {allError && (
        <ErrorBanner className="mb-4">
          Couldn't load the document overview — KPIs, counts, and the
          by-associate view are unavailable. {allError}
        </ErrorBanner>
      )}

      {/* Truncation honesty: the unfiltered list is capped server-side. */}
      {allDocs && allTotal !== null && allTotal > allDocs.length && (
        <ErrorBanner severity="warning" className="mb-4">
          Showing {allDocs.length} of {allTotal} documents — KPIs and folders
          reflect only what's loaded; filter by status/kind or open a folder
          to see everything for one person.
        </ErrorBanner>
      )}

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

      {view === 'queue' && visibleDocs && visibleDocs.length > 0 && (() => {
        // Group the queue by associate — one header row per person — in
        // order of first appearance under the current sort, so column
        // sorting still decides both group order and order within a group.
        const groups: Array<{
          associateId: string;
          associateName: string;
          docs: DocumentRecord[];
        }> = [];
        const groupIndex = new Map<string, number>();
        for (const d of sortedDocs) {
          const at = groupIndex.get(d.associateId);
          if (at === undefined) {
            groupIndex.set(d.associateId, groups.length);
            groups.push({
              associateId: d.associateId,
              associateName: d.associateName ?? '—',
              docs: [d],
            });
          } else {
            groups[at].docs.push(d);
          }
        }
        const colCount = canManage ? 8 : 6;
        return (
        <Card className="overflow-hidden">
          {canManage && selectedDocs.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gold/30 bg-gold/[0.07] px-3 py-2">
              <div className="text-sm text-gold">
                <span className="font-medium tabular-nums">
                  {selectedDocs.size}
                </span>{' '}
                selected
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearSelection}
                  disabled={bulkBusy}
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={onBulkVerify}
                  loading={bulkBusy}
                  className="text-success"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Verify selected ({selectedDocs.size})
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setBulkRejectOpen(true)}
                  disabled={bulkBusy || bulkRejectTargets.length === 0}
                  title={
                    bulkRejectTargets.length === 0
                      ? 'Nothing in the selection can be rejected'
                      : 'Reject the selected documents with one reason'
                  }
                  className="text-alert hover:text-alert"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Reject selected ({bulkRejectTargets.length})
                </Button>
              </div>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {canManage && (
                  <TableHead className="w-8">
                    <input
                      type="checkbox"
                      className="accent-gold"
                      aria-label="Select all verifiable"
                      checked={allVerifiableSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someVerifiableSelected;
                      }}
                      disabled={verifiableIds.length === 0}
                      onChange={toggleAllVerifiable}
                    />
                  </TableHead>
                )}
                <SortableTableHead sortKey="file" state={docSort} onSort={toggleDocSort}>
                  File
                </SortableTableHead>
                <SortableTableHead sortKey="kind" state={docSort} onSort={toggleDocSort} className="hidden md:table-cell">
                  Kind
                </SortableTableHead>
                <SortableTableHead sortKey="associate" state={docSort} onSort={toggleDocSort} className="hidden sm:table-cell">
                  Associate
                </SortableTableHead>
                <SortableTableHead sortKey="size" state={docSort} onSort={toggleDocSort} className="hidden md:table-cell w-20">
                  Size
                </SortableTableHead>
                <SortableTableHead sortKey="uploaded" state={docSort} onSort={toggleDocSort} className="hidden lg:table-cell w-24">
                  Uploaded
                </SortableTableHead>
                <SortableTableHead sortKey="status" state={docSort} onSort={toggleDocSort} className="w-32">
                  Status
                </SortableTableHead>
                {/* Actions stay visible at EVERY width — hiding this column
                    below md left phone admins able to see documents but
                    unable to verify or reject a single one. The table's
                    overflow-auto wrapper handles the narrow-screen width. */}
                {canManage && <TableHead className="w-44 text-right" aria-label="Actions" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Fragment key={g.associateId}>
                  {/* Associate header row: name + doc count. */}
                  <TableRow className="hover:bg-transparent bg-navy-secondary/40">
                    <TableCell colSpan={colCount} className="py-1.5">
                      <div className="flex items-center gap-2">
                        <Avatar name={g.associateName} size="xs" />
                        <span className="text-xs font-medium text-white truncate">
                          <AssociateLink associateId={g.associateId} tab="documents">
                            {g.associateName}
                          </AssociateLink>
                        </span>
                        <span className="text-2xs tabular-nums text-silver/70">
                          {g.docs.length} document{g.docs.length === 1 ? '' : 's'}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                  {g.docs.map((d) => {
                    const selectable =
                      d.status === 'UPLOADED' || d.status === 'REJECTED';
                    return (
                <TableRow key={d.id} className="group">
                  {canManage && (
                    <TableCell className="w-8">
                      {selectable && (
                        <input
                          type="checkbox"
                          className="accent-gold"
                          aria-label={`Select ${d.filename}`}
                          checked={selectedDocs.has(d.id)}
                          onChange={() => toggleDoc(d.id)}
                        />
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setPreviewDoc(d)}
                      className="text-gold hover:text-gold-bright underline-offset-4 hover:underline font-medium inline-flex items-center gap-1.5 max-w-xs truncate"
                      title={
                        d.fileAvailable
                          ? `Preview ${d.filename}`
                          : 'File missing on server — open for details'
                      }
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{d.filename}</span>
                    </button>
                    {!d.fileAvailable && (
                      <div className="text-xs2 text-alert truncate mt-0.5">
                        File missing on server — please re-upload
                      </div>
                    )}
                    {/* Phone-only secondary line — associate name takes the
                        place of its hidden column. Tap-target area still
                        opens the preview via the file button above. */}
                    <div className="sm:hidden text-xs2 text-silver/70 truncate mt-0.5">
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
                    <Badge variant={statusTone(d.status)} data-status={d.status}>
                      {STATUS_LABELS[d.status]}
                    </Badge>
                    {d.rejectionReason && (
                      <div
                        className="text-alert text-2xs mt-1 max-w-[140px] truncate"
                        title={d.rejectionReason}
                      >
                        {d.rejectionReason}
                      </div>
                    )}
                    {d.expiresAt && (
                      <div
                        className={cn(
                          'text-2xs mt-1 tabular-nums',
                          d.status === 'EXPIRED'
                            ? 'text-alert'
                            : 'text-silver/70',
                        )}
                      >
                        {d.status === 'EXPIRED' ? 'Expired' : 'Expires'}{' '}
                        {fmtDate(d.expiresAt)}
                      </div>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1 can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                    );
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
        );
      })()}

      {view === 'associates' && !allDocs && !error && !allError && (
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
                          <AssociateLink associateId={g.associateId} tab="documents">
                            {g.associateName}
                          </AssociateLink>
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
                        <span className="text-silver/70 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {g.verified > 0 ? (
                        <Badge variant="success">{g.verified}</Badge>
                      ) : (
                        <span className="text-silver/70 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {g.rejected > 0 ? (
                        <Badge variant="destructive">{g.rejected}</Badge>
                      ) : (
                        <span className="text-silver/70 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {g.expired > 0 ? (
                        <Badge variant="destructive">{g.expired}</Badge>
                      ) : (
                        <span className="text-silver/70 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-silver text-xs tabular-nums">
                      {fmtAge(new Date(g.lastActivity).toISOString(), now)}
                    </TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="h-4 w-4 text-silver/70" />
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
        open={folder !== null}
        onOpenChange={(o) => !o && setSelectedAssociateId(null)}
        width="max-w-3xl"
      >
        {folder && (
          <>
            <DrawerHeader>
              <div className="flex items-center gap-3">
                <Avatar name={folder.associateName} size="md" />
                <div className="min-w-0">
                  <DrawerTitle className="truncate">
                    <AssociateLink associateId={folder.associateId} tab="documents">
                      {folder.associateName}
                    </AssociateLink>
                  </DrawerTitle>
                  <DrawerDescription>
                    {folder.loading
                      ? 'Loading documents…'
                      : `${folder.total} document${folder.total === 1 ? '' : 's'} on file`}
                  </DrawerDescription>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {folder.uploaded > 0 && (
                  <Badge variant="pending">
                    {folder.uploaded} awaiting
                  </Badge>
                )}
                {folder.verified > 0 && (
                  <Badge variant="success">
                    {folder.verified} verified
                  </Badge>
                )}
                {folder.rejected > 0 && (
                  <Badge variant="destructive">
                    {folder.rejected} rejected
                  </Badge>
                )}
                {folder.expired > 0 && (
                  <Badge variant="destructive">
                    {folder.expired} expired
                  </Badge>
                )}
              </div>
            </DrawerHeader>
            <DrawerBody>
              {folderError && (
                <ErrorBanner className="mb-3">{folderError}</ErrorBanner>
              )}
              {folder.loading && folder.docs.length === 0 && !folderError && (
                <SkeletonRows count={4} rowHeight="h-12" />
              )}
              {!folder.loading && !folderError && folder.docs.length === 0 && (
                <div className="py-8 text-center text-sm text-silver">
                  No documents on file for this associate.
                </div>
              )}
              {folder.docs.length > 0 && (
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
                  {folder.docs.map((d) => (
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
                          variant={statusTone(d.status)}
                          data-status={d.status}
                        >
                          {STATUS_LABELS[d.status]}
                        </Badge>
                        {d.rejectionReason && (
                          <div
                            className="text-alert text-2xs mt-1 max-w-[160px] truncate"
                            title={d.rejectionReason}
                          >
                            {d.rejectionReason}
                          </div>
                        )}
                        {d.expiresAt && (
                          <div
                            className={cn(
                              'text-2xs mt-1 tabular-nums',
                              d.status === 'EXPIRED'
                                ? 'text-alert'
                                : 'text-silver/70',
                            )}
                          >
                            {d.status === 'EXPIRED' ? 'Expired' : 'Expires'}{' '}
                            {fmtDate(d.expiresAt)}
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
              )}
            </DrawerBody>
            <DrawerFooter>
              {folder.hasDownloadable && (
                <Button asChild variant="secondary">
                  <a
                    href={downloadAllDocumentsUrl(folder.associateId)}
                    download
                    title="Download every available document for this associate as a zip"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download all (.zip)
                  </a>
                </Button>
              )}
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
                <>
                  {/* Optional expiry, captured with the verify. Most useful
                      for IDs / visas / certs; harmless to leave blank. */}
                  <label
                    className="hidden sm:flex items-center gap-1.5 text-xs2 text-silver"
                    title="Optional — when this document lapses it flips to EXPIRED and the associate is asked for a fresh copy"
                  >
                    <span className="whitespace-nowrap">Expires on</span>
                    <Input
                      type="date"
                      value={verifyExpiresAt}
                      onChange={(e) => setVerifyExpiresAt(e.target.value)}
                      aria-label="Expires on (optional)"
                      className="h-8 w-[8.75rem] text-xs"
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const target = previewDoc;
                      await onVerify(target, verifyExpiresAt || undefined);
                      setPreviewDoc(null);
                    }}
                    loading={pendingId === previewDoc.id}
                    className="text-success hover:text-success"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span className="ml-1 hidden sm:inline">Verify</span>
                  </Button>
                </>
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
                  <Textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={4}
                    maxLength={500}
                    placeholder="e.g. Document is blurry — please re-upload a clearer scan."
                    className="mt-1"
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

      {/* Bulk rejection panel — one reason applied to every selected doc.
          Loops the per-id endpoint sequentially so each rejection keeps its
          side effects (task rewind + email to the associate). */}
      <Dialog
        open={bulkRejectOpen}
        onOpenChange={(v) => {
          if (bulkBusy) return;
          setBulkRejectOpen(v);
          if (!v) setBulkRejectReason('');
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Reject {bulkRejectTargets.length} document
              {bulkRejectTargets.length === 1 ? '' : 's'}
            </DialogTitle>
            <DialogDescription>
              The same reason is attached to every selected document. Each
              associate is emailed and their upload task reopens so they can
              re-submit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {selectedDocs.size > bulkRejectTargets.length && (
              <div className="text-xs text-silver">
                {selectedDocs.size - bulkRejectTargets.length} of the selected
                documents are already rejected and will be skipped.
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {BULK_REJECT_PRESETS.map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setBulkRejectReason(r)}
                  className={cn(
                    'rounded-md',
                    bulkRejectReason === r &&
                      'border-gold text-gold bg-gold/10 hover:border-gold hover:text-gold',
                  )}
                >
                  {r}
                </Button>
              ))}
            </div>
            <Field label="Reason" required>
              {(p) => (
                <Textarea
                  value={bulkRejectReason}
                  onChange={(e) => setBulkRejectReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Pick a preset above or write your own."
                  {...p}
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setBulkRejectOpen(false)}
              disabled={bulkBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={onBulkReject}
              loading={bulkBusy}
              disabled={!bulkRejectReason.trim() || bulkRejectTargets.length === 0}
            >
              <XCircle className="h-4 w-4" />
              Reject {bulkRejectTargets.length}
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
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        {label}
      </div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

