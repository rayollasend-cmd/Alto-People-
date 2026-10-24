import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyPlus, Mail, MoreHorizontal, Pencil, Send, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { fmtDateTime } from '@/lib/format';
import { StatusBadge } from '@/lib/status';
import { useUrlParam } from '@/lib/useUrlState';
import {
  deleteBroadcast,
  deliveryLines,
  duplicateBroadcast,
  listBroadcasts,
  listBroadcastTemplates,
  type Broadcast,
} from '@/lib/dirCommsApi';
import { BroadcastDrawer, channelPhrase, useSendBroadcast } from '@/pages/dirComms/BroadcastDrawer';
import {
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorBanner,
  SectionTitle,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';

export const BROADCASTS_KEY = ['dirComms', 'broadcasts'] as const;
export const BROADCAST_TEMPLATES_KEY = ['dirComms', 'broadcast-templates'] as const;

/** Drafts and scheduled broadcasts: what still needs someone before it goes out. */
export function waitingBroadcasts(rows: Broadcast[] | null | undefined): Broadcast[] {
  return (rows ?? []).filter((b) => b.status === 'DRAFT' || b.status === 'SCHEDULED');
}

/**
 * Notifications › Sends & broadcasts › Broadcasts: every announcement —
 * drafts (Marketing's included, waiting for review), scheduled ones, and
 * the sent ones with how delivery went — plus the saved templates. It
 * used to be a tab of "Directory & comms", a second home for the same
 * broadcasts the Send page composes. `?broadcast=<id>` (the "announcement
 * to review" notification) opens that draft.
 */
export function BroadcastsPanel() {
  const confirm = useConfirm();
  const send = useSendBroadcast();
  const qc = useQueryClient();
  const [linked, setLinked] = useUrlParam('broadcast', '');
  const [editing, setEditing] = useState<Broadcast | null>(null);

  const broadcastsQuery = useQuery({ queryKey: BROADCASTS_KEY, queryFn: () => listBroadcasts() });
  const templatesQuery = useQuery({ queryKey: BROADCAST_TEMPLATES_KEY, queryFn: () => listBroadcastTemplates() });
  const rows: Broadcast[] | null = broadcastsQuery.data?.broadcasts ?? null;
  const error = broadcastsQuery.error ? (broadcastsQuery.error instanceof ApiError ? broadcastsQuery.error.message : 'Could not load broadcasts.') : null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: BROADCASTS_KEY });
    void qc.invalidateQueries({ queryKey: BROADCAST_TEMPLATES_KEY });
    void qc.invalidateQueries({ queryKey: ['AdminCommsView'] });
  };

  // ?broadcast=<id> opens that draft once, then leaves the URL.
  useEffect(() => {
    if (!linked || !rows) return;
    const b = rows.find((x) => x.id === linked);
    if (b && b.status !== 'SENT') setEditing(b);
    setLinked('');
  }, [linked, rows, setLinked]);

  const onDuplicate = async (b: Broadcast) => {
    try {
      await duplicateBroadcast(b.id);
      toast.success(`“${b.title}” copied to a new draft.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not duplicate it.');
    }
  };
  const onDelete = async (b: Broadcast, what: 'draft' | 'template') => {
    if (!(await confirm({ title: `Delete the ${what} “${b.templateName ?? b.title}”?`, destructive: true, confirmLabel: 'Delete' }))) return;
    try {
      await deleteBroadcast(b.id);
      toast.success(what === 'template' ? 'Template deleted.' : 'Draft deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete it.');
    }
  };
  const templates = templatesQuery.data?.broadcasts ?? [];

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void broadcastsQuery.refetch()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : (
        <DataGrid<Broadcast>
          id="broadcasts"
          caption="Broadcasts"
          noun={{ one: 'broadcast', many: 'broadcasts' }}
          rows={rows}
          loading={rows === null}
          rowKey={(b) => b.id}
          search={{ placeholder: 'Title…' }}
          urlKey="bc"
          exportCsv={{ filename: 'broadcasts' }}
          onRowClick={(b) => (b.status === 'DRAFT' ? setEditing(b) : undefined)}
          rowActionLabel={(b) => (b.status === 'DRAFT' ? `Edit the draft “${b.title}”` : b.title)}
          empty={{
            icon: Mail,
            title: 'No broadcasts yet',
            description: 'An announcement to everyone, a department or a single client. Start one with New broadcast.',
          }}
          columns={[
            {
              key: 'title',
              header: 'Title',
              accessor: (b) => b.title,
              sortable: true,
              primary: true,
              cell: (b) => (
                <span className="min-w-0">
                  <span className="font-medium text-ink">{b.title}</span>
                  {b.status !== 'SENT' && b.createdByRole === 'MARKETING_MANAGER' && (
                    <span className="block text-2xs text-ink-muted">Drafted by Marketing — review and send</span>
                  )}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              accessor: (b) => b.status,
              sortable: true,
              cardMeta: true,
              cell: (b) => (
                <>
                  <StatusBadge status={b.status} />
                  {b.status === 'SCHEDULED' && b.scheduledFor && <div className="mt-0.5 text-2xs text-ink-muted">{fmtDateTime(b.scheduledFor)}</div>}
                </>
              ),
            },
            {
              key: 'channels',
              header: 'Channels',
              accessor: (b) => channelPhrase(b.channels),
              sortable: true,
              cell: (b) => (
                <span className="block min-w-0">
                  <span>{channelPhrase(b.channels)}</span>
                  {b.status === 'SENT' &&
                    deliveryLines(b.delivery).map((l) => (
                      <span key={l.channel} className={cn('block text-2xs', l.problem ? 'text-warning' : 'text-ink-muted')}>
                        {l.text}
                      </span>
                    ))}
                </span>
              ),
            },
            { key: 'recipients', header: 'Recipients', accessor: (b) => b.receiptCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
            { key: 'sent', header: 'Sent', accessor: (b) => b.sentAt, sortable: true, searchable: false, cardMeta: true, cell: (b) => (b.sentAt ? fmtDateTime(b.sentAt) : '—') },
            {
              key: 'actions',
              header: '',
              accessor: () => null,
              searchable: false,
              csv: () => '',
              align: 'right',
              stopRowClick: true,
              width: '9rem',
              cell: (b) => (
                <span className="inline-flex items-center gap-1">
                  {b.status !== 'SENT' && b.status !== 'CANCELLED' && (
                    <Button size="xs" onClick={() => void send(b).then((ok) => ok && refresh())}>
                      <Send className="h-3 w-3" /> Send…
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="xs" variant="ghost" aria-label={`More for ${b.title}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {b.status === 'DRAFT' && (
                        <DropdownMenuItem onSelect={() => setEditing(b)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => void onDuplicate(b)}>
                        <CopyPlus className="mr-2 h-3.5 w-3.5" /> Duplicate
                      </DropdownMenuItem>
                      {b.status === 'DRAFT' && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-alert" onSelect={() => void onDelete(b, 'draft')}>
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete draft
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              ),
            },
          ]}
        />
      )}
      {templates.length > 0 && (
        <Card>
          <CardContent className="space-y-2">
            <SectionTitle as="h3" size="sm" title="Templates" description="Saved wording to start a broadcast from." />
            <ul className="divide-y divide-line">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{t.templateName}</span>
                    <span className="block truncate text-xs text-ink-muted">{t.title}</span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void onDuplicate(t)}>
                    Use
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void onDelete(t, 'template')} aria-label={`Delete template ${t.templateName}`}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {editing && (
        <BroadcastDrawer
          broadcast={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
