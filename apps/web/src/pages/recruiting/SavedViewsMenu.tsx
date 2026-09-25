import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bookmark, Check, ChevronDown, Users } from 'lucide-react';
import type { SavedView, SavedViewScope } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView } from '@/lib/savedViewsApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

/**
 * Saved views for a list: pick one, save the filters on screen as a new
 * one, update or rename your own, share it with the team, or delete it.
 *
 * A view is the list's own URL params, so applying one is the same as
 * following a link — `active` is the id the page keeps in its URL, and
 * the menu says when the filters on screen have drifted from it.
 */

type Query = Record<string, string>;

function sameQuery(a: Query, b: Query): boolean {
  const ka = Object.keys(a).filter((k) => a[k]);
  const kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

export function SavedViewsMenu({
  scope,
  current,
  activeId,
  onApply,
  allLabel,
}: {
  scope: SavedViewScope;
  /** The filters on screen, as the list keeps them in its URL. */
  current: Query;
  activeId: string | null;
  /** Apply a view's query (null id = the default, unfiltered list). */
  onApply: (id: string | null, query: Query) => void;
  allLabel: string;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['saved-views', scope], queryFn: () => listSavedViews(scope), staleTime: 60_000 });
  const views = q.data?.views ?? [];
  const active = views.find((v) => v.id === activeId) ?? null;
  const drifted = active ? !sameQuery(active.query, current) : false;
  const mine = views.filter((v) => v.mine);
  const team = views.filter((v) => !v.mine);

  // The name dialog: saving a new view, or renaming one.
  const [naming, setNaming] = useState<{ mode: 'new' } | { mode: 'rename'; view: SavedView } | null>(null);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!naming) return;
    setName(naming.mode === 'rename' ? naming.view.name : '');
    setShare(naming.mode === 'rename' ? naming.view.shared : false);
  }, [naming]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['saved-views', scope] });
  const fail = (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback);

  const saveName = async () => {
    if (!naming || !name.trim()) return;
    setBusy(true);
    try {
      if (naming.mode === 'new') {
        const v = await createSavedView({ scope, name: name.trim(), query: current, shared: share });
        onApply(v.id, v.query);
        toast.success(`Saved “${v.name}”${share ? ' and shared with the team' : ''}.`);
      } else {
        await updateSavedView(naming.view.id, { name: name.trim(), shared: share });
        toast.success('View updated.');
      }
      setNaming(null);
      refresh();
    } catch (err) {
      fail(err, 'Could not save the view.');
    } finally {
      setBusy(false);
    }
  };

  const updateFilters = async (v: SavedView) => {
    try {
      await updateSavedView(v.id, { query: current });
      toast.success(`“${v.name}” now shows these filters.`);
      refresh();
    } catch (err) {
      fail(err, 'Could not update the view.');
    }
  };

  const toggleShare = async (v: SavedView) => {
    try {
      await updateSavedView(v.id, { shared: !v.shared });
      toast.success(v.shared ? `“${v.name}” is private again.` : `“${v.name}” is shared with the team.`);
      refresh();
    } catch (err) {
      fail(err, 'Could not change sharing.');
    }
  };

  const remove = async (v: SavedView) => {
    if (!(await confirm({ title: `Delete “${v.name}”?`, description: v.shared ? 'It disappears for the team too.' : undefined, destructive: true, confirmLabel: 'Delete view' }))) return;
    try {
      await deleteSavedView(v.id);
      if (v.id === activeId) onApply(null, {});
      refresh();
    } catch (err) {
      fail(err, 'Could not delete the view.');
    }
  };

  const item = (v: SavedView) => (
    <DropdownMenuItem key={v.id} onSelect={() => onApply(v.id, v.query)} className="flex items-center gap-2">
      <Check className={v.id === activeId ? 'h-3.5 w-3.5' : 'invisible h-3.5 w-3.5'} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{v.name}</span>
      {v.shared && v.mine && <Users className="h-3 w-3 text-silver" aria-label="Shared" />}
      {!v.mine && <span className="truncate text-2xs text-silver">{v.ownerName}</span>}
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" aria-label={`Saved views: ${active ? active.name : allLabel}${drifted ? ' (changed)' : ''}`}>
            <Bookmark className="h-3.5 w-3.5" />
            <span className="max-w-[10rem] truncate">{active ? active.name : allLabel}</span>
            {drifted && <span className="text-2xs text-warning">· changed</span>}
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem onSelect={() => onApply(null, {})} className="flex items-center gap-2">
            <Check className={!activeId ? 'h-3.5 w-3.5' : 'invisible h-3.5 w-3.5'} aria-hidden="true" />
            {allLabel}
          </DropdownMenuItem>
          {mine.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>My views</DropdownMenuLabel>
              {mine.map(item)}
            </>
          )}
          {team.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Shared by the team</DropdownMenuLabel>
              {team.map(item)}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNaming({ mode: 'new' })}>Save these filters as a view…</DropdownMenuItem>
          {active?.mine && (
            <>
              {drifted && <DropdownMenuItem onSelect={() => void updateFilters(active)}>Update “{active.name}” to these filters</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setNaming({ mode: 'rename', view: active })}>Rename or share…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void toggleShare(active)}>
                {active.shared ? 'Stop sharing with the team' : 'Share with the team'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void remove(active)} className="text-alert focus:text-alert">
                Delete “{active.name}”
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={naming !== null} onOpenChange={(o) => !o && !busy && setNaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{naming?.mode === 'rename' ? 'Rename or share this view' : 'Save these filters as a view'}</DialogTitle>
            <DialogDescription>
              {naming?.mode === 'rename'
                ? 'A shared view shows in everyone’s list; only you can change it.'
                : 'It keeps the search, filters, sort and layout on screen now.'}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
            className="space-y-3"
          >
            <Field label="Name" required>
              {(p) => (
                <Input {...p} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stuck in screening" autoFocus />
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm text-silver">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="h-4 w-4 accent-gold" />
              Share with the team
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setNaming(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={busy || !name.trim()}>
                Save view
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
