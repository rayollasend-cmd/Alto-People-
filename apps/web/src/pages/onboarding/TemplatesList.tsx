import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, LayoutTemplate, MoreHorizontal, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import type {
  ClientSummary,
  OnboardingTemplate,
} from '@alto-people/shared';
import {
  deleteTemplate,
  listClients,
  listTemplates,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataGrid } from '@/components/ui/DataGrid';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { QueryError } from '@/components/ui/QueryError';
import { ListTemplate } from '@/components/templates';
import { OnboardingSections } from './OnboardingSections';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

const TRACK_VARIANT: Record<string, 'default' | 'accent' | 'pending'> = {
  STANDARD: 'default',
  J1: 'accent',
  CLIENT_SPECIFIC: 'pending',
};

/**
 * The onboarding checklists HR picks from (F500 G1): one table — name,
 * track, client, tasks, how many applications are on it now, when it was
 * last edited — with Edit, Duplicate and Delete in each row's menu (Delete
 * behind its confirm). It was a grid of half-width cards with a red trash
 * can on each, which left half the page empty and didn't scale.
 */
export function TemplatesList() {
  const { can } = useAuth();
  const canManage = can('manage:onboarding');
  const navigate = useNavigate();

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OnboardingTemplate | null>(null);

  const listQuery = useQuery({
    queryKey: ['TemplatesList', 'all'],
    queryFn: () => Promise.all([listTemplates(), listClients()]),
  });
  const templates: OnboardingTemplate[] | null = listQuery.data?.[0].templates ?? null;
  const clients: ClientSummary[] | null = listQuery.data?.[1].clients ?? null;
  const refresh = async () => {
    await listQuery.refetch();
  };

  const clientName = useMemo(() => {
    const m = new Map<string, string>();
    if (clients) for (const c of clients) m.set(c.id, c.name);
    return (id: string | null): string => (id ? (m.get(id) ?? 'Unknown client') : 'Every client');
  }, [clients]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    try {
      await deleteTemplate(deleteTarget.id);
      toast.success(`Deleted "${deleteTarget.name}".`);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'template_in_use') {
        toast.error('Template is in use.', { description: err.message });
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
      }
    } finally {
      setDeletingId(null);
    }
  };

  if (!canManage) {
    return (
      <div className="mx-auto">
        <ErrorBanner>
          You don't have permission to manage onboarding templates.
        </ErrorBanner>
      </div>
    );
  }

  return (
    <ListTemplate
      // The trail is the way back (the same one /new and /:id use).
      breadcrumbs={[{ label: 'Onboarding', to: '/onboarding' }, { label: 'Templates' }]}
      title="Onboarding templates"
      subtitle="The checklists HR picks from when inviting an associate."
      actions={[{ key: 'new', label: 'New template', icon: Plus, primary: true, to: '/onboarding/templates/new' }]}
      summary={<OnboardingSections />}
    >
      {listQuery.isError && <QueryError what="the templates" query={listQuery} />}

      {!listQuery.isError && (
        <Card className="p-3">
          <DataGrid<OnboardingTemplate>
            id="onboarding-templates"
            caption="Onboarding templates"
            noun={{ one: 'template', many: 'templates' }}
            rows={templates}
            loading={listQuery.isPending}
            rowKey={(t) => t.id}
            search={false}
            urlState={false}
            exportCsv={false}
            onRowClick={(t) => navigate(`/onboarding/templates/${t.id}`)}
            rowActionLabel={(t) => `Edit ${t.name}`}
            empty={{
              icon: LayoutTemplate,
              title: 'No templates yet',
              description: 'A template is the checklist an invite starts from. Create the first one.',
              action: (
                <Button asChild>
                  <Link to="/onboarding/templates/new">
                    <Plus className="h-4 w-4" />
                    New template
                  </Link>
                </Button>
              ),
            }}
            columns={[
              {
                key: 'name',
                header: 'Name',
                primary: true,
                sortable: true,
                accessor: (t) => t.name,
                cell: (t) => (
                  <div className="min-w-0">
                    <div className="font-medium text-white">{t.name}</div>
                    <div className="mt-0.5 text-xs text-silver">
                      {t.tasks
                        .slice(0, 3)
                        .map((tk) => tk.title)
                        .join(' · ')}
                      {t.tasks.length > 3 && ` + ${t.tasks.length - 3} more`}
                    </div>
                  </div>
                ),
              },
              {
                key: 'track',
                header: 'Track',
                sortable: true,
                cardMeta: true,
                accessor: (t) => TRACK_LABEL[t.track] ?? t.track,
                cell: (t) => <Badge variant={TRACK_VARIANT[t.track] ?? 'default'}>{TRACK_LABEL[t.track] ?? t.track}</Badge>,
              },
              {
                key: 'client',
                header: 'Client',
                sortable: true,
                cardMeta: true,
                accessor: (t) => clientName(t.clientId),
                className: 'text-silver',
              },
              {
                key: 'tasks',
                header: 'Tasks',
                align: 'right',
                sortable: true,
                searchable: false,
                accessor: (t) => t.tasks.length,
                className: 'tabular-nums',
              },
              {
                key: 'inUse',
                header: 'In use',
                align: 'right',
                sortable: true,
                searchable: false,
                // Applications in flight on this template's client and track.
                accessor: (t) => t.inUse ?? null,
                csv: (t) => t.inUse ?? '',
                cell: (t) =>
                  t.inUse === undefined ? (
                    <span className="text-silver/50">—</span>
                  ) : t.inUse === 0 ? (
                    <span className="text-silver">None</span>
                  ) : (
                    <span className="tabular-nums text-white" title="Applications in flight on this client and track">
                      {t.inUse} in flight
                    </span>
                  ),
              },
              {
                key: 'updatedAt',
                header: 'Last edited',
                sortable: true,
                searchable: false,
                accessor: (t) => t.updatedAt ?? null,
                csv: (t) => (t.updatedAt ? t.updatedAt.slice(0, 10) : ''),
                className: 'text-xs text-silver whitespace-nowrap',
                cell: (t) => (t.updatedAt ? fmtDate(t.updatedAt) : '—'),
              },
              {
                key: 'menu',
                header: '',
                align: 'right',
                stopRowClick: true,
                searchable: false,
                accessor: () => null,
                csv: () => '',
                className: 'w-12',
                cell: (t) => (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label={`Actions for ${t.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link to={`/onboarding/templates/${t.id}`}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          Edit
                        </Link>
                      </DropdownMenuItem>
                      {/* Opens the editor in "new" mode prefilled from this
                          template — nothing is created until Save. */}
                      <DropdownMenuItem asChild>
                        <Link to={`/onboarding/templates/new?from=${t.id}`}>
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          Duplicate
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        disabled={deletingId === t.id}
                        onSelect={() => window.setTimeout(() => setDeleteTarget(t), 0)}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ),
              },
            ]}
          />
        </Card>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={
          deleteTarget ? `Delete template "${deleteTarget.name}"?` : 'Delete template'
        }
        description="Any in-flight applications using this track will keep their existing checklist — only future applications are affected."
        confirmLabel="Delete template"
        destructive
        busy={deletingId !== null}
        onConfirm={confirmDelete}
      />
    </ListTemplate>
  );
}
