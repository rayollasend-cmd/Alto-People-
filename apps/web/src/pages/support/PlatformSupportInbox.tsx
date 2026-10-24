import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDateTime, fmtRelativeDate } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid } from '@/components/ui/DataGrid';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { FilterBar } from '@/components/ui/FilterBar';
import { Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ListTemplate } from '@/components/templates';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Brief 2-6 step 5 — the platform inbox: every customer's support requests,
 * for the platform operator's admins. An answer reaches the requester's
 * request page and bell. Another organization's admins get a 404 here.
 *
 * F500 G4: a list, not a stack of forms — Open / In progress / Resolved,
 * each row the subject, who and how old, filterable by organization and
 * kind; the thread and the answer open in a drawer (the bell's link,
 * ?id=, opens the same one).
 */

type Status = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';

export interface InboxRequest {
  id: string;
  tenant: string | null;
  requester: string;
  category: string;
  subject: string;
  body: string;
  pageUrl: string | null;
  appVersion: string | null;
  status: Status;
  reply: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

const STATUS_LABEL: Record<Status, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', RESOLVED: 'Resolved' };
const STATUS_VARIANT: Record<Status, 'pending' | 'accent' | 'success'> = { OPEN: 'pending', IN_PROGRESS: 'accent', RESOLVED: 'success' };
export const CATEGORY_LABEL: Record<string, string> = { QUESTION: 'Question', PROBLEM: 'Problem', BILLING: 'Billing', ACCOUNT: 'Account', OTHER: 'Other' };
const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, ' ');

const TABS = ['open', 'progress', 'resolved'] as const;
type Tab = (typeof TABS)[number];
const TAB_STATUS: Record<Tab, Status> = { open: 'OPEN', progress: 'IN_PROGRESS', resolved: 'RESOLVED' };

export function PlatformSupportInbox() {
  const qc = useQueryClient();
  const [tab, setTab] = useUrlParam<Tab>('tab', 'open', TABS, { history: 'push' });
  const [org, setOrg] = useUrlParam<string>('org', '');
  const [category, setCategory] = useUrlParam<string>('category', '');
  const [openId, setOpenId] = useUrlParam<string>('id', '');
  const status = TAB_STATUS[tab];
  const q = useQuery({
    queryKey: ['support', 'inbox', status],
    queryFn: () => apiFetch<{ requests: InboxRequest[]; counts?: Record<Status, number> }>(`/support/inbox?status=${status}`),
  });
  const rows = useMemo(() => q.data?.requests ?? [], [q.data]);
  const orgs = useMemo(() => [...new Set(rows.map((r) => r.tenant ?? 'Unknown organization'))].sort(), [rows]);
  const shown = useMemo(() => rows.filter((r) => (!org || (r.tenant ?? 'Unknown organization') === org) && (!category || r.category === category)), [rows, org, category]);
  // The bell links to ?id=: find it in whichever tab holds it.
  const linked = useQuery({
    queryKey: ['support', 'inbox', 'all-for-link'],
    queryFn: async () => {
      const all = await Promise.all((['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const).map((s) => apiFetch<{ requests: InboxRequest[] }>(`/support/inbox?status=${s}`)));
      return all.flatMap((a) => a.requests);
    },
    enabled: !!openId && !rows.some((r) => r.id === openId) && q.isSuccess,
  });
  const open = rows.find((r) => r.id === openId) ?? linked.data?.find((r) => r.id === openId) ?? null;
  const counts = q.data?.counts;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['support', 'inbox'] });

  return (
    <ListTemplate
      title="Support inbox"
      subtitle="Every organization’s requests to the platform. Open work is oldest first; an answer reaches the requester’s bell."
      filters={
        <div className="space-y-3">
          <SegmentedControl
            ariaLabel="Requests by status"
            value={tab}
            onChange={(v) => setTab(v)}
            options={TABS.map((t) => ({ value: t, label: STATUS_LABEL[TAB_STATUS[t]], count: counts?.[TAB_STATUS[t]] }))}
          />
          {rows.length > 0 && (
            <FilterBar urlKey={['org', 'category']}>
              <Select size="sm" aria-label="Organization" value={org} onChange={(e) => setOrg(e.target.value)} className="w-full sm:w-56">
                <option value="">Every organization</option>
                {orgs.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </Select>
              <Select size="sm" aria-label="Kind" value={category} onChange={(e) => setCategory(e.target.value)} className="w-full sm:w-44">
                <option value="">Every kind</option>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </FilterBar>
          )}
        </div>
      }
      drawer={open ? <RequestDrawer key={open.id} r={open} onClose={() => setOpenId('')} onDone={refresh} /> : null}
    >
      {q.isError ? (
        <QueryError what="the support inbox" query={q} />
      ) : (
        <DataGrid<InboxRequest>
          id="support-inbox"
          caption="Support requests"
          noun={{ one: 'request', many: 'requests' }}
          rows={q.data ? shown : null}
          loading={q.isPending}
          rowKey={(r) => r.id}
          search={{ placeholder: 'Search subject, requester…' }}
          urlKey="requests"
          exportCsv={false}
          activeFilters={(org ? 1 : 0) + (category ? 1 : 0)}
          onClearFilters={() => {
            setOrg('');
            setCategory('');
          }}
          empty={{ icon: Inbox, title: tab === 'resolved' ? 'Nothing resolved yet' : tab === 'progress' ? 'Nothing in progress' : 'Nothing open', description: tab === 'open' ? 'When someone in any organization asks for help, it lands here and in your bell.' : undefined }}
          onRowClick={(r) => setOpenId(r.id)}
          rowActionLabel={(r) => `Open ${r.subject}`}
          columns={[
            { key: 'subject', header: 'Subject', accessor: (r) => r.subject, primary: true, sortable: true, cell: (r) => <span className="font-medium text-ink">{r.subject}</span> },
            { key: 'org', header: 'Organization', accessor: (r) => r.tenant ?? 'Unknown organization', sortable: true, cardMeta: true },
            { key: 'requester', header: 'Requester', accessor: (r) => r.requester, sortable: true, className: 'text-ink-muted' },
            { key: 'category', header: 'Kind', accessor: (r) => categoryLabel(r.category), sortable: true, cardMeta: true },
            {
              key: 'age',
              header: tab === 'resolved' ? 'Resolved' : 'Age',
              accessor: (r) => (tab === 'resolved' ? (r.resolvedAt ?? r.createdAt) : r.createdAt),
              sortable: true,
              searchable: false,
              className: 'whitespace-nowrap tabular-nums',
              cell: (r) => {
                const at = tab === 'resolved' ? (r.resolvedAt ?? r.createdAt) : r.createdAt;
                return <span title={fmtDateTime(at)}>{fmtRelativeDate(at)}</span>;
              },
            },
            { key: 'status', header: 'Status', accessor: (r) => STATUS_LABEL[r.status], cell: (r) => <Badge variant={STATUS_VARIANT[r.status]} size="sm">{STATUS_LABEL[r.status]}</Badge> },
          ]}
        />
      )}
    </ListTemplate>
  );
}

function RequestDrawer({ r, onClose, onDone }: { r: InboxRequest; onClose: () => void; onDone: () => void }) {
  const [reply, setReply] = useState(r.reply ?? '');
  const [busy, setBusy] = useState<Status | null>(null);
  useEffect(() => setReply(r.reply ?? ''), [r.reply]);
  const move = async (status: Status) => {
    setBusy(status);
    try {
      await apiFetch(`/support/${r.id}`, { method: 'PATCH', body: { status, reply: reply.trim() || null } });
      toast.success(status === 'RESOLVED' ? 'Resolved. The requester was told.' : status === 'IN_PROGRESS' ? 'Marked in progress.' : 'Reopened.');
      onDone();
      if (status === 'RESOLVED') onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      <DrawerHeader>
        <DrawerTitle>{r.subject}</DrawerTitle>
        <DrawerDescription>
          {r.tenant ?? 'Unknown organization'} · {r.requester} · {categoryLabel(r.category)} · asked {fmtDateTime(r.createdAt)}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4 text-sm">
        <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
        <p className="whitespace-pre-wrap text-ink">{r.body}</p>
        {(r.pageUrl || r.appVersion) && (
          <p className="text-xs text-ink-muted">
            {r.pageUrl ? `On ${r.pageUrl}` : ''}
            {r.pageUrl && r.appVersion ? ' · ' : ''}
            {r.appVersion ? `version ${r.appVersion}` : ''}
          </p>
        )}
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-ink-muted">Answer (shown to the requester)</span>
          <Textarea rows={5} value={reply} onChange={(e) => setReply(e.target.value)} />
        </label>
        {r.resolvedAt && <p className="text-xs text-ink-muted">Resolved {fmtDateTime(r.resolvedAt)}</p>}
      </DrawerBody>
      <DrawerFooter>
        {r.status === 'OPEN' && (
          <Button variant="outline" onClick={() => void move('IN_PROGRESS')} loading={busy === 'IN_PROGRESS'}>
            Working on it
          </Button>
        )}
        {r.status === 'RESOLVED' ? (
          <Button variant="outline" onClick={() => void move('OPEN')} loading={busy === 'OPEN'}>
            Reopen
          </Button>
        ) : (
          <Button onClick={() => void move('RESOLVED')} loading={busy === 'RESOLVED'}>
            Resolve
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
