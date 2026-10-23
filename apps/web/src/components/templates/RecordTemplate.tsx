import * as React from 'react';
import { cn } from '@/lib/cn';
import { Breadcrumb, headerCrumbs, type BreadcrumbSegment } from '@/components/ui/Breadcrumb';
import { HeaderActions, HeaderFacts, RelatedLinks, isPageActions, type PageAction, type PageFact, type RelatedLink } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useResolvedCrumbs } from '@/lib/navTrail';
import { useHeroObserver, usePublishPageTitle } from '@/lib/pageTitle';

/**
 * Record — one thing (design system §4.3): a person, an agent, a site, a
 * client, a payroll run. The header names it (identity, title, status),
 * gives its key facts, carries its actions, then tabs hold its facets and
 * an optional aside holds its timeline. The tabs are the same component
 * everywhere, so a person's "Employment" and an agent's "Compliance
 * record" read alike.
 *
 *   <RecordTemplate breadcrumbs={…} identity={<Avatar …/>} title={name}
 *     subtitle="Associate · Coastal Resort" status={<Badge variant="success">Active</Badge>}
 *     facts={[{ label: 'Hired', value: 'Mar 3, 2025' }, { label: 'Hours this week', value: '32.5', to: '/time-attendance?…' }]}
 *     actions={[{ label: 'Edit', primary: true, onSelect: edit }, { label: 'Suspend', destructive: true, confirm: { title: 'Suspend Maria?' }, onSelect: suspend }]}
 *     tabs={[{ key: 'overview', label: 'Overview', content: … }, …]}
 *     aside={<Timeline />} />
 *
 * `actions` takes the same list PageHeader does (one primary, two beside
 * it, the rest and every destructive action in "More"); a React node still
 * works for a record not yet moved over.
 */
export interface RecordTab {
  key: string;
  label: React.ReactNode;
  count?: number;
  content: React.ReactNode;
}

export interface RecordTemplateProps {
  /** Leave out for the nav's trail; `[]` for none. */
  breadcrumbs?: BreadcrumbSegment[];
  /** An avatar or type mark to the left of the title. */
  identity?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  /** Status badges, right of the title. */
  status?: React.ReactNode;
  /** The record's actions: the PageHeader list, or (legacy) nodes. */
  actions?: PageAction[] | React.ReactNode;
  /** The key facts under the title. */
  facts?: PageFact[];
  /** Related pages, as links. */
  related?: RelatedLink[];
  /** Numbers that describe the record at a glance (a KPI strip). */
  summary?: React.ReactNode;
  tabs: RecordTab[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  /** The timeline or related items, beside the tabs on wide screens. */
  aside?: React.ReactNode;
  className?: string;
}

export function RecordTemplate({ breadcrumbs, identity, title, subtitle, status, actions, facts, related, summary, tabs, activeTab, onTabChange, aside, className }: RecordTemplateProps) {
  const crumbs = useResolvedCrumbs(breadcrumbs, title);
  usePublishPageTitle(title, crumbs);
  const trail = headerCrumbs(crumbs, title);
  // The page names itself here, so the top bar's compact title waits until
  // this heading has scrolled under it — one trail on screen, never two.
  const heroRef = React.useRef<HTMLHeadingElement>(null);
  useHeroObserver(heroRef);
  const [internal, setInternal] = React.useState(tabs[0]?.key ?? '');
  const current = activeTab ?? internal;
  const change = (k: string) => {
    setInternal(k);
    onTabChange?.(k);
  };
  const structured = isPageActions(actions) ? actions : undefined;
  const legacy = structured ? undefined : (actions as React.ReactNode);
  return (
    <div className={cn('space-y-[var(--d-stack-lg)]', className)} data-template="record">
      {trail && (
        <div className="hidden md:block">
          <Breadcrumb segments={trail.segments} current={trail.current} />
        </div>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        {/* A readable minimum, as PageHeader keeps (not min-w-0): on a phone
            the actions beside a long title squeezed it to four lines and its
            facts to "Shell …"; with a floor the actions wrap below instead. */}
        <div className="flex min-w-[min(16rem,100%)] flex-1 items-start gap-4">
          {identity && <div className="shrink-0">{identity}</div>}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 ref={heroRef} className="font-display text-hero leading-[1.1] tracking-tight text-ink">{title}</h1>
              {status}
            </div>
            {subtitle && <p className="mt-1 text-sm text-ink-muted md:text-base">{subtitle}</p>}
            <HeaderFacts facts={facts} />
            <RelatedLinks links={related} />
          </div>
        </div>
        {(structured || legacy) && (
          <HeaderActions
            actions={structured}
            // A legacy node row stays one group, as it always was: the record
            // decides its own order.
            primaryAction={legacy}
          />
        )}
      </header>
      {summary}
      <div className={cn('grid gap-6', aside ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : '')}>
        <Tabs value={current} onValueChange={change} className="min-w-0">
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
                {t.count !== undefined && <span className="ml-1.5 text-xs tabular-nums text-ink-muted">({t.count})</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.key} value={t.key} className="mt-4">
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
        {aside && <aside className="min-w-0">{aside}</aside>}
      </div>
    </div>
  );
}
