import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Building2, ChevronDown, ChevronRight, Target, Users } from 'lucide-react';
import type { Goal, GoalStatus } from '@/lib/perf84Api';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * Goals as the cascade they are: company goals at the top, the team goals
 * aligned to them, and people's goals under those. A real tree — arrow
 * keys move, right opens, left closes — so it reads with a keyboard or a
 * screen reader, not just a mouse.
 */

const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  AT_RISK: 'At risk',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const SCOPE_ICON = { COMPANY: Building2, TEAM: Users, PERSON: Target } as const;
const SCOPE_LABEL = { COMPANY: 'Company', TEAM: 'Team', PERSON: 'Person' } as const;

type Scope = keyof typeof SCOPE_LABEL;
const scopeOf = (g: Goal): Scope => (g.scope === 'COMPANY' || g.scope === 'TEAM' ? g.scope : 'PERSON');

export function GoalCascade({ goals, onOpen }: { goals: Goal[]; onOpen: (g: Goal) => void }) {
  const { children, roots } = useMemo(() => {
    const ids = new Set(goals.map((g) => g.id));
    const children = new Map<string, Goal[]>();
    const roots: Goal[] = [];
    const order = (a: Goal, b: Goal) => ['COMPANY', 'TEAM', 'PERSON'].indexOf(scopeOf(a)) - ['COMPANY', 'TEAM', 'PERSON'].indexOf(scopeOf(b)) || a.title.localeCompare(b.title);
    for (const g of goals) {
      if (g.parentGoalId && ids.has(g.parentGoalId)) {
        const list = children.get(g.parentGoalId) ?? [];
        list.push(g);
        children.set(g.parentGoalId, list);
      } else roots.push(g);
    }
    for (const list of children.values()) list.sort(order);
    roots.sort(order);
    return { children, roots };
  }, [goals]);

  // Company and team goals start open; people's goals are the leaves.
  const [open, setOpen] = useState<Set<string>>(() => new Set(goals.filter((g) => scopeOf(g) !== 'PERSON').map((g) => g.id)));
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const visible = useMemo(() => {
    const out: Array<{ g: Goal; depth: number }> = [];
    const walk = (list: Goal[], depth: number) => {
      for (const g of list) {
        out.push({ g, depth });
        if (open.has(g.id)) walk(children.get(g.id) ?? [], depth + 1);
      }
    };
    walk(roots, 0);
    return out;
  }, [roots, children, open]);
  const current = active && visible.some((r) => r.g.id === active) ? active : (visible[0]?.g.id ?? null);

  const focus = (id: string | null | undefined) => {
    if (!id) return;
    setActive(id);
    (listRef.current?.querySelector(`[data-goal="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  };
  const toggle = (id: string, to?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKey = (e: KeyboardEvent<HTMLLIElement>, g: Goal) => {
    const i = visible.findIndex((r) => r.g.id === g.id);
    const kids = children.get(g.id) ?? [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focus(visible[i + 1]?.g.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focus(visible[i - 1]?.g.id);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (kids.length && !open.has(g.id)) toggle(g.id, true);
      else focus(kids[0]?.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (kids.length && open.has(g.id)) toggle(g.id, false);
      else focus(g.parentGoalId);
    } else if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(g);
    }
  };

  return (
    <ul ref={listRef} role="tree" aria-label="Goal cascade" className="space-y-0.5 p-2">
      {visible.map(({ g, depth }) => {
        const kids = children.get(g.id) ?? [];
        const scope = scopeOf(g);
        const Icon = SCOPE_ICON[scope];
        const pct = g.keyResults.length ? Math.round(g.keyResults.reduce((n, k) => n + k.progressPct, 0) / g.keyResults.length) : g.progressPct;
        return (
          <li
            key={g.id}
            data-goal={g.id}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={kids.length ? open.has(g.id) : undefined}
            aria-selected={current === g.id}
            tabIndex={current === g.id ? 0 : -1}
            onKeyDown={(e) => onKey(e, g)}
            onFocus={(e) => e.target === e.currentTarget && setActive(g.id)}
            className="flex items-center gap-2 rounded-md py-1.5 pr-2 outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-12"
            style={{ paddingLeft: `${0.25 + Math.min(depth, 8) * 1.25}rem` }}
          >
            {kids.length ? (
              <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => toggle(g.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink-muted hover:text-ink coarse:h-10 coarse:w-10">
                {open.has(g.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            ) : (
              <span className="h-6 w-6 shrink-0 coarse:w-10" aria-hidden="true" />
            )}
            <Icon className={cn('h-4 w-4 shrink-0', scope === 'COMPANY' ? 'text-accent' : 'text-ink-muted')} aria-hidden="true" />
            <button type="button" tabIndex={-1} onClick={() => onOpen(g)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm text-ink hover:underline">{g.title}</span>
              <span className="block truncate text-xs text-ink-muted">
                {SCOPE_LABEL[scope]}
                {scope === 'PERSON' && g.associateName ? ` · ${g.associateName}` : ''}
                {scope === 'TEAM' && g.ownerName ? ` · ${g.ownerName}` : ''}
                {kids.length ? ` · ${kids.length} aligned` : ''}
              </span>
            </button>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={`${g.title} progress`}
              className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-raised sm:block"
            >
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">{pct}%</span>
            <Badge size="sm" variant={g.status === 'AT_RISK' ? 'destructive' : g.status === 'COMPLETED' ? 'success' : g.status === 'ACTIVE' ? 'info' : 'outline'}>
              {GOAL_STATUS_LABELS[g.status]}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
