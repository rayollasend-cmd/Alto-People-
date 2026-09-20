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
  RefreshCw,
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
  DocumentSort,
  DocumentStatus,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  DOCUMENT_KIND_LABEL,
  bulkVerifyDocuments,
  downloadAllDocumentsUrl,
  getDocumentStats,
  isPreviewable,
  previewDocumentUrl,
  listAdminDocuments,
  rejectDocument,
  requestDocumentReupload,
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
import { QueryError } from '@/components/ui/QueryError';
import { Eye, EyeOff, LayoutGrid, Rows3 } from 'lucide-react';
import { REJECT_PRESETS, RejectDocumentDialog } from '@/components/RejectDocumentDialog';
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
  type TableSortState,
} from '@/components/ui/Table';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * Kinds that carry a printed expiry date — the ones where verifying
 * without capturing it means the document can never lapse.
 *
 * `expiresAt` is what the daily sweep reads to flip a document to EXPIRED
 * and ask the associate for a fresh copy. The row's one-click Verify used
 * to pass no expiry at all, and it was the ONLY action offered on the row:
 * a reviewer working the queue at speed produced a vault of identity
 * documents that never expire. These kinds now ask; everything else keeps
 * the single click, because inventing an expiry for a policy PDF is worse
 * than not having one.
 */
const EXPIRING_KINDS = new Set<DocumentKind>([
  'ID',
  'I9_SUPPORTING',
  'J1_DS2019',
  'J1_VISA',
]);

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

// "drug test result", "ID", … for toasts about a document's kind.
const kindPhrase = (k: DocumentKind): string => {
  const label = DOCUMENT_KIND_LABEL[k] ?? k.replace(/_/g, ' ');
  // Acronym labels (ID, SSN card, DS-2019…) keep their casing; sentence-
  // case labels read better lowercased mid-sentence.
  return /^[A-Z][a-z]/.test(label) ? label.toLowerCase() : label;
};


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

/**
 * The kinds you would not want a stranger reading over your shoulder.
 * The gallery shows everything by default — seeing the documents IS the
 * job — but these can be blurred with one click when somebody is standing
 * behind you, and the choice is remembered.
 */
const OVER_THE_SHOULDER = new Set<DocumentKind>([
  'ID',
  'SSN_CARD',
  'I9_SUPPORTING',
  'J1_VISA',
  'J1_DS2019',
  'W4_PDF',
]);

/**
 * One document, actually visible.
 *
 * The folder used to be a list of filenames: to see whether an ID was the
 * right way up, or which page of the agreement was signed, you opened each
 * one in turn and closed it again. For a six-document folder that is
 * twelve clicks to learn what a glance would have told you.
 */
function DocumentTile({
  doc,
  blurred,
  onOpen,
}: {
  doc: DocumentRecord;
  blurred: boolean;
  onOpen: () => void;
}) {
  const isImage = doc.mimeType.startsWith('image/');
  const isPdf = doc.mimeType === 'application/pdf';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/tile flex flex-col overflow-hidden rounded-lg border border-navy-secondary text-left transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <span className="relative flex h-36 items-center justify-center overflow-hidden bg-navy-secondary/40">
        {isImage ? (
          <img
            src={previewDocumentUrl(doc.id)}
            alt=""
            // Lazy: a folder can hold thirty documents and the drawer
            // should not fetch all of them to show the first four.
            loading="lazy"
            decoding="async"
            className={cn(
              'h-full w-full object-cover transition',
              blurred && 'blur-md',
            )}
          />
        ) : isPdf ? (
          // A PDF's first page, rendered by the browser. Pointer events off
          // so the tile stays one click, not a nested scroll area.
          <object
            data={`${previewDocumentUrl(doc.id)}#toolbar=0&navpanes=0&view=FitH`}
            type="application/pdf"
            aria-hidden="true"
            className={cn('pointer-events-none h-full w-full', blurred && 'blur-md')}
          >
            <FileText className="h-8 w-8 text-silver/50" aria-hidden="true" />
          </object>
        ) : (
          <FileText className="h-8 w-8 text-silver/50" aria-hidden="true" />
        )}
        {blurred && (
          <span className="absolute inset-0 flex items-center justify-center">
            <EyeOff className="h-5 w-5 text-silver/80" aria-hidden="true" />
          </span>
        )}
        {!isPreviewable(doc.mimeType) && (
          <span className="absolute bottom-1 right-1 rounded bg-navy/80 px-1.5 py-0.5 text-2xs text-silver">
            No preview
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1 p-2">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-white">
            {DOCUMENT_KIND_LABEL[doc.kind] ?? doc.kind.replace(/_/g, ' ')}
          </span>
          <Badge variant={statusTone(doc.status)} size="sm" data-status={doc.status}>
            {STATUS_LABELS[doc.status]}
          </Badge>
        </span>
        <span className="truncate text-2xs text-silver/70">
          {fmtRelativeDate(doc.createdAt)}
        </span>
        {doc.rejectionReason && (
          <span className="line-clamp-2 text-2xs text-alert">{doc.rejectionReason}</span>
        )}
      </span>
    </button>
  );
}

/** Rows per page. The server clamps at 200; 50 is a screenful that keeps
 *  the payload small enough to feel instant on a store tablet. */
const PAGE_SIZE = 50;

export function AdminDocumentsView({ canManage }: AdminDocumentsViewProps) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
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
  // Which page of the queue. Reset whenever the slice changes — page 4 of
  // a filter you just left is a guaranteed empty table.
  const [page, setPage] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Deferred so typing stays responsive while the query for the new term
  // is in flight; the previous page stays on screen meanwhile.
  const deferredSearch = useDeferredValue(search);
  // Deferred so typing stays responsive while the query for the new term
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  // Session-local "requested <ago>" markers for EXPIRED rows (doc id →
  // epoch ms). The server doesn't stamp renewal requests on the document
  // row (that'd be a schema change), so the marker only survives as long
  // as this mount — good enough to stop double-sends while triaging.
  const [reuploadRequestedAt, setReuploadRequestedAt] = useState<
    Record<string, number>
  >({});
  const [selectedAssociateId, setSelectedAssociateId] = useState<string | null>(null);
  // Gallery by default: the folder's job is to show you the documents.
  const [folderView, setFolderView] = usePersistentState<'gallery' | 'list'>(
    'alto:documents.folderView.v1',
    'gallery',
    (v): v is 'gallery' | 'list' => v === 'gallery' || v === 'list',
  );
  const [blurSensitive, setBlurSensitive] = usePersistentState<boolean>(
    'alto:documents.blurSensitive.v1',
    false,
    (v): v is boolean => typeof v === 'boolean',
  );
  const [previewDoc, setPreviewDoc] = useState<DocumentRecord | null>(null);
  // Optional expiry captured alongside a single verify in the preview
  // viewer ('YYYY-MM-DD'). Bulk verify stays expiry-less on purpose.
  const [verifyExpiresAt, setVerifyExpiresAt] = useState('');
  // The row-level verify for a kind that expires: hold the document while
  // the reviewer supplies (or explicitly declines) the date.
  const [verifyTarget, setVerifyTarget] = useState<DocumentRecord | null>(null);
  const [rowExpiresAt, setRowExpiresAt] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  // Bulk-reject panel state — one reason applied to every selected doc.
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');

  // Column sort, held here rather than by useTableSort: that hook sorts
  // the rows it is given, which is precisely the bug — it can only order
  // the page, never the vault.
  type DocSortKey = 'file' | 'kind' | 'associate' | 'size' | 'uploaded' | 'status';
  const [docSort, setDocSort] = useState<TableSortState<DocSortKey>>({
    key: 'uploaded',
    direction: 'desc',
  });
  const toggleDocSort = useCallback((key: DocSortKey) => {
    setDocSort((prev) =>
      prev.key === key
        ? prev.direction === 'asc'
          ? { key, direction: 'desc' }
          : // Third click returns to the default: newest first.
            { key: 'uploaded', direction: 'desc' }
        : { key, direction: 'asc' },
    );
  }, []);

  // Sorting and paging are the SERVER's job. A page sorted after it was
  // cut shows the oldest rows of that page, not of the vault — which is
  // why "clear what has waited longest", the queue's entire reason to
  // exist, could not be done here before.
  const sortParam: DocumentSort = useMemo(() => {
    const dir = docSort.direction === 'asc' ? 'asc' : 'desc';
    switch (docSort.key) {
      case 'file':
      case 'kind':
      case 'associate':
      case 'size':
      case 'status':
        return `${docSort.key}_${dir}` as DocumentSort;
      case 'uploaded':
        return `uploaded_${dir}` as DocumentSort;
      default:
        return 'uploaded_desc';
    }
  }, [docSort]);

  const listParams = useMemo(
    () => ({
      ...(filter === 'ACTION_NEEDED'
        ? { status: [...ACTION_NEEDED_STATUSES] as DocumentStatus[] }
        : filter === 'ALL'
          ? {}
          : { status: filter as DocumentStatus }),
      ...(kindFilter === 'ALL' ? {} : { kind: kindFilter }),
      ...(deferredSearch.trim() ? { q: deferredSearch.trim() } : {}),
      sort: sortParam,
      page,
      pageSize: PAGE_SIZE,
    }),
    [filter, kindFilter, deferredSearch, sortParam, page],
  );

  const docsQuery = useQuery({
    queryKey: ['documents', 'admin', listParams],
    queryFn: () => listAdminDocuments(listParams),
    // Keeps the previous page on screen while the next one loads, instead
    // of blanking the table on every sort or page step.
    placeholderData: (prev) => prev,
  });
  const docs = docsQuery.data?.documents ?? null;
  const pageTotal = docsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(pageTotal / PAGE_SIZE));

  // Counts over the WHOLE vault. These used to be tallied from the capped
  // list, so every number on the page was quietly wrong past the cap.
  const statsQuery = useQuery({
    queryKey: ['documents', 'admin', 'stats'],
    queryFn: getDocumentStats,
  });

  const folderQuery = useQuery({
    queryKey: ['documents', 'admin', 'folder', selectedAssociateId],
    queryFn: () => listAdminDocuments({ associateId: selectedAssociateId!, pageSize: 200 }),
    enabled: !!selectedAssociateId,
  });
  const folderDocs = folderQuery.data?.documents ?? null;

  /** One invalidate replaces the three full refetches every action used to
   *  fire — approving a single document cost three 200-row requests. */
  const invalidateDocs = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['documents', 'admin'] });
  }, [queryClient]);

  // A filter change makes the current page meaningless: page 4 of a slice
  // you just left is a guaranteed empty table.
  useEffect(() => {
    setPage(0);
  }, [filter, kindFilter, deferredSearch, sortParam]);

  // The optional expiry date belongs to one document — clear it whenever the
  // preview switches docs or closes.
  useEffect(() => {
    setVerifyExpiresAt('');
  }, [previewDoc?.id]);


  // Day-granularity "now" for the fmtAge labels in the render body. NOT a
  // dependency of the stats memo below — that made the memo's inputs change
  // on every render, so it never cached and re-scanned all docs per keystroke.
  const now = Date.now();

  // Straight from the server, over the whole vault. Tallying the capped
  // list was why every number here went quietly wrong past the cap.
  const s = statsQuery.data;
  const stats = {
    total: s?.total ?? 0,
    uploaded: s?.uploaded ?? 0,
    verified: s?.verified ?? 0,
    rejected: s?.rejected ?? 0,
    expired: s?.expired ?? 0,
    oldestUploadedDays: s?.oldestPendingAt
      ? Math.floor((now - new Date(s.oldestPendingAt).getTime()) / ONE_DAY_MS)
      : null,
  };

  // Only offer kinds that actually exist in the tenant, sorted, so the
  // dropdown stays short instead of listing all 16 possible kinds.
  // Derived from the page in hand. It narrows as you page, which is
  // honest: the alternative is loading the vault to populate a dropdown.
  const availableKinds = useMemo(() => {
    const set = new Set<DocumentKind>();
    for (const d of docs ?? []) set.add(d.kind);
    return Array.from(set).sort();
  }, [docs]);

  // Deferred search term for the heavy derived lists: the input repaints
  // immediately while React filters the doc queue / regroups associates at
  // background priority, keeping the previous results on screen meanwhile.

  // Search runs on the server (it is part of listParams), so the page it
  // returns is already the matching page. Filtering here as well would
  // only ever search what this page happened to contain.
  const visibleDocs = docs;

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

  // Drop any selection when the visible slice changes, so a bulk action
  // can never touch a row the user can no longer see. Lives HERE, below
  // useSelection, rather than above it with `clearSelection` left out of
  // the deps to dodge the temporal-dead-zone error — which is how
  // `search` and `page` came to be missing in the first place.
  useEffect(() => {
    clearSelection();
  }, [filter, kindFilter, view, deferredSearch, page, sortParam, clearSelection]);

  // The rows arrive already ordered by the server, across the whole vault
  // rather than within this page. Nothing is re-sorted here.
  const sortedDocs = visibleDocs ?? [];

  // Folders for the "By associate" view, built from the page in hand.
  // That page is sorted by associate while this view is active, so a
  // person's documents arrive together rather than scattered across pages.
  const associateGroups = useMemo(() => {
    if (!docs) return null;
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
    for (const d of docs) {
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
  }, [docs]);

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

  // Returns whether the verify succeeded so callers with follow-up UI (the
  // preview closes itself on success) don't dismiss on a failure this
  // handler already swallowed into a toast.
  const onVerify = async (
    d: DocumentRecord,
    expiresAt?: string,
  ): Promise<boolean> => {
    if (pendingId) return false;
    setPendingId(d.id);
    try {
      await verifyDocument(d.id, expiresAt ? { expiresAt } : {});
      toast.success(`Verified ${d.filename}.`);
      // One invalidate, not three full list requests to approve one row.
      invalidateDocs();
      return true;
    } catch (err) {
      toast.error('Verify failed.', {
        description: err instanceof ApiError ? err.message : undefined,
      });
      return false;
    } finally {
      setPendingId(null);
    }
  };

  // Renewal nudge for an EXPIRED row: reopens the associate's upload task
  // server-side and notifies them. The row itself doesn't change (it stays
  // EXPIRED until the replacement arrives as a new record), so no refetch —
  // just remember the send locally for the quiet "requested" marker.
  const onRequestReupload = async (d: DocumentRecord) => {
    if (pendingId) return;
    setPendingId(d.id);
    try {
      await requestDocumentReupload(d.id);
      toast.success(
        `Asked ${d.associateName ?? 'the associate'} for a new ${kindPhrase(d.kind)}.`,
      );
      setReuploadRequestedAt((m) => ({ ...m, [d.id]: Date.now() }));
    } catch (err) {
      toast.error('Request failed.', {
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
      invalidateDocs();
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
      // Must match the rule that decides which rows get a checkbox at all
      // (UPLOADED or REJECTED). This used to accept VERIFIED — a status
      // that can never be selected — so the two rules quietly disagreed.
      (docs ?? []).filter(
        (d) =>
          selectedDocs.has(d.id) &&
          (d.status === 'UPLOADED' || d.status === 'REJECTED'),
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
    invalidateDocs();
    setBulkBusy(false);
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
      {canManage && stats.total > 0 && (
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
            onClick={() => {
              // Land on the queue's EXPIRED slice — the chips (and the
              // status filter) only exist in the queue view.
              setView('queue');
              setFilter('EXPIRED');
            }}
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
                    : f.value === 'UPLOADED'
                      ? stats.uploaded
                      : f.value === 'VERIFIED'
                        ? stats.verified
                        : f.value === 'REJECTED'
                          ? stats.rejected
                          : f.value === 'EXPIRED'
                            ? stats.expired
                            : 0;
              const active = filter === f.value;
              return (
                <FilterChip
                  key={f.value}
                  active={active}
                  onClick={() => setFilter(f.value)}
                  className="gap-1.5 rounded-md"
                >
                  {f.label}
                  {statsQuery.data && (
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

      {/* Every failure now offers a way out. These were three bare
          banners with no retry — a page reload was the only recovery. */}
      {docsQuery.isError && (
        <div className="mb-4">
          <QueryError what="these documents" query={docsQuery} />
        </div>
      )}
      {statsQuery.isError && (
        <div className="mb-4">
          <QueryError what="the vault totals" query={statsQuery} />
        </div>
      )}

      {view === 'queue' && !docs && !docsQuery.isError && (
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
        // THE QUEUE IS FLAT UNLESS YOU ASK FOR PEOPLE.
        //
        // This used to group by associate always, in order of first
        // appearance under the current sort — which meant sorting by age
        // ordered the GROUPS by their oldest document, not the documents.
        // The second-oldest thing in the vault could sit halfway down the
        // page inside somebody else's group, so "clear what has waited
        // longest" — the queue's entire job, and what the SLA banner tells
        // you to do — could not actually be done.
        //
        // Grouping now happens only when the sort is by associate, where
        // it is what you asked for and the rows are contiguous anyway.
        const groupByPerson = docSort.key === 'associate';
        const groups: Array<{
          associateId: string;
          associateName: string;
          docs: DocumentRecord[];
        }> = [];
        const groupIndex = new Map<string, number>();
        if (!groupByPerson) {
          groups.push({ associateId: '', associateName: '', docs: [...sortedDocs] });
        } else
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
              <div className="flex flex-wrap gap-2">
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
                <Fragment key={g.associateId || 'flat'}>
                  {/* Associate header row: name + doc count. Only when the
                      rows are actually grouped by person. */}
                  {groupByPerson && (
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
                  )}
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
                            onClick={() => {
                              if (EXPIRING_KINDS.has(d.kind)) {
                                setRowExpiresAt(d.expiresAt?.slice(0, 10) ?? '');
                                setVerifyTarget(d);
                              } else {
                                void onVerify(d);
                              }
                            }}
                            loading={pendingId === d.id}
                            title={
                              EXPIRING_KINDS.has(d.kind)
                                ? 'Mark verified — this kind carries an expiry date'
                                : 'Mark verified'
                            }
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
                            }}
                            disabled={pendingId === d.id}
                            title="Reject with reason"
                            className="text-alert hover:text-alert"
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            <span className="ml-1 hidden lg:inline">Reject</span>
                          </Button>
                        )}
                        {d.status === 'EXPIRED' && (
                          <>
                            {reuploadRequestedAt[d.id] !== undefined && (
                              <span className="text-2xs text-silver/70 tabular-nums whitespace-nowrap">
                                requested{' '}
                                {fmtRelativeDate(
                                  new Date(reuploadRequestedAt[d.id]).toISOString(),
                                )}
                              </span>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onRequestReupload(d)}
                              loading={pendingId === d.id}
                              title="Ask the associate to upload a current copy"
                              className="text-gold hover:text-gold"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              <span className="ml-1 hidden lg:inline">
                                Request re-upload
                              </span>
                            </Button>
                          </>
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

      {/* Paging. The vault used to stop dead at the server's 200-row cap
          with a banner apologising that the numbers above were wrong. */}
      {view === 'queue' && pageTotal > PAGE_SIZE && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-silver tabular-nums">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, pageTotal)} of{' '}
            {pageTotal.toLocaleString()}
          </span>
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={page === 0 || docsQuery.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-silver tabular-nums">
              Page {page + 1} of {pageCount}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={page + 1 >= pageCount || docsQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </span>
        </div>
      )}

      {view === 'associates' && !docs && !docsQuery.isError && (
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
              {folderQuery.isError && (
                <div className="mb-3">
                  <QueryError what="this folder" query={folderQuery} />
                </div>
              )}
              {folder.loading && folder.docs.length === 0 && !folderQuery.isError && (
                <SkeletonRows count={4} rowHeight="h-12" />
              )}
              {!folder.loading && !folderQuery.isError && folder.docs.length === 0 && (
                <EmptyState
                  icon={FileText}
                  title="Nothing on file"
                  description="This associate has no documents in the vault yet."
                />
              )}
              {folder.docs.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <ViewToggle<'gallery' | 'list'>
                    ariaLabel="How to show this folder"
                    value={folderView}
                    onChange={setFolderView}
                    options={[
                      { value: 'gallery', label: 'Gallery', icon: LayoutGrid },
                      { value: 'list', label: 'List', icon: Rows3 },
                    ]}
                  />
                  {folderView === 'gallery' &&
                    folder.docs.some((d) => OVER_THE_SHOULDER.has(d.kind)) && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setBlurSensitive(!blurSensitive)}
                        aria-pressed={blurSensitive}
                      >
                        {blurSensitive ? (
                          <Eye className="h-3.5 w-3.5" />
                        ) : (
                          <EyeOff className="h-3.5 w-3.5" />
                        )}
                        {blurSensitive ? 'Show identity documents' : 'Blur identity documents'}
                      </Button>
                    )}
                </div>
              )}

              {folder.docs.length > 0 && folderView === 'gallery' && (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {folder.docs.map((d) => (
                    <DocumentTile
                      key={d.id}
                      doc={d}
                      blurred={blurSensitive && OVER_THE_SHOULDER.has(d.kind)}
                      onOpen={() => setPreviewDoc(d)}
                    />
                  ))}
                </div>
              )}

              {folder.docs.length > 0 && folderView === 'list' && (
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
                                }}
                                disabled={pendingId === d.id}
                                title="Reject with reason"
                                className="text-alert hover:text-alert"
                              >
                                <ShieldAlert className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {d.status === 'EXPIRED' && (
                              <>
                                {reuploadRequestedAt[d.id] !== undefined && (
                                  <span className="text-2xs text-silver/70 tabular-nums whitespace-nowrap">
                                    requested{' '}
                                    {fmtRelativeDate(
                                      new Date(
                                        reuploadRequestedAt[d.id],
                                      ).toISOString(),
                                    )}
                                  </span>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => onRequestReupload(d)}
                                  loading={pendingId === d.id}
                                  title="Ask the associate to upload a current copy"
                                  className="text-gold hover:text-gold"
                                >
                                  <RefreshCw className="h-3.5 w-3.5" />
                                </Button>
                              </>
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
                      const ok = await onVerify(target, verifyExpiresAt || undefined);
                      // Close only on success — a failed verify keeps the
                      // document (and the typed expiry date) on screen so
                      // the reviewer can retry instead of re-finding both.
                      if (ok) setPreviewDoc(null);
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

      {/* Verify-with-expiry. Only for kinds that carry a printed expiry
          date: the row's Verify used to be the only action offered and it
          passed no expiry at all, so triaging at speed produced identity
          documents that could never lapse. */}
      <Dialog
        open={!!verifyTarget}
        onOpenChange={(v) => {
          if (!v) {
            setVerifyTarget(null);
            setRowExpiresAt('');
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Verify document</DialogTitle>
            <DialogDescription>
              When this lapses it flips to Expired and the associate is asked
              for a fresh copy.
            </DialogDescription>
          </DialogHeader>
          {verifyTarget && (
            <div className="space-y-3">
              <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-2.5 text-xs">
                <div className="truncate font-medium text-white">
                  {verifyTarget.filename}
                </div>
                <div className="mt-0.5 text-silver">
                  {verifyTarget.kind.replace(/_/g, ' ')}
                  {verifyTarget.associateName ? ` · ${verifyTarget.associateName}` : ''}
                </div>
              </div>
              <label className="block text-sm">
                <span className="mb-1 block text-silver">Expires on</span>
                <Input
                  type="date"
                  autoFocus
                  value={rowExpiresAt}
                  onChange={(e) => setRowExpiresAt(e.target.value)}
                  aria-label="Expires on"
                />
              </label>
            </div>
          )}
          <DialogFooter className="sm:justify-between">
            {/* Some IDs genuinely have no expiry — a state ID card, a
                permanent resident card issued without one. Saying so is
                a decision; leaving the field blank by accident is not. */}
            <Button
              variant="ghost"
              disabled={!!pendingId}
              onClick={async () => {
                const t = verifyTarget;
                if (!t) return;
                if (await onVerify(t)) {
                  setVerifyTarget(null);
                  setRowExpiresAt('');
                }
              }}
            >
              No expiry date
            </Button>
            <Button
              loading={!!verifyTarget && pendingId === verifyTarget.id}
              disabled={!rowExpiresAt || !!pendingId}
              onClick={async () => {
                const t = verifyTarget;
                if (!t) return;
                if (await onVerify(t, rowExpiresAt)) {
                  setVerifyTarget(null);
                  setRowExpiresAt('');
                }
              }}
            >
              <ShieldCheck className="h-4 w-4" />
              Verify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One shared dialog, not a third copy of the same three preset
          reasons and the same POST. The bulk panel below is genuinely
          different — one reason applied to many — so it keeps its own
          markup, but it now imports the presets instead of restating
          them. */}
      <RejectDocumentDialog
        doc={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onRejected={() => {
          setRejectTarget(null);
          invalidateDocs();
        }}
      />

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
              {REJECT_PRESETS.map((r) => (
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
  onClick,
}: {
  label: string;
  value: string;
  tone?: string;
  /** When set, the stat renders as a button that jumps to its filtered list. */
  onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
        {label}
      </div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`Show ${label.toLowerCase()} documents`}
        className="min-w-[6rem] rounded-md text-left transition-opacity hover:opacity-75"
      >
        {body}
      </button>
    );
  }
  return <div className="min-w-[6rem]">{body}</div>;
}

