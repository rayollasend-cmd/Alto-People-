import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Download, FolderTree } from 'lucide-react';
import type { Department } from '@alto-people/shared';
import { useTerm } from '@/lib/auth';
import { downloadCsv } from '@/lib/csv';
import { ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button, SearchInput } from '@/components/ui';

/**
 * Departments as the tree they are (parentId), not a flat grid with a
 * "Parent" column. One pass builds the children map, so a large list stays
 * cheap. Search keeps every match and the path down to it, opened. It is a
 * real tree for assistive tech: arrows move, right opens, left closes,
 * Enter opens the department.
 */
export function DepartmentTree({ rows, onOpen }: { rows: Department[]; onOpen: (d: Department) => void }) {
  const term = useTerm();
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { children, byId } = useMemo(() => {
    const byId = new Map(rows.map((d) => [d.id, d]));
    const children = new Map<string | null, Department[]>();
    for (const d of rows) {
      const parent = d.parentId && byId.has(d.parentId) ? d.parentId : null;
      const list = children.get(parent) ?? [];
      list.push(d);
      children.set(parent, list);
    }
    for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return { children, byId };
  }, [rows]);

  // A search keeps the matches and their ancestors, all opened.
  const keep = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    const out = new Set<string>();
    for (const d of rows) {
      if (!`${d.name} ${d.code ?? ''}`.toLowerCase().includes(needle)) continue;
      let cursor: Department | undefined = d;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        out.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }
    return out;
  }, [q, rows, byId]);

  const visible = useMemo(() => {
    const out: Array<{ d: Department; depth: number; kids: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const d of children.get(parent) ?? []) {
        if (keep && !keep.has(d.id)) continue;
        const kids = (children.get(d.id) ?? []).filter((k) => !keep || keep.has(k.id)).length;
        out.push({ d, depth, kids });
        if (kids && (keep || !closed.has(d.id))) walk(d.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [children, closed, keep]);

  const current = active && visible.some((r) => r.d.id === active) ? active : (visible[0]?.d.id ?? null);
  const focusRow = (id: string | null | undefined) => {
    if (!id) return;
    setActive(id);
    (listRef.current?.querySelector(`[data-dept="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  };
  const toggle = (id: string, open?: boolean) =>
    setClosed((prev) => {
      const next = new Set(prev);
      const isOpen = !next.has(id);
      if (open ?? !isOpen) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKey = (e: KeyboardEvent<HTMLLIElement>, row: { d: Department; kids: number }) => {
    const i = visible.findIndex((r) => r.d.id === row.d.id);
    const open = row.kids > 0 && (!!keep || !closed.has(row.d.id));
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(visible[i + 1]?.d.id);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(visible[i - 1]?.d.id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.kids && !open) toggle(row.d.id, true);
        else if (row.kids) focusRow(visible[i + 1]?.d.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (open) toggle(row.d.id, false);
        else focusRow(row.d.parentId);
        break;
      case 'Enter':
        e.preventDefault();
        onOpen(row.d);
        break;
    }
  };

  const exportCsv = () =>
    downloadCsv(`departments-${ymdLocal()}.csv`, [
      ['Name', 'Code', 'Parent', term('workers')],
      ...rows.map((d) => [d.name, d.code ?? '', d.parentId ? (byId.get(d.parentId)?.name ?? '') : '', String(d.associateCount)]),
    ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56 sm:max-w-xs">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code…" aria-label="Search departments" />
        </div>
        {!keep && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setClosed(new Set())}>
              Open all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setClosed(new Set(rows.filter((d) => (children.get(d.id) ?? []).length).map((d) => d.id)))}>
              Close all
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          CSV
        </Button>
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-ink-muted" role="status">
          No department matches “{q.trim()}”.
        </p>
      ) : (
        <ul ref={listRef} role="tree" aria-label="Departments" className="space-y-0.5 rounded-lg border border-line p-1.5">
          {visible.map((row) => {
            const open = row.kids > 0 && (!!keep || !closed.has(row.d.id));
            return (
              <li
                key={row.d.id}
                data-dept={row.d.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.kids ? open : undefined}
                aria-selected={current === row.d.id}
                tabIndex={current === row.d.id ? 0 : -1}
                onFocus={(e) => e.target === e.currentTarget && setActive(row.d.id)}
                onKeyDown={(e) => onKey(e, row)}
                className="flex items-center gap-2 rounded-md py-1.5 pr-2 outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-12"
                style={{ paddingLeft: `${0.25 + Math.min(row.depth, 8) * 1.25}rem` }}
              >
                {row.kids ? (
                  <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => toggle(row.d.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10">
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : (
                  <span className="h-6 w-6 shrink-0 coarse:w-10" aria-hidden="true" />
                )}
                <FolderTree className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                <button type="button" tabIndex={-1} onClick={() => onOpen(row.d)} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink hover:underline">
                  {row.d.name}
                  {row.d.code && <span className="ml-2 font-normal text-ink-muted">{row.d.code}</span>}
                </button>
                <span className={cn('shrink-0 text-xs tabular-nums', row.d.associateCount ? 'text-ink-muted' : 'text-ink-subtle')}>
                  {row.d.associateCount} {row.d.associateCount === 1 ? term('worker').toLowerCase() : term('workers').toLowerCase()}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
