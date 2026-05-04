import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LayoutTemplate, Plus, Settings2 } from 'lucide-react';
import type { ShiftTemplate } from '@alto-people/shared';
import { listShiftTemplates } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { colorForPosition } from '@/lib/positionColor';

/**
 * Sling-style draggable templates rail.
 *
 * Sits on the right side of the schedule page; collapsible to a thin
 * vertical strip when not needed. Each template is a chip you can drag
 * onto any calendar cell — the parent's drop handler reads the template
 * id from `dataTransfer` and POSTs to the apply-template endpoint.
 *
 * Why HTML5 native drag (not dnd-kit): the calendar already has dnd-kit
 * contexts for shift moves. Rather than lift those up to share with the
 * rail (a sizable refactor), we use the platform's drag API for this
 * cross-component flow. Cells expose `onDragOver`/`onDrop` alongside
 * their existing dnd-kit `setNodeRef`; the two systems coexist cleanly.
 *
 * The transfer mime type is hardcoded — `application/x-alto-template-id` —
 * so a stray drag from another app never accidentally triggers a template
 * apply.
 */

export const TEMPLATE_MIME = 'application/x-alto-template-id';

interface Props {
  /** Filter templates to a single client (optional). null = global + all. */
  clientId: string | null;
  /** Open the templates management dialog (create/edit/delete). */
  onManage: () => void;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const period = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

export function TemplatesRail({ clientId, onManage }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('alto:scheduling.templatesRail') === 'collapsed';
  });
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'alto:scheduling.templatesRail',
      collapsed ? 'collapsed' : 'open',
    );
  }, [collapsed]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listShiftTemplates(
          clientId ? { clientId } : {},
        );
        if (!cancelled) setTemplates(res.templates);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load templates.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed right-0 top-1/3 z-30 px-1.5 py-3 rounded-l-md border-y border-l border-navy-secondary bg-navy hover:bg-navy-secondary/80 text-silver hover:text-gold no-print"
        title="Show templates"
      >
        <div className="flex flex-col items-center gap-1.5">
          <ChevronLeft className="h-3.5 w-3.5" />
          <LayoutTemplate className="h-4 w-4" />
        </div>
      </button>
    );
  }

  return (
    <aside
      className="fixed right-0 top-20 bottom-4 w-64 z-30 rounded-l-md border border-r-0 border-navy-secondary bg-navy/95 backdrop-blur shadow-xl flex flex-col no-print"
      aria-label="Templates"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-navy-secondary">
        <LayoutTemplate className="h-4 w-4 text-gold" />
        <div className="text-sm font-medium text-white flex-1">Templates</div>
        <button
          type="button"
          onClick={onManage}
          className="text-silver/70 hover:text-gold p-1"
          title="Manage templates"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-silver/70 hover:text-gold p-1"
          title="Collapse"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {error && (
          <div className="text-xs text-alert px-2 py-1">{error}</div>
        )}
        {!templates && !error && (
          <div className="space-y-1.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 rounded bg-navy-secondary/30 animate-pulse" />
            ))}
          </div>
        )}
        {templates && templates.length === 0 && (
          <div className="text-center px-3 py-6 text-xs text-silver/60">
            No templates yet.
            <button
              type="button"
              onClick={onManage}
              className="block mx-auto mt-2 text-gold hover:text-gold-bright underline underline-offset-2"
            >
              Create one
            </button>
          </div>
        )}
        {templates?.map((t) => (
          <TemplateChip key={t.id} template={t} />
        ))}
      </div>

      <div className="px-2 py-2 border-t border-navy-secondary">
        <Button onClick={onManage} variant="ghost" className="w-full justify-center">
          <Plus className="h-3.5 w-3.5" />
          New template
        </Button>
        <div className="mt-1.5 text-[10px] text-silver/50 text-center">
          Drag a template onto a cell to apply.
        </div>
      </div>
    </aside>
  );
}

function TemplateChip({ template }: { template: ShiftTemplate }) {
  const color = colorForPosition(template.position);
  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(TEMPLATE_MIME, template.id);
    e.dataTransfer.effectAllowed = 'copy';
    // Plain text fallback for browsers that ignore custom mimes during
    // drag image rendering (Safari historically); we still gate the drop
    // on the custom mime, but the OS shows the right preview.
    e.dataTransfer.setData('text/plain', template.name);
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={cn(
        'relative rounded border bg-navy/70 hover:brightness-125 transition cursor-grab active:cursor-grabbing',
        'p-2 pl-3',
      )}
      style={{
        backgroundColor: color.bg,
        borderColor: color.border,
      }}
    >
      <div
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l"
        style={{ backgroundColor: color.accent }}
      />
      <div className="text-xs text-white font-medium truncate">{template.name}</div>
      <div className="text-[10px] text-silver/80 tabular-nums truncate">
        {DAYS[template.dayOfWeek]} · {fmtMin(template.startMinute)}–{fmtMin(template.endMinute)}
      </div>
      <div className="text-[10px] text-silver/60 truncate">
        {template.position}
        {template.clientName && ` · ${template.clientName}`}
      </div>
    </div>
  );
}
