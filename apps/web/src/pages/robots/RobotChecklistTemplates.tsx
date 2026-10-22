import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ClipboardCheck, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ChecklistItem, ChecklistTemplateInput, RobotChecklistTemplateSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useOrgSites } from '@/lib/useOrgSites';
import { createChecklistTemplate, listAllChecklistTemplates, updateChecklistTemplate } from '@/lib/robotsApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** "Brakes respond" → "brakes-respond": the stable key an answer is recorded under. */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

type Draft = { name: string; locationId: string; items: ChecklistItem[]; active: boolean };

const emptyDraft = (): Draft => ({ name: '', locationId: '', items: [{ key: '', label: '', required: true }], active: true });

/**
 * Brief 3-1 (audit 2026-10-21: the templates had routes and no screen). The
 * pre-shift checklists a crew lead completes before a robot's shift: one for
 * every site, or one per site. Required items must pass for the shift to start.
 */
export function RobotChecklistTemplates() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['robots', 'checklistTemplates', 'all'], queryFn: listAllChecklistTemplates });
  const sites = useOrgSites(true) ?? [];
  const siteName = (id: string | null) => (id ? (sites.find((s) => s.id === id)?.name ?? 'One site') : 'Every site');
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['robots', 'checklistTemplates'] });

  const toggleActive = useMutation({
    mutationFn: (t: RobotChecklistTemplateSummary) => updateChecklistTemplate(t.id, { name: t.name, locationId: t.locationId, items: t.items, active: !t.active }),
    onSuccess: (t) => {
      toast.success(t.active ? `${t.name} is back in use.` : `${t.name} archived. Robots can no longer be checked against it.`);
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not update the template.')),
  });

  const columns = useMemo<GridColumn<RobotChecklistTemplateSummary>[]>(
    () => [
      { key: 'name', header: 'Checklist', accessor: (t) => t.name, primary: true, sortable: true, searchable: true, cell: (t) => <span className="font-medium text-ink">{t.name}</span> },
      { key: 'scope', header: 'Applies to', accessor: (t) => siteName(t.locationId), sortable: true, searchable: true, cardMeta: true },
      { key: 'items', header: 'Items', accessor: (t) => t.items.length, sortable: true, align: 'right', cell: (t) => `${t.items.length} · ${t.items.filter((i) => i.required).length} required` },
      {
        key: 'status',
        header: 'Status',
        accessor: (t) => (t.active ? 'In use' : 'Archived'),
        sortable: true,
        cardMeta: true,
        cell: (t) => <Badge variant={t.active ? 'success' : 'outline'}>{t.active ? 'In use' : 'Archived'}</Badge>,
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: '',
              accessor: (t: RobotChecklistTemplateSummary) => (t.active ? 'archive' : 'restore'),
              align: 'right' as const,
              cell: (t: RobotChecklistTemplateSummary) => (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleActive.mutate(t);
                  }}
                  loading={toggleActive.isPending}
                  aria-label={t.active ? `Archive ${t.name}` : `Restore ${t.name}`}
                >
                  {t.active ? <Archive className="h-3.5 w-3.5" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
                  {t.active ? 'Archive' : 'Restore'}
                </Button>
              ),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sites, canManage],
  );

  const templates = q.data?.templates ?? [];

  return (
    <ListTemplate
      title="Robot checklists"
      subtitle="What a crew lead checks before a robot's shift. Required items must pass, or the shift does not start."
      breadcrumbs={[{ label: 'Operations', to: '/control-room' }, { label: 'Robots', to: '/robots' }, { label: 'Checklists' }]}
      primaryAction={
        canManage ? (
          <Button onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
            <Plus className="h-4 w-4" />
            New checklist
          </Button>
        ) : undefined
      }
      summary={
        q.data ? (
          <p className="text-sm text-ink-muted">
            {templates.filter((t) => t.active).length} in use · {templates.filter((t) => !t.active).length} archived
          </p>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="the checklists" query={q} />
      ) : q.isPending ? (
        <Skeleton className="h-48" />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No checklist yet"
          description={canManage ? 'Write the first one: brakes, sensors, a clear charging dock. A crew lead completes it before every shift.' : 'An administrator writes the checklists.'}
          action={
            canManage ? (
              <Button onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
                <Plus className="h-4 w-4" />
                New checklist
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataGrid
          id="robot-checklists"
          caption="Robot checklists"
          rows={templates}
          rowKey={(t) => t.id}
          columns={columns}
          onRowClick={canManage ? (t) => setEditing({ id: t.id, draft: { name: t.name, locationId: t.locationId ?? '', items: t.items, active: t.active } }) : undefined}
          rowActionLabel={(t) => `Edit ${t.name}`}
        />
      )}
      <p className="mt-4 text-xs2 text-ink-muted">
        A crew lead records the checklist on the robot's record, under Checklists. <Link to="/robots" className="underline decoration-line underline-offset-2 hover:text-accent">Back to the fleet</Link>.
      </p>
      {editing && (
        <TemplateDialog
          id={editing.id}
          initial={editing.draft}
          sites={sites}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      )}
    </ListTemplate>
  );
}

function TemplateDialog({ id, initial, sites, onClose, onSaved }: { id: string | null; initial: Draft; sites: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial);
  const items = draft.items;
  const setItem = (i: number, patch: Partial<ChecklistItem>) => setDraft((d) => ({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const valid = draft.name.trim().length > 0 && items.length > 0 && items.every((i) => i.label.trim().length > 0);
  const payload = (): ChecklistTemplateInput => ({
    name: draft.name.trim(),
    locationId: draft.locationId || null,
    active: draft.active,
    items: items.map((i, n) => ({ key: i.key.trim() || keyFromLabel(i.label) || `item-${n + 1}`, label: i.label.trim(), required: i.required })),
  });
  const save = useMutation({
    mutationFn: () => (id ? updateChecklistTemplate(id, payload()) : createChecklistTemplate(payload())),
    onSuccess: (t) => {
      toast.success(id ? `${t.name} saved.` : `${t.name} created.`);
      onSaved();
    },
    onError: (e) => toast.error(err(e, 'Could not save the checklist.')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{id ? 'Edit checklist' : 'New checklist'}</DialogTitle>
          <DialogDescription>Required items must pass before a robot's shift starts. Optional items are recorded and never block.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              {(fp) => <Input {...fp} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Pre-shift: Servi" autoFocus />}
            </Field>
            <Field label="Applies to">
              {(fp) => (
                <Select {...fp} value={draft.locationId} onChange={(e) => setDraft((d) => ({ ...d, locationId: e.target.value }))}>
                  <option value="">Every site</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Items</legend>
            <ul className="space-y-2">
              {items.map((it, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <Input className="min-w-[14rem] flex-1" value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} placeholder={i === 0 ? 'Brakes respond' : 'Next item'} aria-label={`Item ${i + 1}`} />
                  <label className="flex items-center gap-2 text-sm text-ink-muted">
                    <input type="checkbox" className="h-5 w-5 accent-gold" checked={it.required} onChange={(e) => setItem(i, { required: e.target.checked })} />
                    Required
                  </label>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setDraft((d) => ({ ...d, items: d.items.filter((_, j) => j !== i) }))} disabled={items.length === 1} aria-label={`Remove item ${i + 1}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <Button type="button" size="sm" variant="outline" onClick={() => setDraft((d) => ({ ...d, items: [...d.items, { key: '', label: '', required: true }] }))} disabled={items.length >= 40}>
              <Plus className="h-3.5 w-3.5" />
              Add item
            </Button>
          </fieldset>
          {id && (
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input type="checkbox" className="h-5 w-5 accent-gold" checked={draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
              In use (uncheck to archive)
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid} loading={save.isPending}>
              {id ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
