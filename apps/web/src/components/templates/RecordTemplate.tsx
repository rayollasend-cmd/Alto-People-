import * as React from 'react';
import { cn } from '@/lib/cn';
import { Breadcrumb, type BreadcrumbSegment } from '@/components/ui/Breadcrumb';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useHeroObserver, usePublishPageTitle } from '@/lib/pageTitle';

/**
 * Record — one thing (design system §4.3): a person, an agent, a site, a
 * client, a payroll run. The header names it (identity, title, status),
 * carries its actions, then tabs hold its facets and an optional aside
 * holds its timeline. The tabs are the same component everywhere, so a
 * person's "Employment" and an agent's "Compliance record" read alike.
 *
 *   <RecordTemplate breadcrumbs={…} identity={<Avatar …/>} title={name}
 *     subtitle="Associate · Coastal Resort" status={<Badge variant="success">Active</Badge>}
 *     actions={<Button>Edit</Button>}
 *     tabs={[{ key: 'overview', label: 'Overview', content: … }, …]}
 *     aside={<Timeline />} />
 */
export interface RecordTab {
  key: string;
  label: React.ReactNode;
  count?: number;
  content: React.ReactNode;
}

export interface RecordTemplateProps {
  breadcrumbs?: BreadcrumbSegment[];
  /** An avatar or type mark to the left of the title. */
  identity?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  /** Status badges, right of the title. */
  status?: React.ReactNode;
  actions?: React.ReactNode;
  /** Numbers that describe the record at a glance (a KPI strip). */
  summary?: React.ReactNode;
  tabs: RecordTab[];
  activeTab?: string;
  onTabChange?: (key: string) => void;
  /** The timeline or related items, beside the tabs on wide screens. */
  aside?: React.ReactNode;
  className?: string;
}

export function RecordTemplate({ breadcrumbs, identity, title, subtitle, status, actions, summary, tabs, activeTab, onTabChange, aside, className }: RecordTemplateProps) {
  usePublishPageTitle(title, breadcrumbs ?? null);
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
  return (
    <div className={cn('space-y-[var(--d-stack-lg)]', className)} data-template="record">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <div className="hidden md:block">
          <Breadcrumb segments={breadcrumbs} />
        </div>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          {identity && <div className="shrink-0">{identity}</div>}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 ref={heroRef} className="font-display text-hero leading-[1.1] tracking-tight text-ink">{title}</h1>
              {status}
            </div>
            {subtitle && <p className="mt-1 text-sm text-ink-muted md:text-base">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
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
