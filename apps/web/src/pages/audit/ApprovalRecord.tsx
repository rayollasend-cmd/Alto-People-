import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck } from '@/components/ui/icons';
import {
  APPROVAL_REQUEST_KIND_LABELS,
  ApprovalRequestKindSchema,
  type ApprovalRequestKind,
  type ApprovalRequestStatus,
  type ApprovalRequestSummary,
} from '@alto-people/shared';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { ApprovalRequestCard } from '@/components/approvals/ApprovalRequestCard';
import { apiFetch } from '@/lib/api';
import { QueryError } from '@/components/ui/QueryError';
import { fmtDateTime } from '@/lib/format';
import { listApprovalRequests, type RecordFilters } from '@/lib/approvalRequestsApi';

/**
 * The approval record: every change that went to a second person, across
 * the tenant — pending, approved, rejected and withdrawn — filterable by
 * kind, status, who asked, who decided and when. Each row opens to its
 * before and after, the decision and the reason. Filters live in the URL so
 * a filtered view can be shared with an auditor.
 */

const STATUS_LABEL: Record<ApprovalRequestStatus, string> = {
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
};
const STATUS_TONE: Record<ApprovalRequestStatus, 'pending' | 'success' | 'destructive' | 'default'> = {
  PENDING: 'pending',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'default',
};
const KINDS = ApprovalRequestKindSchema.options;
const STATUSES: ApprovalRequestStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
const FILTER_KEYS = ['kind', 'status', 'requester', 'approver', 'from', 'to'] as const;

interface Person {
  id: string;
  name: string;
}

export function ApprovalRecord() {
  const [sp, setSp] = useSearchParams();
  const filters: RecordFilters = {
    kind: (KINDS as readonly string[]).includes(sp.get('kind') ?? '') ? (sp.get('kind') as ApprovalRequestKind) : undefined,
    status: (STATUSES as string[]).includes(sp.get('status') ?? '') ? (sp.get('status') as ApprovalRequestStatus) : undefined,
    requesterUserId: sp.get('requester') ?? undefined,
    approverUserId: sp.get('approver') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
  };
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    setSp(next, { replace: true });
  };
  const activeFilters = FILTER_KEYS.filter((k) => sp.get(k)).length;
  const anyFilter = activeFilters > 0;
  const clearFilters = () => {
    const next = new URLSearchParams(sp);
    for (const k of FILTER_KEYS) next.delete(k);
    setSp(next, { replace: true });
  };

  const record = useQuery({
    queryKey: ['approvals', 'record', filters],
    queryFn: () => listApprovalRequests('all', filters),
  });
  const people = useQuery({
    queryKey: ['approvals', 'record', 'people'],
    queryFn: () => apiFetch<{ requesters: Person[]; approvers: Person[] }>('/approvals/requests/people'),
  });

  const columns = useMemo<GridColumn<ApprovalRequestSummary>[]>(
    () => [
      { key: 'createdAt', header: 'Asked', accessor: (r) => new Date(r.createdAt).getTime(), csv: (r) => r.createdAt, sortable: true, searchable: false, className: 'tabular-nums text-silver', cell: (r) => fmtDateTime(r.createdAt) },
      { key: 'title', header: 'Change', accessor: (r) => r.title, primary: true, sortable: true, cell: (r) => <span className="font-medium">{r.title}</span> },
      { key: 'kind', header: 'Kind', accessor: (r) => APPROVAL_REQUEST_KIND_LABELS[r.kind], sortable: true, cardMeta: true, cell: (r) => <Badge variant="outline" size="sm">{APPROVAL_REQUEST_KIND_LABELS[r.kind]}</Badge> },
      { key: 'requester', header: 'Asked by', accessor: (r) => r.requester?.name ?? 'A workflow', sortable: true },
      { key: 'decidedBy', header: 'Decided by', accessor: (r) => r.decidedBy?.name ?? '', sortable: true, cell: (r) => r.decidedBy?.name ?? <span className="text-silver">—</span> },
      { key: 'decidedAt', header: 'Decided', accessor: (r) => (r.decidedAt ? new Date(r.decidedAt).getTime() : null), csv: (r) => r.decidedAt ?? '', sortable: true, searchable: false, className: 'tabular-nums text-silver', cell: (r) => (r.decidedAt ? fmtDateTime(r.decidedAt) : '—') },
      { key: 'status', header: 'Status', accessor: (r) => STATUS_LABEL[r.status], sortable: true, cardMeta: true, cell: (r) => <Badge variant={STATUS_TONE[r.status]} size="sm">{r.status === 'APPROVED' && r.applyError ? 'Approved, not applied' : STATUS_LABEL[r.status]}</Badge> },
    ],
    [],
  );

  const rows = record.data?.requests ?? null;
  // Seven filters over "No requests yet" were noise (F500 G4): they appear once there is a record to filter.
  const showFilters = anyFilter || (rows?.length ?? 0) > 0;

  return (
    <ListTemplate
      title="Approval record"
      subtitle="Every change that went to a second person — who asked, who decided, the before and after, and the reason."
    >
      {record.isError ? (
        <QueryError what="the approval record" query={record} />
      ) : (
      <DataGrid<ApprovalRequestSummary>
        id="approval-record"
        caption="Approval record"
        rows={rows}
        loading={record.isPending}
        columns={columns}
        rowKey={(r) => r.id}
        urlState={false}
        noun={{ one: 'request', many: 'requests' }}
        search={{ placeholder: 'Search the record' }}
        activeFilters={activeFilters}
        onClearFilters={clearFilters}
        filters={
          showFilters ? (
          <>
            <div className="w-40">
              <Select size="sm" value={filters.kind ?? ''} onChange={(e) => set('kind', e.target.value)} aria-label="Filter by kind">
                <option value="">All kinds</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {APPROVAL_REQUEST_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-36">
              <Select size="sm" value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Filter by status">
                <option value="">All statuses</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-44">
              <Select size="sm" value={filters.requesterUserId ?? ''} onChange={(e) => set('requester', e.target.value)} aria-label="Filter by who asked">
                <option value="">Anyone asked</option>
                {(people.data?.requesters ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-44">
              <Select size="sm" value={filters.approverUserId ?? ''} onChange={(e) => set('approver', e.target.value)} aria-label="Filter by who decided">
                <option value="">Anyone decided</option>
                {(people.data?.approvers ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <Input type="date" className="h-9 w-40" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value)} aria-label="Asked on or after" />
            <Input type="date" className="h-9 w-40" value={filters.to ?? ''} min={filters.from ?? undefined} onChange={(e) => set('to', e.target.value)} aria-label="Asked on or before" />
          </>
          ) : undefined
        }
        expandable={{
          single: true,
          label: (r) => `Before and after: ${r.title}`,
          render: (r) => (
            <div className="py-2">
              <ApprovalRequestCard request={r} />
            </div>
          ),
        }}
        empty={{
          icon: ClipboardCheck,
          title: anyFilter ? 'Nothing matches these filters' : 'No requests yet',
          description: anyFilter ? 'Widen the dates or clear a filter.' : 'When a change needs a second person, it is kept here for good — decided or not.',
        }}
      />
      )}
    </ListTemplate>
  );
}
