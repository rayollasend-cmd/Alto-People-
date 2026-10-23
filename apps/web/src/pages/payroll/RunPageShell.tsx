import { ListTemplate, type ListTemplateProps } from '@/components/templates';
import { HeaderActions } from '@/components/ui/PageHeader';

/**
 * A run's sub-page — the review report, the guided close, the paper checks,
 * the paycheck confirmations — as a page of its own, or as a tab of the run
 * record (/payroll/runs/:id/:tab, F500 G3: "a run lives in four places").
 *
 * Standalone it is the List template. Embedded, the run record draws the
 * header (the run's title, status, key facts and next step), so this draws
 * only the page's own actions as a row at the top of the tab, then its
 * summary, filters and body: one implementation of each page either way.
 */
export function RunPageShell({ embedded = false, ...props }: ListTemplateProps & { embedded?: boolean }) {
  if (!embedded) return <ListTemplate {...props} />;
  const hasActions = (props.actions?.length ?? 0) > 0 || !!props.primaryAction || !!props.secondaryActions;
  return (
    <div className="space-y-[var(--d-stack)]" data-run-tab="">
      {hasActions && (
        <div className="no-print flex justify-end">
          <HeaderActions actions={props.actions} primaryAction={props.primaryAction} secondaryActions={props.secondaryActions} />
        </div>
      )}
      {props.summary}
      {props.filters}
      {props.children}
      {props.drawer}
    </div>
  );
}

/** Embedded or not: what a run sub-page needs to know. */
export interface RunSubPageProps {
  /** The run (from the record); omitted, the page reads it from the URL. */
  runId?: string;
  /** Drawn inside the run record: no page header of its own. */
  embedded?: boolean;
}

